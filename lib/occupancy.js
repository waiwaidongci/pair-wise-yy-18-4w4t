const { randomUUID } = require('crypto');
const { select, runSql, sqlValue, now, loadRecord } = require('./db');

// 占用判定：装箱登记与调整共用同一份占用关系。
// 一件偶头或配件在同一时刻只能被一份未结束的装箱单占用。

function claimsForItem(itemType, itemId) {
  return select(
    'SELECT * FROM occupancy WHERE item_type = ' + sqlValue(itemType) +
    ' AND item_id = ' + sqlValue(itemId) + ';'
  );
}

function claimsForBox(boxId) {
  return select(
    'SELECT * FROM occupancy WHERE box_id = ' + sqlValue(boxId) + ';'
  );
}

function insertClaim(boxId, itemType, itemId, status, requestId) {
  runSql(
    'INSERT INTO occupancy (id, item_type, item_id, box_id, request_id, status, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(itemType),
      sqlValue(itemId),
      sqlValue(boxId),
      sqlValue(requestId || ''),
      sqlValue(status),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

function conflictMessage(conflict) {
  const itemRecord = loadRecord(conflict.itemType, conflict.itemId);
  const itemLabel = itemRecord
    ? (itemRecord.title || itemRecord.name || itemRecord.role || conflict.itemId)
    : conflict.itemId;
  const boxRecord = loadRecord('tourBoxes', conflict.occupiedByBox);
  const boxLabel = boxRecord
    ? (boxRecord.title || boxRecord.showName || conflict.occupiedByBox)
    : conflict.occupiedByBox;
  return '物品 ' + conflict.itemType + '/' + itemLabel +
    ' 已被装箱单 ' + boxLabel +
    ' 占用（占用状态：' + conflict.claimStatus + '），无法重复装箱';
}

// 检查一批物品是否可被某装箱单占用。
// 返回 null 表示可用；返回冲突信息表示已被其他装箱单占用。
function checkOccupancy(boxId, items) {
  for (const { itemType, itemId } of items) {
    const claims = claimsForItem(itemType, itemId);
    for (const claim of claims) {
      if (claim.box_id !== boxId) {
        return {
          itemType,
          itemId,
          occupiedByBox: claim.box_id,
          claimStatus: claim.status
        };
      }
    }
  }
  return null;
}

// 占用一批物品（登记新占用）。调用前需先通过 checkOccupancy。
function reserve(boxId, items, requestId) {
  for (const { itemType, itemId } of items) {
    insertClaim(boxId, itemType, itemId, '占用中', requestId);
  }
}

// 释放某装箱单的全部占用（闭环或删除时）。
function release(boxId) {
  runSql('DELETE FROM occupancy WHERE box_id = ' + sqlValue(boxId) + ';');
}

// 调整装箱单：把占用关系同步到新的物品清单。
// 先检查冲突（整批不保存），再写入：移除已不在清单中的物品占用，新增清单中的物品占用。
function reconcile(boxId, newItems, requestId) {
  const existing = claimsForBox(boxId);
  const newKeys = new Set(newItems.map((i) => i.itemType + ':' + i.itemId));
  const existingKeys = new Set(existing.map((c) => c.item_type + ':' + c.item_id));
  const toAdd = newItems.filter((i) => !existingKeys.has(i.itemType + ':' + i.itemId));
  // 冲突检查在任何写入之前：冲突则整批不保存。
  if (toAdd.length) {
    const conflict = checkOccupancy(boxId, toAdd);
    if (conflict) {
      const error = new Error(conflictMessage(conflict));
      error.status = 409;
      error.code = 'OCCUPANCY_CONFLICT';
      error.conflict = conflict;
      throw error;
    }
  }
  // 无冲突，执行写入。
  for (const claim of existing) {
    if (!newKeys.has(claim.item_type + ':' + claim.item_id)) {
      runSql('DELETE FROM occupancy WHERE id = ' + sqlValue(claim.id) + ';');
    }
  }
  if (toAdd.length) {
    reserve(boxId, toAdd, requestId);
  }
}

// 升级回填：现有箱子没有占用资料，按进行中的单子回填。
// 冲突（同一件物品被多份进行中的箱子占用）保留双方待核对。
function backfill() {
  const boxes = select(
    "SELECT * FROM records WHERE collection = 'tourBoxes' AND status != '已闭环' ORDER BY created_at ASC;"
  );
  for (const box of boxes) {
    const data = JSON.parse(box.data);
    const items = [
      ...(data.headIds || []).map((itemId) => ({ itemType: 'puppetHeads', itemId })),
      ...(data.accessoryIds || []).map((itemId) => ({ itemType: 'accessories', itemId }))
    ];
    for (const item of items) {
      const claims = claimsForItem(item.itemType, item.itemId);
      const hasOther = claims.some((c) => c.box_id !== box.id);
      if (hasOther) {
        // 冲突：该物品的所有占用（含既有）标记为待核对，本箱也登记待核对。
        runSql(
          'UPDATE occupancy SET status = ' + sqlValue('待核对') +
          ' WHERE item_type = ' + sqlValue(item.itemType) +
          ' AND item_id = ' + sqlValue(item.itemId) + ';'
        );
        const hasThis = claims.some((c) => c.box_id === box.id);
        if (!hasThis) {
          insertClaim(box.id, item.itemType, item.itemId, '待核对', null);
        }
      } else {
        const hasThis = claims.some((c) => c.box_id === box.id);
        if (!hasThis) {
          insertClaim(box.id, item.itemType, item.itemId, '占用中', null);
        }
      }
    }
  }
}

module.exports = {
  claimsForItem,
  claimsForBox,
  checkOccupancy,
  reserve,
  release,
  reconcile,
  backfill,
  conflictMessage,
  insertClaim
};
