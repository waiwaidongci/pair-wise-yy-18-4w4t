const express = require('express');
const { randomUUID } = require('crypto');
const config = require('../project.config');
const {
  sqlValue,
  now,
  runSql,
  select,
  transaction,
  findCollection,
  titleFor,
  validate,
  insertEvent,
  loadRecord,
  saveRecord,
  applyQuery
} = require('./db');
const occupancy = require('./occupancy');
const linkage = require('./linkage');
const idempotency = require('./idempotency');

const router = express.Router();

// 从装箱单数据中解析出占用物品清单（偶头 + 配件）。
function extractBoxItems(data) {
  const items = [];
  for (const itemId of data.headIds || []) {
    items.push({ itemType: 'puppetHeads', itemId });
  }
  for (const itemId of data.accessoryIds || []) {
    items.push({ itemType: 'accessories', itemId });
  }
  return items;
}

// 幂等重放：若该请求编号已成功处理，返回原结果。
function replayIfIdempotent(req, res) {
  const requestId = idempotency.getRequestId(req);
  if (!requestId) return null;
  const existing = idempotency.findIdempotency(requestId);
  if (!existing) return null;
  res.status(existing.status_code).json(JSON.parse(existing.response));
  return true;
}

router.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: config.port });
});

router.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

router.get('/api/:collection', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const rows = select(
      'SELECT * FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' ORDER BY updated_at DESC;'
    ).map((row) => loadRecord(req.params.collection, row.id));
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

router.post('/api/:collection', (req, res, next) => {
  try {
    if (replayIfIdempotent(req, res)) return;
    const collectionConfig = findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);

    const id = randomUUID();
    const createdAt = now();

    // 装箱单：占用判定（冲突整批不保存）。
    if (req.params.collection === 'tourBoxes') {
      const items = extractBoxItems(data);
      const conflict = occupancy.checkOccupancy(id, items);
      if (conflict) {
        return res.status(409).json({
          error: occupancy.conflictMessage(conflict),
          code: 'OCCUPANCY_CONFLICT',
          conflict
        });
      }
    }

    const requestId = idempotency.getRequestId(req);

    transaction(() => {
      runSql(
        'INSERT INTO records (id, collection, status, title, data, created_at, updated_at, version) VALUES (' +
        [
          sqlValue(id),
          sqlValue(req.params.collection),
          sqlValue(status),
          sqlValue(titleFor(collectionConfig, data)),
          sqlValue(JSON.stringify(data)),
          sqlValue(createdAt),
          sqlValue(createdAt),
          '1'
        ].join(', ') +
        ');'
      );

      if (req.params.collection === 'tourBoxes') {
        occupancy.reserve(id, extractBoxItems(data), requestId);
      }

      if (req.params.collection === 'repairRecords') {
        linkage.onRepairRecordCreated({ ...data, id });
      }

      insertEvent({
        recordId: id,
        collection: req.params.collection,
        action: req.body.action || '创建',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data
      });

      if (requestId) {
        idempotency.storeIdempotency(requestId, id, req.params.collection, 201, loadRecord(req.params.collection, id));
      }
    });

    res.status(201).json(loadRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

router.get('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

router.patch('/api/:collection/:id', (req, res, next) => {
  try {
    if (replayIfIdempotent(req, res)) return;
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });

    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    delete nextData.version;
    const status = nextData.status || record.status;
    nextData.status = status;

    const expectedVersion = req.body.expectedVersion;
    if (expectedVersion !== undefined && record.version !== expectedVersion) {
      return res.status(409).json({
        error: '版本冲突：记录已被其他终端修改，请刷新后重试',
        code: 'VERSION_CONFLICT'
      });
    }

    // 装箱单：闭环前检查缺损追踪；调整前做占用判定。
    if (req.params.collection === 'tourBoxes') {
      if (status === '已闭环') {
        const closeCheck = linkage.checkCloseable(req.params.id);
        if (!closeCheck.ok) {
          return res.status(409).json({
            error: linkage.closeBlockedMessage(req.params.id, closeCheck.unresolved),
            code: 'LOSS_UNRESOLVED',
            unresolved: closeCheck.unresolved.map((row) => JSON.parse(row.data || '{}'))
          });
        }
      } else {
        const items = extractBoxItems(nextData);
        const conflict = occupancy.checkOccupancy(req.params.id, items);
        if (conflict) {
          return res.status(409).json({
            error: occupancy.conflictMessage(conflict),
            code: 'OCCUPANCY_CONFLICT',
            conflict
          });
        }
      }
    }

    const requestId = idempotency.getRequestId(req);

    transaction(() => {
      saveRecord(req.params.collection, req.params.id, nextData, status, expectedVersion);

      if (req.params.collection === 'tourBoxes') {
        if (status === '已闭环') {
          occupancy.release(req.params.id);
        } else {
          occupancy.reconcile(req.params.id, extractBoxItems(nextData), requestId);
        }
      }

      insertEvent({
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || '更新',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });

      if (requestId) {
        idempotency.storeIdempotency(requestId, req.params.id, req.params.collection, 200, loadRecord(req.params.collection, req.params.id));
      }
    });

    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

router.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    if (replayIfIdempotent(req, res)) return;
    const collectionConfig = findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    delete nextData.version;

    const expectedVersion = req.body.expectedVersion;
    if (expectedVersion !== undefined && record.version !== expectedVersion) {
      return res.status(409).json({
        error: '版本冲突：记录已被其他终端修改，请刷新后重试',
        code: 'VERSION_CONFLICT'
      });
    }

    if (req.params.collection === 'tourBoxes') {
      if (status === '已闭环') {
        const closeCheck = linkage.checkCloseable(req.params.id);
        if (!closeCheck.ok) {
          return res.status(409).json({
            error: linkage.closeBlockedMessage(req.params.id, closeCheck.unresolved),
            code: 'LOSS_UNRESOLVED',
            unresolved: closeCheck.unresolved.map((row) => JSON.parse(row.data || '{}'))
          });
        }
      } else {
        const items = extractBoxItems(nextData);
        const conflict = occupancy.checkOccupancy(req.params.id, items);
        if (conflict) {
          return res.status(409).json({
            error: occupancy.conflictMessage(conflict),
            code: 'OCCUPANCY_CONFLICT',
            conflict
          });
        }
      }
    }

    const requestId = idempotency.getRequestId(req);

    transaction(() => {
      saveRecord(req.params.collection, req.params.id, nextData, status, expectedVersion);

      if (req.params.collection === 'tourBoxes') {
        if (status === '已闭环') {
          occupancy.release(req.params.id);
        } else {
          occupancy.reconcile(req.params.id, extractBoxItems(nextData), requestId);
        }
      }

      insertEvent({
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || status || '记录',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });

      if (requestId) {
        idempotency.storeIdempotency(requestId, req.params.id, req.params.collection, 200, loadRecord(req.params.collection, req.params.id));
      }
    });

    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

router.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = select(
      'SELECT * FROM events WHERE record_id = ' + sqlValue(req.params.id) + ' ORDER BY created_at ASC;'
    ).map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
    res.json({ record, events });
  } catch (error) {
    next(error);
  }
});

router.delete('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    transaction(() => {
      if (req.params.collection === 'tourBoxes') {
        occupancy.release(req.params.id);
      }
      runSql('DELETE FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' AND id = ' + sqlValue(req.params.id) + ';');
      runSql('DELETE FROM events WHERE record_id = ' + sqlValue(req.params.id) + ';');
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message || 'server error' });
});

module.exports = router;
