import * as fs from "node:fs";
import * as path from "node:path";
import { openDatabase } from "./db";
import { Engine } from "./engine";
import { replayVerify } from "./replay";

// 演示脚本：幂等重复、重启后同价 FIFO 保持、重放一致性。全部使用虚构数据。
function main(): void {
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, "demo.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbFile + suffix); } catch { /* 忽略不存在 */ }
  }

  console.log("=== 1. 提交卖单并演示幂等 ===");
  let db = openDatabase(dbFile);
  let engine = new Engine(db);
  const first = engine.submitLimitOrder({ idempotencyKey: "demo-sell-1", side: "sell", price: 100, qty: 10 });
  console.log("首次提交:", JSON.stringify(first));
  const dup = engine.submitLimitOrder({ idempotencyKey: "demo-sell-1", side: "sell", price: 100, qty: 10 });
  console.log("重复提交(同键同内容):", JSON.stringify(dup), "=> replayed =", dup.replayed, ", 无新成交");
  try {
    engine.submitLimitOrder({ idempotencyKey: "demo-sell-1", side: "sell", price: 101, qty: 10 });
  } catch (err) {
    console.log("同键不同内容被拒绝:", (err as Error).message);
  }

  console.log("\n=== 2. 同价 FIFO: 再挂两笔卖单，买单一次性吃掉 ===");
  engine.submitLimitOrder({ idempotencyKey: "demo-sell-2", side: "sell", price: 100, qty: 5 });
  engine.submitLimitOrder({ idempotencyKey: "demo-sell-3", side: "sell", price: 100, qty: 5 });
  const buy = engine.submitLimitOrder({ idempotencyKey: "demo-buy-1", side: "buy", price: 100, qty: 12 });
  console.log("买单成交(应按卖单 1,2,3 顺序):", JSON.stringify(buy.trades.map(t => ({ sell: t.sell_order_id, price: t.price, qty: t.qty }))));

  console.log("\n=== 3. 模拟重启：旧单仍按原接受序号优先成交 ===");
  engine.submitLimitOrder({ idempotencyKey: "demo-sell-4", side: "sell", price: 99, qty: 3 });
  db.close();
  db = openDatabase(dbFile); // “重启”
  engine = new Engine(db);
  const sell5 = engine.submitLimitOrder({ idempotencyKey: "demo-sell-5", side: "sell", price: 99, qty: 3 });
  const buy2 = engine.submitLimitOrder({ idempotencyKey: "demo-buy-2", side: "buy", price: 99, qty: 4 });
  console.log("重启后买单成交(应先吃掉重启前挂的卖单 4):", JSON.stringify(buy2.trades.map(t => ({ sell: t.sell_order_id, price: t.price, qty: t.qty }))));

  console.log("\n=== 4. 部分成交后撤销 ===");
  const cancel = engine.cancelOrder({ idempotencyKey: "demo-cancel-1", orderId: sell5.orderId });
  console.log("撤销结果:", JSON.stringify(cancel));
  const cancelDup = engine.cancelOrder({ idempotencyKey: "demo-cancel-1", orderId: sell5.orderId });
  console.log("重复撤销(幂等):", JSON.stringify(cancelDup), "=> replayed =", cancelDup.replayed);

  console.log("\n=== 5. 盘口与不变量 ===");
  console.log("盘口:", JSON.stringify(engine.getBook()));
  console.log("不变量检查:", JSON.stringify({ problems: engine.checkInvariants() }));

  console.log("\n=== 6. 重放校验（不修改当前库） ===");
  const report = replayVerify(db);
  console.log("重放结果:", JSON.stringify(report));
  db.close();
  console.log("\n演示完成。数据库文件:", dbFile);
}

main();
