import type {
  BookLevel,
  BookSnapshot,
  Order,
  OrderStatus,
  Side,
  SYMBOL as SymbolType,
  Trade,
} from './types.ts';
import { SYMBOL } from './types.ts';

interface MakerOrder extends Order {
  remaining: number;
}

export interface MatchOutcome {
  order: MakerOrder;
  trades: Trade[];
}

/**
 * 纯内存、确定性的单品限价撮合簿。
 * 所有价格/数量均为整数，价格比较不涉及浮点。
 * 队列顺序只由 commandSeq（接受序号）决定，同价 FIFO。
 */
export class MatchingEngine {
  private bids = new Map<number, MakerOrder[]>();
  private asks = new Map<number, MakerOrder[]>();

  private book(side: Side): Map<number, MakerOrder[]> {
    return side === 'BUY' ? this.asks : this.bids;
  }

  private static prune(level: MakerOrder[]): void {
    while (level.length > 0 && level[0]!.remaining === 0) {
      level.shift();
    }
  }

  private remainingOrder(side: Side, orderId: string): MakerOrder | undefined {
    for (const level of this.book(side).values()) {
      const found = level.find((o) => o.orderId === orderId && o.remaining > 0);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * 放入一张主动限价单并连续撮合。
   * 买入：从最低卖价开始，只吃 askPrice <= limit 的挂单；
   * 卖出：从最高买价开始，只吃 bidPrice >= limit 的挂单。
   * 成交价始终等于先前已在簿的被动单价格。
   */
  place(order: Order): MatchOutcome {
    const taker: MakerOrder = { ...order, remaining: order.origQty };
    const trades: Trade[] = [];
    const opposite = this.book(taker.side);
    let seqInCommand = 0;

    const crossable = (makerPrice: number): boolean =>
      taker.side === 'BUY' ? makerPrice <= taker.price : makerPrice >= taker.price;

    while (taker.remaining > 0) {
      let prices = [...opposite.keys()];
      prices = prices
        .filter(crossable)
        .sort((a, b) => (taker.side === 'BUY' ? a - b : b - a));
      const bestPrice = prices[0];
      if (bestPrice === undefined) break;
      const level = opposite.get(bestPrice)!;
      MatchingEngine.prune(level);
      if (level.length === 0) {
        opposite.delete(bestPrice);
        continue;
      }
      // 同价队列严格按接受序号 FIFO（插入时有序，这里做防御性排序）。
      level.sort((a, b) => a.commandSeq - b.commandSeq);
      const maker = level[0]!;
      if (maker.remaining <= 0) continue;
      const qty = Math.min(taker.remaining, maker.remaining);
      taker.remaining -= qty;
      maker.remaining -= qty;
      seqInCommand += 1;
      trades.push({
        tradeId: `T${order.commandSeq}-${seqInCommand}`,
        commandSeq: order.commandSeq,
        seqInCommand,
        takerOrderId: taker.orderId,
        makerOrderId: maker.orderId,
        price: maker.price,
        qty,
        takerSide: taker.side,
      });
      if (maker.remaining === 0) {
        level.shift();
        if (level.length === 0) opposite.delete(bestPrice);
      }
    }

    if (taker.remaining > 0) {
      const own = taker.side === 'BUY' ? this.bids : this.asks;
      const level = own.get(taker.price) ?? [];
      level.push(taker);
      level.sort((a, b) => a.commandSeq - b.commandSeq);
      own.set(taker.price, level);
    }

    return { order: taker, trades };
  }

  /** 撤销某订单尚未成交的剩余量，返回实际撤销数量（重复撤单返回 0）。 */
  cancel(side: Side, orderId: string): number {
    const order = this.remainingOrder(side, orderId);
    if (!order) return 0;
    const qty = order.remaining;
    order.remaining = 0;
    const own = order.side === 'BUY' ? this.bids : this.asks;
    const level = own.get(order.price)!;
    const idx = level.indexOf(order);
    if (idx >= 0) level.splice(idx, 1);
    if (level.length === 0) own.delete(order.price);
    return qty;
  }

  private aggregate(map: Map<number, MakerOrder[]>, desc: boolean): BookLevel[] {
    const levels: BookLevel[] = [];
    for (const [price, rawLevel] of map) {
      const level = rawLevel.filter((o) => o.remaining > 0);
      if (level.length === 0) continue;
      levels.push({
        price,
        remainingQty: level.reduce((sum, o) => sum + o.remaining, 0),
        orderCount: level.length,
      });
    }
    levels.sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
    return levels;
  }

  snapshot(): BookSnapshot {
    return {
      symbol: SYMBOL,
      bids: this.aggregate(this.bids, true),
      asks: this.aggregate(this.asks, false),
    };
  }

  /** 不变量：撮合完成后，盘口不得存在可立即交叉的买卖价。 */
  isCrossed(): boolean {
    const snap = this.snapshot();
    if (snap.bids.length === 0 || snap.asks.length === 0) return false;
    return snap.bids[0]!.price >= snap.asks[0]!.price;
  }
}
