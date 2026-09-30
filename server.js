// 请求入口：HTTP 路由、请求编号幂等、版本并发控制。
// 占用判定见 occupancy.js，档案联动见 linkage.js，数据层见 db.js。
const express = require('express');
const { randomUUID } = require('crypto');
const config = require('./project.config');
const db = require('./db');
const occupancy = require('./occupancy');
const linkage = require('./linkage');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

db.initDb();
const backfill = occupancy.backfillOccupancy();
if (backfill.boxes || backfill.claimed || backfill.conflicts.length) {
  console.log(
    '占用回填：补登箱子 ' +
      backfill.boxes +
      ' 份，登记占用 ' +
      backfill.claimed +
      ' 项，冲突待核对 ' +
      backfill.conflicts.length +
      ' 项'
  );
}

// 请求体里的控制字段，不进业务数据
const CONTROL_FIELDS = ['requestId', 'version'];

function requestData(req) {
  const data = { ...req.body };
  for (const field of CONTROL_FIELDS) delete data[field];
  return data;
}

function requestIdOf(req) {
  return req.get('x-request-id') || (req.body && req.body.requestId) || null;
}

// 写入失败可凭原请求编号重试：已成功的请求直接回放首次结果，不重复占用或追加事件
function runIdempotent(req, res, build) {
  const requestId = requestIdOf(req);
  if (requestId) {
    const stored = db.findRequest(requestId);
    if (stored) {
      if (stored.method !== req.method || stored.path !== req.originalUrl) {
        return res.status(409).json({ error: '请求编号已被其他请求使用：' + requestId });
      }
      if (stored.response_status === 204) return res.status(204).end();
      return res.status(stored.response_status).json(JSON.parse(stored.response_body));
    }
  }
  const result = build(requestId);
  const stmts = [...(result.stmts || [])];
  if (requestId && result.status < 400) {
    stmts.push(
      db.storeRequestStmt({
        requestId,
        method: req.method,
        path: req.originalUrl,
        responseStatus: result.status,
        responseBody: JSON.stringify(result.body === undefined ? null : result.body)
      })
    );
  }
  if (stmts.length) db.runTx(stmts);
  if (result.status === 204) return res.status(204).end();
  res.status(result.status).json(result.body);
}

