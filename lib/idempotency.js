const { select, runSql, sqlValue, now } = require('./db');

// 请求编号幂等：写入失败后凭原请求编号重试，不重复占用或追加事件。
// 同一请求编号只生效一次；已成功处理的请求重放时返回原结果。

function getRequestId(req) {
  return req.body.requestId ||
    req.headers['x-request-id'] ||
    req.headers['idempotency-key'] ||
    null;
}

function findIdempotency(requestId) {
  const rows = select(
    'SELECT * FROM idempotency WHERE request_id = ' + sqlValue(requestId) + ';'
  );
  return rows[0] || null;
}

function storeIdempotency(requestId, recordId, collection, statusCode, response) {
  runSql(
    'INSERT INTO idempotency (request_id, record_id, collection, status_code, response, created_at) VALUES (' +
    [
      sqlValue(requestId),
      sqlValue(recordId),
      sqlValue(collection),
      sqlValue(statusCode),
      sqlValue(JSON.stringify(response)),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

module.exports = {
  getRequestId,
  findIdempotency,
  storeIdempotency
};
