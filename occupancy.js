// 占用判定：装箱登记与调整共用同一份占用关系。
// 未闭环的装箱单占用其偶头/配件；冲突时整批不保存，并报出哪份箱子占着哪件物品。
const { randomUUID } = require('crypto');
const db = require('./db');

const ITEM_TYPE_LABELS = { puppetHeads: '偶头', accessories: '配件' };
const ACTIVE_STATES = ['生效中', '待核对'];
const BOX_CLOSED_STATUS = '已闭环';
const BACKFILL_REQUEST_ID = 'upgrade-backfill';

function keyOf(itemType, itemId) {
  return itemType + ':' + itemId;
}

// 装箱单上的物品清单（偶头 + 配件），去重
function boxItems(box) {
  const items = [];
  for (const id of box.headIds || []) items.push({ itemType: 'puppetHeads', itemId: String(id) });
  for (const id of box.accessoryIds || [])
    items.push({ itemType: 'accessories', itemId: String(id) });
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item.itemType, item.itemId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function itemLabel(itemType, itemId) {
  const label = ITEM_TYPE_LABELS[itemType] || itemType;
  const record = db.loadRecord(itemType, itemId);
  if (!record) return label + '(' + itemId + '，档案不存在)';
  const title = db.titleFor(db.findCollection(itemType), record);
  return label + '「' + (title || itemId) + '」(' + itemId + ')';
}

function boxLabel(boxId) {
  const box = db.loadRecord('tourBoxes', boxId);
  if (!box) return '装箱单(' + boxId + ')';
  const title = db.titleFor(db.findCollection('tourBoxes'), box);
  return '装箱单「' + (title || boxId) + '」(' + boxId + ')';
}

function activeRows(whereSql) {
  return db.select(
    "SELECT * FROM occupancy WHERE state IN ('生效中', '待核对')" +
      (whereSql ? ' AND ' + whereSql : '') +
      ';'
  );
}

function claimStmt(box, item, state, requestId, createdAt) {
  const id = randomUUID();
  return {
    id,
    stmt:
      'INSERT INTO occupancy (id, item_type, item_id, box_id, state, request_id, created_at, updated_at) VALUES (' +
      [
        db.sqlValue(id),
        db.sqlValue(item.itemType),
        db.sqlValue(item.itemId),
        db.sqlValue(box.id),
        db.sqlValue(state),
        db.sqlValue(requestId || null),
        db.sqlValue(createdAt),
        db.sqlValue(createdAt)
      ].join(', ') +
      ');'
  };
}

function stateStmt(row, state, updatedAt) {
  return (
    'UPDATE occupancy SET state = ' +
    db.sqlValue(state) +
    ', updated_at = ' +
    db.sqlValue(updatedAt) +
    ' WHERE id = ' +
    db.sqlValue(row.id) +
    ';'
  );
}

function releaseStmt(row, updatedAt) {
  return stateStmt(row, '已释放', updatedAt);
}

function conflictDetail(row) {
  return {
    itemType: row.item_type,
    itemId: row.item_id,
    itemLabel: itemLabel(row.item_type, row.item_id),
    boxId: row.box_id,
    boxLabel: boxLabel(row.box_id),
    state: row.state
  };
}

function conflictError(conflicts) {
  const error = new Error(
    '占用冲突，本批未保存：' +
      conflicts
        .map((c) => c.itemLabel + ' 正被 ' + c.boxLabel + ' 占用（' + c.state + '）')
        .join('；')
  );
  error.status = 409;
  error.conflicts = conflicts;
  return error;
}

// 登记/调整共用：把箱子的占用关系同步成当前物品清单。
// 只返回要执行的语句；发现别箱已占用时抛 409，调用方整批不保存。
function syncBoxStmts(box, { requestId } = {}) {
  const now = db.now();
  const current = activeRows('box_id = ' + db.sqlValue(box.id));
  const stmts = [];
  let released = 0;
  let claimed = 0;

  // 闭环即释放全部占用
  if (box.status === BOX_CLOSED_STATUS) {
    for (const row of current) {
      stmts.push(releaseStmt(row, now));
      released++;
    }
    return { stmts, claimed, released };
  }

  const desired = boxItems(box);
  const desiredKeys = new Set(desired.map((item) => keyOf(item.itemType, item.itemId)));
  const keptKeys = new Set(current.map((row) => keyOf(row.item_type, row.item_id)));

  for (const row of current) {
    if (!desiredKeys.has(keyOf(row.item_type, row.item_id))) {
      stmts.push(releaseStmt(row, now));
      released++;
    }
  }

  const toClaim = desired.filter((item) => !keptKeys.has(keyOf(item.itemType, item.itemId)));
  if (toClaim.length) {
    const claimKeys = new Set(toClaim.map((item) => keyOf(item.itemType, item.itemId)));
    const holders = activeRows().filter(
      (row) => row.box_id !== box.id && claimKeys.has(keyOf(row.item_type, row.item_id))
    );
    if (holders.length) throw conflictError(holders.map(conflictDetail));
    for (const item of toClaim) {
      stmts.push(claimStmt(box, item, '生效中', requestId, now).stmt);
      claimed++;
    }
  }
  return { stmts, claimed, released };
}

// 删除装箱单时释放其占用
function releaseBoxStmts(boxId) {
  const now = db.now();
  return activeRows('box_id = ' + db.sqlValue(boxId)).map((row) => releaseStmt(row, now));
}

// 升级回填：老箱子没有占用资料，按进行中的单子补登；冲突双方保留待核对
function backfillOccupancy() {
  const boxes = db
    .loadRecords('tourBoxes')
    .filter((box) => box.status !== BOX_CLOSED_STATUS)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const existing = db.select('SELECT * FROM occupancy;');
  const boxesWithRows = new Set(existing.map((row) => row.box_id));
  const activeByItem = new Map();
  for (const row of existing) {
    if (!ACTIVE_STATES.includes(row.state)) continue;
    const key = keyOf(row.item_type, row.item_id);
    if (!activeByItem.has(key)) activeByItem.set(key, []);
    activeByItem.get(key).push(row);
  }

  const stmts = [];
  const summary = { boxes: 0, claimed: 0, conflicts: [] };
  const now = db.now();

  for (const box of boxes) {
    if (boxesWithRows.has(box.id)) continue;
    const items = boxItems(box);
    if (!items.length) continue;
    const notes = [];
    for (const item of items) {
      const key = keyOf(item.itemType, item.itemId);
      const holders = activeByItem.get(key) || [];
      if (!holders.length) {
        const claim = claimStmt(box, item, '生效中', BACKFILL_REQUEST_ID, now);
        stmts.push(claim.stmt);
        activeByItem.set(key, [
          { id: claim.id, item_type: item.itemType, item_id: item.itemId, box_id: box.id, state: '生效中' }
        ]);
        summary.claimed++;
        continue;
      }
      // 冲突：已有占用与本次回填都保留为待核对
      for (const holder of holders) {
        if (holder.state === '生效中') {
          stmts.push(stateStmt(holder, '待核对', now));
          holder.state = '待核对';
        }
      }
      const claim = claimStmt(box, item, '待核对', BACKFILL_REQUEST_ID, now);
      stmts.push(claim.stmt);
      holders.push({
        id: claim.id,
        item_type: item.itemType,
        item_id: item.itemId,
        box_id: box.id,
        state: '待核对'
      });
      activeByItem.set(key, holders);
      const boxIds = [...new Set(holders.map((row) => row.box_id))];
      summary.conflicts.push({ itemType: item.itemType, itemId: item.itemId, boxIds });
      notes.push(itemLabel(item.itemType, item.itemId) + '（涉及 ' + boxIds.map(boxLabel).join('、') + '）');
    }
    stmts.push(
      db.insertEventStmt({
        recordId: box.id,
        collection: 'tourBoxes',
        action: '占用回填',
        status: box.status,
        actor: 'system',
        note: notes.length
          ? '升级回填发现占用冲突，双方保留待核对：' + notes.join('；')
          : '升级回填占用关系',
        data: { requestId: BACKFILL_REQUEST_ID, conflicts: notes }
      })
    );
    summary.boxes++;
  }

  if (stmts.length) db.runTx(stmts);
  return summary;
}

// 核对：把待核对的占用确认为生效中或已释放
function resolveStmts(row, decision, { actor, note } = {}) {
  const now = db.now();
  if (decision === '生效中') {
    const others = activeRows(
      'item_type = ' +
        db.sqlValue(row.item_type) +
        ' AND item_id = ' +
        db.sqlValue(row.item_id) +
        ' AND id != ' +
        db.sqlValue(row.id) +
        " AND state = '生效中'"
    );
    if (others.length) throw conflictError(others.map(conflictDetail));
  }
  return [
    stateStmt(row, decision, now),
    db.insertEventStmt({
      recordId: row.box_id,
      collection: 'tourBoxes',
      action: '占用核对',
      status: '',
      actor: actor || '',
      note: note || '占用 ' + row.item_type + '/' + row.item_id + ' 核对为 ' + decision,
      data: { occupancyId: row.id, decision }
    })
  ];
}

function listOccupancy(query = {}) {
  let rows = db.select('SELECT * FROM occupancy ORDER BY created_at ASC;');
  if (query.state) rows = rows.filter((row) => row.state === query.state);
  if (query.boxId) rows = rows.filter((row) => row.box_id === query.boxId);
  if (query.itemId) rows = rows.filter((row) => row.item_id === query.itemId);
  return rows.map((row) => ({
    id: row.id,
    itemType: row.item_type,
    itemId: row.item_id,
    itemLabel: itemLabel(row.item_type, row.item_id),
    boxId: row.box_id,
    boxLabel: boxLabel(row.box_id),
    state: row.state,
    requestId: row.request_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

module.exports = {
  ACTIVE_STATES,
  BOX_CLOSED_STATUS,
  boxItems,
  syncBoxStmts,
  releaseBoxStmts,
  backfillOccupancy,
  resolveStmts,
  listOccupancy
};
