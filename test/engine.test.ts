import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDatabase } from "../src/db";
import { Engine } from "../src/engine";
import { replayVerify } from "../src/replay";
import { ApiError } from "../src/types";

function freshEngine(): { engine: Engine; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase(":memory:");
  return { engine: new Engine(db), db };
}

let keyCounter = 0;
const key = () => `k${++keyCounter}`;

test("价格优先：买单先匹配最低卖价", () => {
  const { engine } = freshEngine();
  engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 102, qty: 5 });
  engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 100, qty: 5 });
  engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 101, qty: 5 });
  const buy = engine.submitLimitOrder({ idempotencyKey: key(), side: "buy", price: 101, qty: 7 });
  assert.deepEqual(buy.trades.map(t => [t.price, t.qty]), [[100, 5], [101, 2]]);
  assert.equal(buy.remaining, 0);
  assert.deepEqual(engine.checkInvariants(), []);
});

test("同价 FIFO：先接受的卖单先成交", () => {
  const { engine } = freshEngine();
  const s1 = engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 100, qty: 4 });
  const s2 = engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 100, qty: 4 });
  const buy = engine.submitLimitOrder({ idempotencyKey: key(), side: "buy", price: 100, qty: 5 });
  assert.deepEqual(buy.trades.map(t => [t.sell_order_id, t.qty]), [[s1.orderId, 4], [s2.orderId, 1]]);
  assert.equal(engine.getOrderView(s1.orderId).status, "filled");
  assert.equal(engine.getOrderView(s2.orderId).remaining, 3);
  assert.deepEqual(engine.checkInvariants(), []);
});

test("主动单跨多档持续撮合，成交价为被动单价格", () => {
  const { engine } = freshEngine();
  engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 100, qty: 3 });
  engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 101, qty: 3 });
  engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 105, qty: 3 });
  const buy = engine.submitLimitOrder({ idempotencyKey: key(), side: "buy", price: 103, qty: 10 });
  assert.deepEqual(buy.trades.map(t => [t.price, t.qty]), [[100, 3], [101, 3]]);
  assert.equal(buy.remaining, 4); // 105 高于限价，不再成交，剩余挂入买盘
  const book = engine.getBook();
  assert.deepEqual(book.bids.map(b => [b.price, b.qty]), [[103, 4]]);
  assert.deepEqual(book.asks.map(a => [a.price, a.qty]), [[105, 3]]);
  assert.deepEqual(engine.checkInvariants(), []);
});

test("卖单方向对称：匹配最高买价", () => {
  const { engine } = freshEngine();
  engine.submitLimitOrder({ idempotencyKey: key(), side: "buy", price: 98, qty: 2 });
  engine.submitLimitOrder({ idempotencyKey: key(), side: "buy", price: 100, qty: 2 });
  const sell = engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 99, qty: 5 });
  assert.deepEqual(sell.trades.map(t => [t.price, t.qty]), [[100, 2]]);
  assert.equal(sell.remaining, 3);
  assert.deepEqual(engine.checkInvariants(), []);
});

test("部分成交后撤销：只撤剩余量，已成交保留，重复撤销幂等", () => {
  const { engine } = freshEngine();
  const sell = engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 100, qty: 10 });
  engine.submitLimitOrder({ idempotencyKey: key(), side: "buy", price: 100, qty: 4 });
  const c1 = engine.cancelOrder({ idempotencyKey: "cancel-1", orderId: sell.orderId });
  assert.equal(c1.canceledQty, 6);
  assert.equal(c1.filled, 4);
  assert.equal(c1.remaining, 0);
  const view = engine.getOrderView(sell.orderId);
  assert.equal(view.qty, view.filled + view.canceled + view.remaining);
  const c2 = engine.cancelOrder({ idempotencyKey: "cancel-1", orderId: sell.orderId });
  assert.equal(c2.replayed, true);
  assert.equal(c2.canceledQty, 6); // 返回原始结果，不重复减少
  assert.deepEqual(engine.getBook().asks, []);
  assert.deepEqual(engine.checkInvariants(), []);
});

test("不可成交挂单与恰好用尽", () => {
  const { engine } = freshEngine();
  engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 100, qty: 5 });
  const resting = engine.submitLimitOrder({ idempotencyKey: key(), side: "buy", price: 99, qty: 5 });
  assert.equal(resting.trades.length, 0);
  assert.equal(resting.remaining, 5);
  const exact = engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 99, qty: 5 });
  assert.deepEqual(exact.trades.map(t => [t.price, t.qty]), [[99, 5]]);
  assert.equal(exact.remaining, 0);
  assert.deepEqual(engine.getBook(), { bids: [], asks: [{ side: "sell", price: 100, qty: 5, orders: 1 }] });
  assert.deepEqual(engine.checkInvariants(), []);
});

