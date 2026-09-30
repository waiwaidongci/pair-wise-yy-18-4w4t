// 档案联动：修补记录、缺损追踪牵动偶头档案与装箱单。
const db = require('./db');

// 修补一开，在途（已装箱/巡演中）的关联箱子退回返场清点
const BOX_RETURN_STATUSES = ['已装箱', '巡演中'];
// 缺损追踪处于这些状态时视为未处理完，箱子不能闭环
const OPEN_LOSS_STATUSES = ['待处理', '修复中'];

// 修补记录一开：关联偶头转入修补中，装着它的在途箱子退回返场清点
function repairOpenedStmts(repair, { actor } = {}) {
  const head = db.loadRecord('puppetHeads', repair.puppetHeadId);
  if (!head) {
    const error = new Error('修补记录关联的偶头档案不存在：' + repair.puppetHeadId);
    error.status = 400;
    throw error;
  }
  const now = db.now();
  const stmts = [];
  const returnedBoxIds = [];

  if (head.status !== '修补中') {
    const headData = { ...db.recordData(head), status: '修补中' };
    stmts.push(
      db.updateRecordStmt({
        collection: 'puppetHeads',
        id: head.id,
        data: headData,
        status: '修补中',
        updatedAt: now
      })
    );
    stmts.push(
      db.insertEventStmt({
        recordId: head.id,
        collection: 'puppetHeads',
        action: '修补联动',
        status: '修补中',
        actor: actor || '',
        note: '修补记录 ' + repair.id + ' 开立，转入修补中',
        data: { repairRecordId: repair.id }
      })
    );
  }

  const boxes = db
    .loadRecords('tourBoxes')
    .filter(
      (box) => BOX_RETURN_STATUSES.includes(box.status) && (box.headIds || []).includes(head.id)
    );
  for (const box of boxes) {
    const boxData = { ...db.recordData(box), status: '返场清点中' };
    stmts.push(
      db.updateRecordStmt({
        collection: 'tourBoxes',
        id: box.id,
        data: boxData,
        status: '返场清点中',
        updatedAt: now
      })
    );
    stmts.push(
      db.insertEventStmt({
        recordId: box.id,
        collection: 'tourBoxes',
        action: '修补联动',
        status: '返场清点中',
        actor: actor || '',
        note: '偶头送修（修补记录 ' + repair.id + '），箱子退回返场清点',
        data: { repairRecordId: repair.id, puppetHeadId: head.id }
      })
    );
    returnedBoxIds.push(box.id);
  }
  return { stmts, returnedBoxIds };
}

// 缺损追踪没处理完，箱子不能闭环
function assertBoxClosable(box) {
  const open = db
    .loadRecords('lossReports')
    .filter((report) => report.tourBoxId === box.id && OPEN_LOSS_STATUSES.includes(report.status));
  if (!open.length) return;
  const error = new Error(
    '缺损追踪未处理完，箱子不能闭环：' +
      open.map((report) => '「' + (report.itemName || report.id) + '」' + report.status).join('；')
  );
  error.status = 409;
  error.openLossReports = open.map((report) => ({
    id: report.id,
    itemName: report.itemName,
    problem: report.problem,
    status: report.status
  }));
  throw error;
}

module.exports = { repairOpenedStmts, assertBoxClosable, OPEN_LOSS_STATUSES };
