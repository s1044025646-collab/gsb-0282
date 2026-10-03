import { DatabaseSync } from "node:sqlite";
import {
  ApiError, OrderRow, TradeRow, Side, remaining, orderStatus,
  validatePriceQty, validateSide, validateIdempotencyKey,
} from "./types";

export interface SubmitResult {
  commandSeq: number;
  orderId: number;
  status: string;
  filled: number;
  remaining: number;
  trades: TradeRow[];
  replayed: boolean;
}

export interface CancelResult {
  commandSeq: number;
  orderId: number;
  canceledQty: number;
  status: string;
  filled: number;
  remaining: number;
  replayed: boolean;
}

interface CommandRow {
  seq: number;
  type: string;
  payload: string;
  result: string;
}

export class Engine {
  constructor(private db: DatabaseSync) {}

  private getOrder(orderId: number): OrderRow {
    const row = this.db.prepare("SELECT * FROM orders WHERE order_id = ?").get(orderId) as OrderRow | undefined;
    if (!row) throw new ApiError("ORDER_NOT_FOUND", `订单 ${orderId} 不存在`, 404);
    return row;
  }

  private recordEvent(commandSeq: number, type: string, data: unknown): void {
    this.db.prepare("INSERT INTO events(command_seq, type, data) VALUES (?, ?, ?)")
      .run(commandSeq, type, JSON.stringify(data));
  }