test("幂等：同键同内容返回原结果且无新成交；同键不同内容拒绝", () => {
  const { engine } = freshEngine();
  engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 100, qty: 5 });
  const r1 = engine.submitLimitOrder({ idempotencyKey: "dup", side: "buy", price: 100, qty: 5 });
  const r2 = engine.submitLimitOrder({ idempotencyKey: "dup", side: "buy", price: 100, qty: 5 });
  assert.equal(r2.replayed, true);
  assert.equal(r2.orderId, r1.orderId);
  assert.equal(engine.getTrades().length, 1);
  assert.throws(
    () => engine.submitLimitOrder({ idempotencyKey: "dup", side: "buy", price: 101, qty: 5 }),
    (err: unknown) => err instanceof ApiError && err.code === "IDEMPOTENCY_CONFLICT"
  );
});

test("参数校验：非法价格/数量/方向被拒绝", () => {
  const { engine } = freshEngine();
  for (const bad of [
    { idempotencyKey: key(), side: "buy" as const, price: 0, qty: 1 },
    { idempotencyKey: key(), side: "buy" as const, price: 100.5, qty: 1 },
    { idempotencyKey: key(), side: "buy" as const, price: 100, qty: -1 },
    { idempotencyKey: key(), side: "buy" as const, price: 100, qty: 1.5 },
  ]) {
    assert.throws(() => engine.submitLimitOrder(bad), (e: unknown) => e instanceof ApiError && e.code === "VALIDATION_ERROR");
  }
  assert.throws(
    () => engine.submitLimitOrder({ idempotencyKey: key(), side: "hold" as never, price: 1, qty: 1 }),
    (e: unknown) => e instanceof ApiError && e.code === "VALIDATION_ERROR"
  );
});

test("重启后同价旧单仍先成交（接受序号持久化）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lob-"));
  const file = path.join(dir, "test.db");
  let db = openDatabase(file);
  let engine = new Engine(db);
  const old = engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 100, qty: 2 });
  db.close();
  db = openDatabase(file); // 模拟重启
  engine = new Engine(db);
  engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 100, qty: 2 });
  const buy = engine.submitLimitOrder({ idempotencyKey: key(), side: "buy", price: 100, qty: 3 });
  assert.deepEqual(buy.trades.map(t => [t.sell_order_id, t.qty]), [[old.orderId, 2], [old.orderId + 1, 1]]);
  assert.deepEqual(engine.checkInvariants(), []);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("重放校验一致且不改写当前簿", () => {
  const { engine, db } = freshEngine();
  engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 100, qty: 5 });
  engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 101, qty: 5 });
  const buy = engine.submitLimitOrder({ idempotencyKey: key(), side: "buy", price: 101, qty: 7 });
  engine.cancelOrder({ idempotencyKey: key(), orderId: buy.orderId });
  const tradesBefore = engine.getTrades().length;
  const report = replayVerify(db);
  assert.equal(report.ok, true, report.differences.join("; "));
  assert.equal(report.commandsReplayed, 4);
  assert.equal(engine.getTrades().length, tradesBefore); // 当前簿未被改写
  assert.deepEqual(engine.checkInvariants(), []);
});

test("每笔订单守恒：qty = filled + canceled + remaining，且盘口汇总等于挂单剩余之和", () => {
  const { engine } = freshEngine();
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) ids.push(engine.submitLimitOrder({ idempotencyKey: key(), side: "sell", price: 100 + i, qty: 10 }).orderId);
  for (let i = 0; i < 3; i++) ids.push(engine.submitLimitOrder({ idempotencyKey: key(), side: "buy", price: 102, qty: 7 }).orderId);
  engine.cancelOrder({ idempotencyKey: key(), orderId: ids[3] });
  for (const id of ids) {
    const v = engine.getOrderView(id);
    assert.equal(v.qty, v.filled + v.canceled + v.remaining);
  }
  const book = engine.getBook();
  const bookTotal = [...book.bids, ...book.asks].reduce((s, l) => s + l.qty, 0);
  const remainingTotal = ids.reduce((s, id) => s + engine.getOrderView(id).remaining, 0);
  assert.equal(bookTotal, remainingTotal);
  assert.deepEqual(engine.checkInvariants(), []);
});
