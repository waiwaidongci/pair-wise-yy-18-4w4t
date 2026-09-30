# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

依赖 `sqlite3` 命令行：优先取环境变量 `SQLITE3_BIN`，其次用仓库自带的 `tools/sqlite3`（若有），最后回退到 PATH 里的 `sqlite3`。

## 代码结构

- `server.js` — 请求入口：HTTP 路由、请求编号幂等、版本并发控制
- `occupancy.js` — 占用判定：装箱登记与调整共用的占用关系、冲突检测、升级回填
- `linkage.js` — 档案联动：修补记录牵动偶头与箱子、缺损追踪约束闭环
- `db.js` — 数据层：SQLite 存取、事务、建表与迁移

## 业务规则

- **统一占用**：装箱登记（`POST /api/tourBoxes`）与调整（`PATCH` / `events`）共用同一份占用关系。未闭环的箱子占用其偶头与配件；同一件物品不能被两份未结束装箱单同时占用。
- **冲突整批不保存**：占用冲突时整批不保存，返回 409 并在 `conflicts` 里说清哪份箱子、哪件物品在占。
- **修补联动**：修补记录一开，关联偶头转入「修补中」，装着它的在途箱子（已装箱/巡演中）退回「返场清点中」。
- **闭环约束**：缺损追踪还有「待处理/修复中」的单子，箱子不能闭环（409，`openLossReports` 列出未结项）。
- **升级回填**：老箱子没有占用资料，启动时按进行中的单子自动回填；同一件物品被多份单子占用的，双方保留「待核对」，可在 `GET /api/occupancy?state=待核对` 查看并用 `POST /api/occupancy/:id/resolve` 核对（`decision`: `生效中` / `已释放`）。
- **版本并发**：记录带 `version`。装箱单的写入必须携带当前 `version`；两个终端同时提交同一箱子，只接受先到的一方，后到的收到 409 版本冲突。其他集合携带 `version` 时同样校验。
- **请求编号幂等**：写请求可带 `X-Request-Id` 头或 `requestId` 字段。写入失败后凭原请求编号重试，直接返回首次结果，不重复占用或追加事件。

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/occupancy?state=待核对`
- `POST /api/occupancy/:id/resolve`
- `GET /api/:collection/:id/timeline`

SQLite数据库文件会在首次启动时创建到`data/app.db`。

## 测试

```bash
npm test
```

端到端覆盖：统一占用、冲突整批不保存、修补联动、闭环约束、升级回填、版本冲突、请求编号幂等。
