# 单品限价订单撮合与成交回放（本地模拟）

一个纯本地的单品限价订单簿后端：TypeScript + Node.js + SQLite（使用 Node 内置 `node:sqlite`，无原生依赖、无外部服务）。仅提供 HTTP API 与 CLI，**仅为模拟**：所有参与者与商品均为虚构，不连接券商、交易所、支付或真实资金。

## 模拟范围（明确不做）

- 不做账户余额、保证金、手续费
- 不支持市价单、跨品种撮合（全库只有一个品种）
- 无网络外部依赖、无 Docker/WSL 要求、无付费服务

## 快速开始（Windows）

```powershell
npm install        # 仅安装 typescript / @types/node 开发依赖
npm run build      # 编译到 dist/
npm test           # 构建并运行全部自动化测试
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo       # 运行端到端演示（幂等、重启 FIFO、重放校验）
```

CLI 示例（先 `npm run build`）：

```powershell
node dist/src/cli.js submit --key order-001 --side sell --price 100 --qty 10
node dist/src/cli.js submit --key order-002 --side buy  --price 100 --qty 4
node dist/src/cli.js book
node dist/src/cli.js cancel --key cancel-001 --order 1
node dist/src/cli.js order --id 1
node dist/src/cli.js trades
node dist/src/cli.js events
node dist/src/cli.js replay       # 重放校验（只读，不改写当前簿）
node dist/src/cli.js invariants   # 不变量自检
```

## 核心规则

### 撮合（确定性连续撮合）

- 价格采用**正整数最小报价单位**（1..1,000,000,000），数量为正整数（1..1,000,000,000）。全链路只用整数，不存在浮点价格比较问题。
- 新买单优先匹配**价格最低**的卖单，且卖价必须 `<=` 买方限价；新卖单对称地匹配**价格最高**且 `>=` 卖方限价的买单。
- 同一价格档内按**接受序号**（`order_id`，单调递增、持久化）先进先出；客户端时间戳不参与优先级。
- 每笔成交量 = min(主动单剩余, 被动单剩余)；**成交价 = 先前已挂入订单簿的被动单价格**。
- 主动单跨多个价格档持续撮合，直到数量用尽或没有可成交挂单；剩余量按原始接受序号挂入订单簿。

### 命令串行化与事务

- 每条被接受的命令分配递增 `seq`（`commands` 表），命令的执行顺序即提交顺序。
- 每条命令的撮合成交、订单状态更新与事件记录在**一个 SQLite 事务**（`BEGIN IMMEDIATE`）中提交：要么全部落库，要么整体回滚，不会留下部分成交。查询只能看到某条命令之前或之后的完整状态。
- 本机并发提交由 SQLite 写事务串行化，提交顺序确定。

### 幂等

- 提交订单与撤单都必须携带 `idempotencyKey`（1..128 字符）。
- 相同键 + 相同内容重复提交：返回**原始结果**（`replayed: true`），不产生新成交、不改变盘口。
- 相同键 + 不同内容：拒绝，返回错误码 `IDEMPOTENCY_CONFLICT`（HTTP 409）。

### 撤单

- 只撤销尚未成交的剩余数量，已成交部分保留。
- 重复撤销（同一幂等键）返回首次撤销的原始结果，不会重复减少盘口。

### 重放校验

- `POST /replay/verify` 或 `cli.js replay`：从空簿按 `seq` 顺序在**独立的内存数据库**中重放所有已保存命令，核对最终每笔订单的 `filled/canceled` 与全部成交的顺序、价格、数量。
- 重放不修改当前订单簿。
- 数据库保存 `rules_version`（当前 `1.0.0`），重启后校验版本一致才继续服务，保证同价旧单的原始次序在重启后仍然有效。

## HTTP API

默认端口为 `0`（自动选择空闲端口），可用 `--port=8080` 或环境变量 `PORT` 指定。数据目录默认为项目内 `data/`，可用 `DATA_DIR` / `DB_FILE` 覆盖。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/orders` | 提交限价单：`{idempotencyKey, side: "buy"\|"sell", price, qty}` |
| POST | `/orders/:id/cancel` | 撤单：`{idempotencyKey}` |
| GET | `/orders/:id` | 查询订单状态（qty/filled/canceled/remaining/status） |
| GET | `/trades?orderId=` | 查询成交明细（可按订单过滤） |
| GET | `/book` | 按价位汇总盘口（bids 降序 / asks 升序） |
| GET | `/events?from=` | 导出事件记录（order_accepted / trade / order_updated / order_canceled） |
| POST | `/replay/verify` | 重放校验 |
| GET | `/invariants` | 不变量自检 |
| GET | `/health` | 健康检查 |

### 错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 参数非法（价格/数量非正整数、方向非法、幂等键非法、JSON 非法） |
| `IDEMPOTENCY_CONFLICT` | 409 | 同一幂等键提交了不同内容 |
| `ORDER_NOT_FOUND` | 404 | 订单不存在 |
| `NOT_FOUND` | 404 | 路由不存在 |
| `INTERNAL_ERROR` | 500 | 未预期错误（事务已回滚） |

错误响应格式：`{"error": {"code": "...", "message": "..."}}`。

## 不变量（测试与 `/invariants` 自检）

- 每笔订单：`qty = filled + canceled + remaining`
- 成交买卖量守恒：订单的 `filled` 等于其作为买/卖方的成交量之和
- 处理完每条命令后盘口不存在可立即交叉的价格（最优买价 < 最优卖价）
- 盘口各价位汇总量等于对应挂单剩余量之和

## 测试

`npm test` 覆盖：价格优先、同价 FIFO、主动单跨档成交、卖单方向对称、部分成交后撤销（含重复撤销幂等）、不可成交挂单、恰好用尽、幂等冲突、参数校验、重启后旧单优先、重放一致性、订单守恒与盘口汇总一致性。

## 项目结构

```
src/types.ts    类型、常量、参数校验、错误码
src/db.ts       SQLite 打开、建表、规则版本校验
src/engine.ts   撮合引擎（事务、幂等、撮合、撤单、查询、不变量）
src/replay.ts   重放校验（独立内存库，不改写当前簿）
src/server.ts   HTTP API（node:http，无框架）
src/cli.ts      命令行入口
src/demo.ts     端到端演示脚本
test/engine.test.ts  自动化测试（node:test）
data/           本地数据目录（SQLite 文件）
```

## 限制

- 单进程、单品种、单节点：不面向高并发或分布式部署（本机并发由 SQLite 事务串行化保证确定性）。
- 无鉴权、无速率限制，仅面向本机开发与演示。
- `node:sqlite` 在 Node 25 中仍打印 ExperimentalWarning，不影响功能。