// 版本并发控制：两个终端同时提交同一箱子，只接受先到的一方，后到的看到版本冲突
function expectVersion(req, record, { required } = {}) {
  const provided = req.body ? req.body.version : undefined;
  if (provided === undefined || provided === null || provided === '') {
    if (required) {
      const error = new Error(
        '装箱单登记/调整需携带记录当前 version，以防并发覆盖（当前版本 ' + record.version + '）'
      );
      error.status = 400;
      throw error;
    }
    return null;
  }
  if (Number(provided) !== record.version) {
    const error = new Error(
      '版本冲突：提交基于版本 ' + provided + '，当前已是 ' + record.version + '，请重新读取后再提交'
    );
    error.status = 409;
    error.currentVersion = record.version;
    throw error;
  }
  return Number(provided);
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

// 占用关系查询（含待核对清单），须注册在 /api/:collection 之前
app.get('/api/occupancy', (req, res, next) => {
  try {
    res.json(occupancy.listOccupancy(req.query));
  } catch (error) {
    next(error);
  }
});

// 核对升级回填留下的待核对占用：decision 为 生效中 或 已释放
app.post('/api/occupancy/:id/resolve', (req, res, next) => {
  try {
    runIdempotent(req, res, () => {
      const rows = db.select(
        'SELECT * FROM occupancy WHERE id = ' + db.sqlValue(req.params.id) + ' LIMIT 1;'
      );
      const row = rows[0];
      if (!row) return { status: 404, body: { error: 'not found' }, stmts: [] };
      const decision = req.body && req.body.decision;
      if (!['生效中', '已释放'].includes(decision)) {
        return { status: 400, body: { error: 'decision 需为 生效中 或 已释放' }, stmts: [] };
      }
      if (row.state !== '待核对') {
        return {
          status: 409,
          body: { error: '仅待核对的占用可以核对，当前状态：' + row.state },
          stmts: []
        };
      }
      const stmts = occupancy.resolveStmts(row, decision, {
        actor: req.body.actor,
        note: req.body.note
      });
      return { status: 200, body: { id: row.id, state: decision }, stmts };
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const rows = db
      .select(
        'SELECT * FROM records WHERE collection = ' +
          db.sqlValue(req.params.collection) +
          ' ORDER BY updated_at DESC;'
      )
      .map(db.toRecord);
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  try {
    const collection = req.params.collection;
    const collectionConfig = db.findCollection(collection);
    runIdempotent(req, res, (requestId) => {
      const data = { ...collectionConfig.defaults, ...requestData(req) };
      const status = data.status || collectionConfig.defaultStatus || '';
      data.status = status;
      db.validate(collectionConfig, data);
      const id = randomUUID();
      const createdAt = db.now();
      const record = { id, collection, status, ...data };
      const stmts = [db.insertRecordStmt({ collection, id, status, data, createdAt })];
      if (collection === 'tourBoxes') {
        if (status === occupancy.BOX_CLOSED_STATUS) linkage.assertBoxClosable(record);
        stmts.push(...occupancy.syncBoxStmts(record, { requestId }).stmts);
      }
      stmts.push(
        db.insertEventStmt({
          recordId: id,
          collection,
          action: req.body.action || '创建',
          status,
          actor: req.body.actor || '',
          note: req.body.note || '',
          data: requestId ? { ...data, requestId } : data
        })
      );
      if (collection === 'repairRecords') {
        stmts.push(...linkage.repairOpenedStmts(record, { actor: req.body.actor }).stmts);
      }
      return {
        status: 201,
        body: { id, collection, status, createdAt, updatedAt: createdAt, ...data, version: 1 },
        stmts
      };
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const record = db.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    const collection = req.params.collection;
    db.findCollection(collection);
    runIdempotent(req, res, (requestId) => {
      const record = db.loadRecord(collection, req.params.id);
      if (!record) return { status: 404, body: { error: 'not found' }, stmts: [] };
      const expectedVersion = expectVersion(req, record, {
        required: collection === 'tourBoxes'
      });
      const nextData = { ...db.recordData(record), ...requestData(req) };
      const status = nextData.status || record.status;
      nextData.status = status;
      const nextRecord = { id: record.id, collection, status, ...nextData };
      const stmts = [];
      if (collection === 'tourBoxes') {
        if (status === occupancy.BOX_CLOSED_STATUS) linkage.assertBoxClosable(nextRecord);
        stmts.push(...occupancy.syncBoxStmts(nextRecord, { requestId }).stmts);
      }
      const updatedAt = db.now();
      stmts.push(
        db.updateRecordStmt({
          collection,
          id: record.id,
          data: nextData,
          status,
          expectedVersion,
          updatedAt
        })
      );
      if (expectedVersion !== null) stmts.push(db.VERSION_GUARD_STMT);
      stmts.push(
        db.insertEventStmt({
          recordId: record.id,
          collection,
          action: req.body.action || '更新',
          status,
          actor: req.body.actor || '',
          note: req.body.note || '',
          data: req.body
        })
      );
      return {
        status: 200,
        body: {
          id: record.id,
          collection,
          status,
          createdAt: record.createdAt,
          updatedAt,
          ...nextData,
          version: record.version + 1
        },
        stmts
      };
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    const collection = req.params.collection;
    const collectionConfig = db.findCollection(collection);
    runIdempotent(req, res, (requestId) => {
      const record = db.loadRecord(collection, req.params.id);
      if (!record) return { status: 404, body: { error: 'not found' }, stmts: [] };
      const expectedVersion = expectVersion(req, record, {
        required: collection === 'tourBoxes'
      });
      const status = req.body.status || record.status;
      if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
        return { status: 400, body: { error: 'invalid status: ' + status }, stmts: [] };
      }
      const fields = { ...(req.body.fields || {}) };
      for (const field of CONTROL_FIELDS) delete fields[field];
      const nextData = { ...db.recordData(record), ...fields, status };
      const nextRecord = { id: record.id, collection, status, ...nextData };
      const stmts = [];
      if (collection === 'tourBoxes') {
        if (status === occupancy.BOX_CLOSED_STATUS) linkage.assertBoxClosable(nextRecord);
        stmts.push(...occupancy.syncBoxStmts(nextRecord, { requestId }).stmts);
      }
      const updatedAt = db.now();
      stmts.push(
        db.updateRecordStmt({
          collection,
          id: record.id,
          data: nextData,
          status,
          expectedVersion,
          updatedAt
        })
      );
      if (expectedVersion !== null) stmts.push(db.VERSION_GUARD_STMT);
      stmts.push(
        db.insertEventStmt({
          recordId: record.id,
          collection,
          action: req.body.action || status || '记录',
          status,
          actor: req.body.actor || '',
          note: req.body.note || '',
          data: req.body
        })
      );
      return {
        status: 200,
        body: {
          id: record.id,
          collection,
          status,
          createdAt: record.createdAt,
          updatedAt,
          ...nextData,
          version: record.version + 1
        },
        stmts
      };
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const record = db.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = db
      .select(
        'SELECT * FROM events WHERE record_id = ' +
          db.sqlValue(req.params.id) +
          ' ORDER BY created_at ASC;'
      )
      .map((event) => ({
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

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    const collection = req.params.collection;
    db.findCollection(collection);
    runIdempotent(req, res, () => {
      const record = db.loadRecord(collection, req.params.id);
      if (!record) return { status: 404, body: { error: 'not found' }, stmts: [] };
      const stmts = [];
      if (collection === 'tourBoxes') stmts.push(...occupancy.releaseBoxStmts(record.id));
      stmts.push(db.deleteRecordStmt(collection, record.id));
      stmts.push(db.deleteEventsStmt(record.id));
      return { status: 204, stmts };
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  // 版本守卫兜底：并发下先到的已提交，后到的整批回滚
  if (error.message && error.message.includes('CHECK constraint failed')) {
    return res
      .status(409)
      .json({ error: '版本冲突：记录已被他人更新，请重新读取后再提交' });
  }
  const body = { error: error.message || 'server error' };
  if (error.conflicts) body.conflicts = error.conflicts;
  if (error.openLossReports) body.openLossReports = error.openLossReports;
  if (error.currentVersion !== undefined) body.currentVersion = error.currentVersion;
  res.status(error.status || 500).json(body);
});

app.listen(PORT, () => {
  console.log(config.title + ' API running at http://localhost:' + PORT);
});
