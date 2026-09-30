const { select, runSql, sqlValue, now, loadRecord, saveRecord, insertEvent } = require('./db');

// 档案联动：不同业务档案之间的状态联动。
// - 修补记录开立：关联箱子退回返场清点，偶头转为待修补。
// - 缺损追踪未处理完：箱子不能闭环。

function touchRecord(collection, id, updater, note) {
  const record = loadRecord(collection, id);
  if (!record) return null;
  const nextData = { ...record };
  delete nextData.id;
  delete nextData.collection;
  delete nextData.createdAt;
  delete nextData.updatedAt;
  delete nextData.version;
  return { record, nextData };
}

// 修补记录开立后的联动：
// 1. 占用该偶头的进行中装箱单退回返场清点。
// 2. 偶头档案转为待修补。
function onRepairRecordCreated(repairRecord) {
  const headId = repairRecord.puppetHeadId;
  if (!headId) return;

  const claims = select(
    'SELECT DISTINCT box_id FROM occupancy WHERE item_type = ' + sqlValue('puppetHeads') +
    ' AND item_id = ' + sqlValue(headId) + ';'
  );
  for (const claim of claims) {
    const box = loadRecord('tourBoxes', claim.box_id);
    if (!box) continue;
    if (box.status === '已闭环' || box.status === '返场清点中') continue;
    const touched = touchRecord('tourBoxes', box.id);
    if (!touched) continue;
    touched.nextData.status = '返场清点中';
    saveRecord('tourBoxes', box.id, touched.nextData, '返场清点中');
    insertEvent({
      recordId: box.id,
      collection: 'tourBoxes',
      action: '修补联动',
      status: '返场清点中',
      actor: 'system',
      note: '修补记录 ' + repairRecord.id + ' 开立，关联箱子退回返场清点',
      data: { repairRecordId: repairRecord.id, puppetHeadId: headId }
    });
  }

  const head = loadRecord('puppetHeads', headId);
  if (head && head.status !== '待修补' && head.status !== '修补中') {
    const touched = touchRecord('puppetHeads', headId);
    if (touched) {
      touched.nextData.status = '待修补';
      saveRecord('puppetHeads', headId, touched.nextData, '待修补');
      insertEvent({
        recordId: headId,
        collection: 'puppetHeads',
        action: '修补联动',
        status: '待修补',
        actor: 'system',
        note: '修补记录 ' + repairRecord.id + ' 开立，偶头待修补',
        data: { repairRecordId: repairRecord.id }
      });
    }
  }
}

// 箱子闭环前检查：存在未处理完的缺损追踪则不允许闭环。
// 返回 { ok: true } 或 { ok: false, unresolved }。
function checkCloseable(boxId) {
  const unresolved = select(
    "SELECT * FROM records WHERE collection = 'lossReports'" +
    " AND status NOT IN ('已补齐', '确认为遗失')" +
    ' AND json_extract(data, \'$.tourBoxId\') = ' + sqlValue(boxId) + ';'
  );
  if (unresolved.length) {
    return { ok: false, unresolved };
  }
  return { ok: true, unresolved: [] };
}

function closeBlockedMessage(boxId, unresolved) {
  const box = loadRecord('tourBoxes', boxId);
  const boxLabel = box ? (box.title || box.showName || boxId) : boxId;
  const items = unresolved.map((row) => {
    const data = JSON.parse(row.data || '{}');
    return data.itemName || data.problem || row.id;
  });
  return '装箱单 ' + boxLabel + ' 存在未处理完的缺损追踪（' + items.join('、') + '），不能闭环';
}

module.exports = {
  onRepairRecordCreated,
  checkCloseable,
  closeBlockedMessage
};
