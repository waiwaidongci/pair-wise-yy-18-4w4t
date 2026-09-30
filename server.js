const express = require('express');
const config = require('./project.config');
const { initDb, select, runSql, sqlValue, persist } = require('./lib/db');
const occupancy = require('./lib/occupancy');
const routes = require('./lib/routes');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));
app.use(routes);

// 升级回填：现有箱子没有占用资料，按进行中的单子回填。
// 冲突保留双方待核对。只执行一次（meta 标记）。
function runBackfill() {
  const flag = select("SELECT value FROM meta WHERE key = 'occupancy_backfilled';");
  if (flag.length) return;
  occupancy.backfill();
  runSql("INSERT INTO meta (key, value) VALUES ('occupancy_backfilled', '1');");
}

initDb().then(() => {
  runBackfill();
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
});