  // 在单个事务中执行命令：幂等检查 + 撮合 + 事件，要么全部提交要么全部回滚。
  private executeCommand<T>(type: string, idempotencyKey: string, payload: object, run: (seq: number) => T): T & { replayed: boolean } {
    const key = validateIdempotencyKey(idempotencyKey);
    const payloadJson = JSON.stringify(payload);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM commands WHERE idempotency_key = ?").get(key) as CommandRow | undefined;
      if (existing) {
        if (existing.payload !== payloadJson || existing.type !== type) {
          throw new ApiError("IDEMPOTENCY_CONFLICT", `幂等键 "${key}" 已用于不同内容的命令`, 409);
        }
        const result = JSON.parse(existing.result);
        this.db.exec("COMMIT");
        return { ...result, replayed: true };
      }
      const seq = Number(this.db.prepare("INSERT INTO commands(type, idempotency_key, payload, result) VALUES (?, ?, ?, '')").run(type, key, payloadJson).lastInsertRowid);
      const result = run(seq);
      this.db.prepare("UPDATE commands SET result = ? WHERE seq = ?").run(JSON.stringify(result), seq);
      this.db.exec("COMMIT");
      return { ...result, replayed: false };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  submitLimitOrder(input: { idempotencyKey: string; side: Side; price: number; qty: number }): SubmitResult {
    const side = validateSide(input.side);
    const { price, qty } = validatePriceQty(input.price, input.qty);
    return this.executeCommand<SubmitResult>("submit", input.idempotencyKey, { side, price, qty }, (seq) => {
      const orderId = Number(this.db.prepare(
        "INSERT INTO orders(command_seq, side, price, qty) VALUES (?, ?, ?, ?)"
      ).run(seq, side, price, qty).lastInsertRowid);

      const trades: TradeRow[] = [];
      let takerRemaining = qty;
      // 买单匹配最低卖价（<= 限价），卖单匹配最高买价（>= 限价）；同价按 order_id（接受序号）FIFO。
      const matchSql = side === "buy"
        ? "SELECT * FROM orders WHERE side='sell' AND price <= ? AND filled + canceled < qty ORDER BY price ASC, order_id ASC"
        : "SELECT * FROM orders WHERE side='buy' AND price >= ? AND filled + canceled < qty ORDER BY price DESC, order_id ASC";
      const matches = this.db.prepare(matchSql).all(price) as unknown as OrderRow[];

      for (const maker of matches) {
        if (takerRemaining <= 0) break;
        const makerRemaining = remaining(maker);
        if (makerRemaining <= 0) continue;
        const tradeQty = Math.min(takerRemaining, makerRemaining);
        const tradePrice = maker.price; // 成交价 = 被动单价格
        const tradeId = Number(this.db.prepare(
          "INSERT INTO trades(command_seq, buy_order_id, sell_order_id, price, qty) VALUES (?, ?, ?, ?, ?)"
        ).run(seq, side === "buy" ? orderId : maker.order_id, side === "buy" ? maker.order_id : orderId, tradePrice, tradeQty).lastInsertRowid);
        this.db.prepare("UPDATE orders SET filled = filled + ? WHERE order_id = ?").run(tradeQty, maker.order_id);
        takerRemaining -= tradeQty;
        const trade: TradeRow = {
          trade_id: tradeId, command_seq: seq,
          buy_order_id: side === "buy" ? orderId : maker.order_id,
          sell_order_id: side === "buy" ? maker.order_id : orderId,
          price: tradePrice, qty: tradeQty,
        };
        trades.push(trade);
        this.recordEvent(seq, "trade", trade);
        const makerAfter = this.getOrder(maker.order_id);
        this.recordEvent(seq, "order_updated", { orderId: maker.order_id, filled: makerAfter.filled, remaining: remaining(makerAfter), status: orderStatus(makerAfter) });
      }

      this.db.prepare("UPDATE orders SET filled = filled + ? WHERE order_id = ?").run(qty - takerRemaining, orderId);
      const finalOrder = this.getOrder(orderId);
      const status = orderStatus(finalOrder);
      this.recordEvent(seq, "order_accepted", { orderId, side, price, qty, filled: finalOrder.filled, remaining: remaining(finalOrder), status });
      return { commandSeq: seq, orderId, status, filled: finalOrder.filled, remaining: remaining(finalOrder), trades, replayed: false };
    });
  }

  cancelOrder(input: { idempotencyKey: string; orderId: number }): CancelResult {
    if (!Number.isSafeInteger(input.orderId) || input.orderId <= 0) {
      throw new ApiError("VALIDATION_ERROR", "orderId 必须是正整数");
    }
    const orderId = input.orderId;
    return this.executeCommand<CancelResult>("cancel", input.idempotencyKey, { orderId }, (seq) => {
      const order = this.getOrder(orderId);
      const rem = remaining(order);
      if (rem > 0) {
        this.db.prepare("UPDATE orders SET canceled = canceled + ? WHERE order_id = ?").run(rem, orderId);
      }
      const after = this.getOrder(orderId);
      const status = orderStatus(after);
      this.recordEvent(seq, "order_canceled", { orderId, canceledQty: rem, filled: after.filled, remaining: remaining(after), status });
      return { commandSeq: seq, orderId, canceledQty: rem, status, filled: after.filled, remaining: remaining(after), replayed: false };
    });
  }

  getOrderView(orderId: number) {
    const o = this.getOrder(orderId);
    return {
      orderId: o.order_id, commandSeq: o.command_seq, side: o.side, price: o.price, qty: o.qty,
      filled: o.filled, canceled: o.canceled, remaining: remaining(o), status: orderStatus(o),
    };
  }

  getTrades(orderId?: number): TradeRow[] {
    if (orderId !== undefined) {
      return this.db.prepare("SELECT * FROM trades WHERE buy_order_id = ? OR sell_order_id = ? ORDER BY trade_id").all(orderId, orderId) as unknown as TradeRow[];
    }
    return this.db.prepare("SELECT * FROM trades ORDER BY trade_id").all() as unknown as TradeRow[];
  }

  getBook() {
    const rows = this.db.prepare(
      "SELECT side, price, SUM(qty - filled - canceled) AS qty, COUNT(*) AS orders FROM orders WHERE filled + canceled < qty GROUP BY side, price"
    ).all() as { side: Side; price: number; qty: number; orders: number }[];
    const plain = rows.map(r => ({ side: r.side, price: r.price, qty: r.qty, orders: r.orders }));
    const bids = plain.filter(r => r.side === "buy").sort((a, b) => b.price - a.price);
    const asks = plain.filter(r => r.side === "sell").sort((a, b) => a.price - b.price);
    return { bids, asks };
  }

  getEvents(fromEventId = 0) {
    return (this.db.prepare("SELECT * FROM events WHERE event_id > ? ORDER BY event_id").all(fromEventId) as { event_id: number; command_seq: number; type: string; data: string }[])
      .map(e => ({ eventId: e.event_id, commandSeq: e.command_seq, type: e.type, data: JSON.parse(e.data) }));
  }

  // 校验当前订单簿不变量，返回问题列表（空数组 = 通过）。
  checkInvariants(): string[] {
    const problems: string[] = [];
    const orders = this.db.prepare("SELECT * FROM orders").all() as unknown as OrderRow[];
    for (const o of orders) {
      if (o.filled + o.canceled > o.qty) problems.push(`订单 ${o.order_id}: filled+canceled > qty`);
    }
    const trades = this.db.prepare("SELECT * FROM trades ORDER BY trade_id").all() as unknown as TradeRow[];
    const buySum = new Map<number, number>(); const sellSum = new Map<number, number>();
    for (const t of trades) {
      buySum.set(t.buy_order_id, (buySum.get(t.buy_order_id) ?? 0) + t.qty);
      sellSum.set(t.sell_order_id, (sellSum.get(t.sell_order_id) ?? 0) + t.qty);
    }
    for (const o of orders) {
      const traded = o.side === "buy" ? buySum.get(o.order_id) ?? 0 : sellSum.get(o.order_id) ?? 0;
      if (traded !== o.filled) problems.push(`订单 ${o.order_id}: 成交量 ${traded} != filled ${o.filled}`);
    }
    const book = this.getBook();
    const bestBid = book.bids[0]?.price; const bestAsk = book.asks[0]?.price;
    if (bestBid !== undefined && bestAsk !== undefined && bestBid >= bestAsk) {
      problems.push(`盘口交叉: 最优买价 ${bestBid} >= 最优卖价 ${bestAsk}`);
    }
    return problems;
  }
}

