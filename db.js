const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const config = require('./project.config');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const LOCAL_SQLITE3 = path.join(__dirname, 'tools', 'sqlite3');
const SQLITE3_BIN =
  process.env.SQLITE3_BIN || (fs.existsSync(LOCAL_SQLITE3) ? LOCAL_SQLITE3 : 'sqlite3');

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function runSql(sql) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return execFileSync(SQLITE3_BIN, [DB_FILE], {
    input: sql,
    encoding: 'utf8'
  });
}

function select(sql) {
  const output = runSql('.mode json\n' + sql);
  if (!output.trim()) return [];
  return JSON.parse(output);
}

// 一批写语句放进同一个事务：任何一句失败整体回滚，保证“整批不保存”。
function runTx(statements) {
  const list = (Array.isArray(statements) ? statements : [statements]).filter(Boolean);
  if (!list.length) return;
  runSql(['.bail on', 'BEGIN IMMEDIATE;', ...list, 'COMMIT;'].join('\n'));
}

function now() {
  return new Date().toISOString();
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data,
    version: row.version === undefined ? 1 : row.version
  };
}

// 记录里属于业务数据的字段（剥掉系统字段）
function recordData(record) {
  const data = { ...record };
  delete data.id;
  delete data.collection;
  delete data.createdAt;
  delete data.updatedAt;
  delete data.version;
  return data;
}

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function titleFor(collectionConfig, data) {
  return (
    (collectionConfig.titleFields || [])
      .map((field) => data[field])
      .filter(Boolean)
      .join(' / ') ||
    data.name ||
    data.title ||
    data.code ||
    ''
  );
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter(
    (field) => data[field] === undefined || data[field] === ''
  );
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function insertRecordStmt({ collection, id, status, data, createdAt }) {
  const collectionConfig = findCollection(collection);
  return (
    'INSERT INTO records (id, collection, status, title, data, version, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(collection),
      sqlValue(status),
      sqlValue(titleFor(collectionConfig, data)),
      sqlValue(JSON.stringify(data)),
      1,
      sqlValue(createdAt),
      sqlValue(createdAt)
    ].join(', ') +
    ');'
  );
}

// expectedVersion 提供时，只有版本仍然吻合才会真正更新（乐观锁）
function updateRecordStmt({ collection, id, data, status, expectedVersion, updatedAt }) {
  const collectionConfig = findCollection(collection);
  let sql =
    'UPDATE records SET status = ' +
    sqlValue(status) +
    ', title = ' +
    sqlValue(titleFor(collectionConfig, data)) +
    ', data = ' +
    sqlValue(JSON.stringify(data)) +
    ', version = version + 1' +
    ', updated_at = ' +
    sqlValue(updatedAt || now()) +
    ' WHERE collection = ' +
    sqlValue(collection) +
    ' AND id = ' +
    sqlValue(id);
  if (expectedVersion !== undefined && expectedVersion !== null) {
    sql += ' AND version = ' + Number(expectedVersion);
  }
  return sql + ';';
}

// 版本守卫：紧跟在带 expectedVersion 的 UPDATE 后面。
// 若上一条 UPDATE 因版本不符没改到行，这里的 INSERT 必然触发 CHECK 失败，整个事务回滚。
const VERSION_GUARD_STMT =
  "INSERT INTO version_conflict_guard (note) SELECT 'version conflict' WHERE changes() = 0;";

function deleteRecordStmt(collection, id) {
  return (
    'DELETE FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ';'
  );
}

function deleteEventsStmt(recordId) {
  return 'DELETE FROM events WHERE record_id = ' + sqlValue(recordId) + ';';
}

function insertEventStmt({ recordId, collection, action, status, actor, note, data }) {
  return (
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(recordId),
      sqlValue(collection),
      sqlValue(action || '记录'),
      sqlValue(status || ''),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

function loadRecord(collection, id) {
  const rows = select(
    'SELECT * FROM records WHERE collection = ' +
      sqlValue(collection) +
      ' AND id = ' +
      sqlValue(id) +
      ' LIMIT 1;'
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

function loadRecords(collection) {
  return select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' ORDER BY created_at ASC;'
  ).map(toRecord);
}

// 请求编号（幂等键）：写入成功后连同响应一起落库，重试时直接回放
function findRequest(requestId) {
  const rows = select(
    'SELECT * FROM requests WHERE request_id = ' + sqlValue(requestId) + ' LIMIT 1;'
  );
  return rows[0] || null;
}

function storeRequestStmt({ requestId, method, path, responseStatus, responseBody }) {
  return (
    'INSERT INTO requests (request_id, method, path, response_status, response_body, created_at) VALUES (' +
    [
      sqlValue(requestId),
      sqlValue(method),
      sqlValue(path),
      Number(responseStatus),
      sqlValue(responseBody),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

function migrate() {
  const columns = select('PRAGMA table_info(records);').map((column) => column.name);
  if (!columns.includes('version')) {
    runSql('ALTER TABLE records ADD COLUMN version INTEGER NOT NULL DEFAULT 1;');
  }
}

function seed() {
  const count = select('SELECT COUNT(*) AS count FROM records;')[0].count;
  if (count > 0) return;
  const statements = [];
  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    statements.push(insertRecordStmt({ collection: seed.collection, id, status, data, createdAt }));
    statements.push(
      insertEventStmt({
        recordId: id,
        collection: seed.collection,
        action: seed.eventAction || '创建',
        status,
        actor: seed.actor || 'system',
        note: seed.note || '',
        data
      })
    );
  }
  if (statements.length) runTx(statements);
}

function initDb() {
  runSql(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
CREATE TABLE IF NOT EXISTS occupancy (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  box_id TEXT NOT NULL,
  state TEXT NOT NULL,
  request_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_occupancy_item ON occupancy(item_type, item_id, state);
CREATE INDEX IF NOT EXISTS idx_occupancy_box ON occupancy(box_id, state);
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS version_conflict_guard (
  note TEXT CHECK (1 = 0)
);
`);
  migrate();
  seed();
}

module.exports = {
  DATA_DIR,
  DB_FILE,
  sqlValue,
  runSql,
  select,
  runTx,
  now,
  toRecord,
  recordData,
  findCollection,
  titleFor,
  validate,
  insertRecordStmt,
  updateRecordStmt,
  VERSION_GUARD_STMT,
  deleteRecordStmt,
  deleteEventsStmt,
  insertEventStmt,
  loadRecord,
  loadRecords,
  findRequest,
  storeRequestStmt,
  initDb
};
