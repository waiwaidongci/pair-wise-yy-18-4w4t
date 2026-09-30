// 端到端冒烟测试：统一占用、冲突整批不保存、修补联动、闭环约束、
// 升级回填、版本冲突、请求编号幂等。
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, '.tmp-smoke');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const SQLITE3 = path.join(ROOT, 'tools', 'sqlite3');
const PORT = 43914;
const BASE = 'http://localhost:' + PORT;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok - ' + name);
  } else {
    failed++;
    console.log('  FAIL - ' + name + (detail ? ' :: ' + JSON.stringify(detail) : ''));
  }
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, body: data };
}

function sql(statement) {
  return execFileSync(SQLITE3, [DB_FILE], { input: statement, encoding: 'utf8' });
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('server did not start');
}

let server;

async function startServer() {
  server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (chunk) => process.stderr.write('[server] ' + chunk));
  await waitUp();
}

async function stopServer() {
  if (!server) return;
  server.kill();
  await new Promise((resolve) => server.once('exit', resolve));
  server = null;
}

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  await startServer();

  console.log('— 基础档案与装箱登记 —');
  const head1 = (
    await api('POST', '/api/puppetHeads', {
      role: '武生',
      play: '火焰山',
      paintStatus: '完好',
      mechanism: '正常',
      boxNo: '木箱甲-01'
    })
  ).body;
  const head2 = (
    await api('POST', '/api/puppetHeads', {
      role: '旦角',
      play: '火焰山',
      paintStatus: '完好',
      mechanism: '正常',
      boxNo: '木箱甲-02'
    })
  ).body;
  const acc1 = (
    await api('POST', '/api/accessories', {
      name: '金丝蟒',
      role: '武生',
      play: '火焰山',
      boxNo: '配件箱-01'
    })
  ).body;
  check('偶头建档成功且带版本号', head1.id && head1.version === 1, head1);

  const boxA = (
    await api('POST', '/api/tourBoxes', {
      showName: '北京站',
      venue: '长安戏院',
      play: '火焰山',
      headIds: [head1.id],
      accessoryIds: [acc1.id]
    })
  ).body;
  check('装箱单 A 登记成功', boxA.id && boxA.status === '草稿', boxA);

  let occ = (await api('GET', '/api/occupancy?boxId=' + boxA.id)).body;
  check('登记后产生 2 条生效占用', occ.length === 2 && occ.every((o) => o.state === '生效中'), occ);

  console.log('— 冲突整批不保存 —');
  const conflict = await api('POST', '/api/tourBoxes', {
    showName: '天津站',
    venue: '劝业场',
    play: '火焰山',
    headIds: [head1.id, head2.id],
    accessoryIds: []
  });
  check('冲突返回 409', conflict.status === 409, conflict);
  check(
    '报错说清哪件物品、哪份箱子在占',
    conflict.body.conflicts &&
      conflict.body.conflicts.length === 1 &&
      conflict.body.conflicts[0].itemId === head1.id &&
      conflict.body.conflicts[0].boxId === boxA.id &&
      conflict.body.conflicts[0].itemLabel.includes('武生') &&
      conflict.body.conflicts[0].boxLabel.includes('北京站'),
    conflict.body
  );
  const allBoxes = (await api('GET', '/api/tourBoxes')).body;
  check('整批不保存：冲突的装箱单不存在', allBoxes.length === 1, allBoxes);
  occ = (await api('GET', '/api/occupancy?itemId=' + head2.id)).body;
  check('整批不保存：同批无冲突物品也未被占用', occ.length === 0, occ);

  console.log('— 登记与调整共用一份占用 —');
  const missingVersion = await api('PATCH', '/api/tourBoxes/' + boxA.id, {
    headIds: [head2.id]
  });
  check('装箱单调整必须携带 version', missingVersion.status === 400, missingVersion);

  const adjusted = await api('PATCH', '/api/tourBoxes/' + boxA.id, {
    version: boxA.version,
    headIds: [head2.id],
    accessoryIds: [acc1.id],
    action: '调整'
  });
  check('调整成功且版本递增', adjusted.status === 200 && adjusted.body.version === 2, adjusted.body);
  occ = (await api('GET', '/api/occupancy?boxId=' + boxA.id)).body;
  const activeOcc = occ.filter((o) => o.state === '生效中');
  check(
    '调整后占用同步：head2+acc1 生效、head1 已释放',
    activeOcc.length === 2 &&
      activeOcc.some((o) => o.itemId === head2.id) &&
      activeOcc.some((o) => o.itemId === acc1.id) &&
      occ.some((o) => o.itemId === head1.id && o.state === '已释放'),
    occ
  );

  console.log('— 两个终端同时提交：后到看到版本冲突 —');
  const stale = await api('PATCH', '/api/tourBoxes/' + boxA.id, {
    version: 1,
    note: '旧终端的提交'
  });
  check('旧版本提交返回 409 版本冲突', stale.status === 409 && stale.body.currentVersion === 2, stale.body);
  const fresh = await api('PATCH', '/api/tourBoxes/' + boxA.id, {
    version: 2,
    note: '新终端的提交'
  });
  check('当前版本提交成功', fresh.status === 200 && fresh.body.version === 3, fresh.body);

  const [race1, race2] = await Promise.all([
    api('PATCH', '/api/tourBoxes/' + boxA.id, { version: 3, note: '终端甲' }),
    api('PATCH', '/api/tourBoxes/' + boxA.id, { version: 3, note: '终端乙' })
  ]);
  const raceStatuses = [race1.status, race2.status].sort().join(',');
  check('同时提交只接受先到的一方', raceStatuses === '200,409', [race1.body, race2.body]);

  console.log('— 写入失败凭原请求编号重试 —');
  const rid = 'req-' + Date.now();
  const first = await api('POST', '/api/tourBoxes', {
    showName: '上海站',
    venue: '天蟾舞台',
    play: '火焰山',
    headIds: [],
    accessoryIds: []
  }, { 'x-request-id': rid });
  check('首次提交成功', first.status === 201, first.body);
  const retry = await api('POST', '/api/tourBoxes', {
    showName: '上海站',
    venue: '天蟾舞台',
    play: '火焰山',
    headIds: [],
    accessoryIds: []
  }, { 'x-request-id': rid });
  check('重试返回同一结果', retry.status === 201 && retry.body.id === first.body.id, retry.body);
  const boxesAfterRetry = (await api('GET', '/api/tourBoxes')).body;
  check('重试没有重复建档', boxesAfterRetry.length === 2, boxesAfterRetry);
  const timeline = (await api('GET', '/api/tourBoxes/' + first.body.id + '/timeline')).body;
  check(
    '重试没有追加事件',
    timeline.events.filter((e) => e.action === '创建').length === 1,
    timeline.events
  );

  const ridPatch = 'req-patch-' + Date.now();
  const boxForIdem = (await api('GET', '/api/tourBoxes/' + boxA.id)).body;
  const patchFirst = await api('PATCH', '/api/tourBoxes/' + boxA.id, {
    requestId: ridPatch,
    version: boxForIdem.version,
    note: '带请求编号的调整'
  });
  const patchRetry = await api('PATCH', '/api/tourBoxes/' + boxA.id, {
    requestId: ridPatch,
    version: boxForIdem.version,
    note: '带请求编号的调整（重试）'
  });
  check(
    '调整重试幂等：不触发版本冲突，结果一致',
    patchFirst.status === 200 && patchRetry.status === 200 && patchRetry.body.version === patchFirst.body.version,
    { first: patchFirst.body, retry: patchRetry.body }
  );

  console.log('— 修补记录一开，关联箱子退回返场清点 —');
  const boxForEvents = (await api('GET', '/api/tourBoxes/' + boxA.id)).body;
  const noVerEvent = await api('POST', '/api/tourBoxes/' + boxA.id + '/events', {
    status: '已装箱'
  });
  check('装箱单事件提交也必须携带 version', noVerEvent.status === 400, noVerEvent.body);
  const packed = await api('POST', '/api/tourBoxes/' + boxA.id + '/events', {
    version: boxForEvents.version,
    status: '已装箱',
    note: '装箱完成'
  });
  check('事件端点按版本推进状态', packed.status === 200 && packed.body.status === '已装箱', packed.body);
  await api('POST', '/api/tourBoxes/' + boxA.id + '/events', {
    version: packed.body.version,
    status: '巡演中'
  });
  const repair = await api('POST', '/api/repairRecords', {
    puppetHeadId: head2.id,
    repairType: '补漆',
    handler: '王师傅'
  });
  check('修补记录开立成功', repair.status === 201, repair.body);
  const boxAfterRepair = (await api('GET', '/api/tourBoxes/' + boxA.id)).body;
  check('关联箱子退回返场清点', boxAfterRepair.status === '返场清点中', boxAfterRepair);
  const headAfterRepair = (await api('GET', '/api/puppetHeads/' + head2.id)).body;
  check('偶头档案联动为修补中', headAfterRepair.status === '修补中', headAfterRepair);

  const badRepair = await api('POST', '/api/repairRecords', {
    puppetHeadId: 'no-such-head',
    repairType: '补漆',
    handler: '王师傅'
  });
  check('修补记录关联不存在的偶头被拒绝', badRepair.status === 400, badRepair.body);

  console.log('— 缺损追踪没处理完，箱子不能闭环 —');
  const loss = (
    await api('POST', '/api/lossReports', {
      tourBoxId: boxA.id,
      itemType: 'accessories',
      itemName: '金丝蟒',
      problem: '袖口撕裂'
    })
  ).body;
  const boxNow = (await api('GET', '/api/tourBoxes/' + boxA.id)).body;
  const blocked = await api('PATCH', '/api/tourBoxes/' + boxA.id, {
    version: boxNow.version,
    status: '已闭环'
  });
  check('未处理完的缺损挡住闭环', blocked.status === 409 && blocked.body.openLossReports.length === 1, blocked.body);
  await api('POST', '/api/lossReports/' + loss.id + '/events', { status: '已补齐', note: '已织补' });
  const boxNow2 = (await api('GET', '/api/tourBoxes/' + boxA.id)).body;
  const closed = await api('PATCH', '/api/tourBoxes/' + boxA.id, {
    version: boxNow2.version,
    status: '已闭环'
  });
  check('缺损处理完后可以闭环', closed.status === 200 && closed.body.status === '已闭环', closed.body);
  occ = (await api('GET', '/api/occupancy?boxId=' + boxA.id)).body;
  check('闭环后占用全部释放', occ.every((o) => o.state === '已释放'), occ);

  console.log('— 升级回填：按进行中的单子补登，冲突双方待核对 —');
  await stopServer();
  sql('DELETE FROM occupancy;');
  const sqlString = (value) => "'" + String(value).replaceAll("'", "''") + "'";
  const legacyBox = (id, status, createdAt, headIds, accessoryIds) =>
    'INSERT INTO records (id, collection, status, title, data, version, created_at, updated_at) VALUES (' +
    [
      sqlString(id),
      "'tourBoxes'",
      sqlString(status),
      sqlString(id + ' / 火焰山'),
      sqlString(
        JSON.stringify({
          showName: id,
          venue: '旧仓',
          play: '火焰山',
          headIds,
          accessoryIds,
          status
        })
      ),
      1,
      sqlString(createdAt),
      sqlString(createdAt)
    ].join(', ') +
    ');';
  sql(legacyBox('box-legacy-1', '巡演中', '2026-01-01T00:00:00.000Z', [head2.id], [acc1.id]));
  sql(legacyBox('box-legacy-2', '已装箱', '2026-01-02T00:00:00.000Z', [], [acc1.id]));
  await startServer();
  occ = (await api('GET', '/api/occupancy')).body;
  const legacy1 = occ.filter((o) => o.boxId === 'box-legacy-1');
  const legacy2 = occ.filter((o) => o.boxId === 'box-legacy-2');
  check('老箱子按进行中的单子回填', legacy1.length === 2 && legacy2.length === 1, occ);
  check('闭环箱不回填', !occ.some((o) => o.boxId === boxA.id), occ);
  const pending = occ.filter((o) => o.state === '待核对');
  check(
    '冲突物品双方待核对',
    pending.length === 2 && pending.every((o) => o.itemId === acc1.id),
    pending
  );
  check(
    '无冲突物品直接生效',
    legacy1.some((o) => o.itemId === head2.id && o.state === '生效中'),
    legacy1
  );
  const legacyTimeline = (await api('GET', '/api/tourBoxes/box-legacy-1/timeline')).body;
  check(
    '回填在时间线留痕',
    legacyTimeline.events.some((e) => e.action === '占用回填'),
    legacyTimeline.events.map((e) => e.action)
  );

  const mine = pending.find((o) => o.boxId === 'box-legacy-2');
  const resolved = await api('POST', '/api/occupancy/' + mine.id + '/resolve', {
    decision: '已释放',
    actor: '班主',
    note: '核对后老箱二放行'
  });
  check('待核对占用可以核对释放', resolved.status === 200, resolved.body);
  const other = pending.find((o) => o.boxId === 'box-legacy-1');
  const resolvedActive = await api('POST', '/api/occupancy/' + other.id + '/resolve', {
    decision: '生效中',
    actor: '班主'
  });
  check('另一方核对为生效', resolvedActive.status === 200, resolvedActive.body);
  const reresolve = await api('POST', '/api/occupancy/' + mine.id + '/resolve', {
    decision: '生效中'
  });
  check('已核对的占用不能重复核对', reresolve.status === 409, reresolve.body);

  console.log('— 重启幂等：回填不重复 —');
  await stopServer();
  await startServer();
  const occAfterRestart = (await api('GET', '/api/occupancy')).body;
  check('重启后占用记录数不变', occAfterRestart.length === occ.length, {
    before: occ.length,
    after: occAfterRestart.length
  });

  await stopServer();
  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await stopServer();
  process.exit(1);
});
