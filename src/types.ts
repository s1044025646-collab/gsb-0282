export type Side = 'BUY' | 'SELL';

export type OrderStatus = 'ACTIVE' | 'FILLED' | 'CANCELLED';

/** 撮合规则版本：改变撮合语义时升级。 */
export const RULES_VERSION = 'limit-fifo-v1';

/** 本服务仅模拟这一个虚构商品，不支持跨品种撮合。 */
export const SYMBOL = 'GOLDEN-APPLE';

export const LIMITS = {
  priceMin: 1,
  priceMax: 1_000_000_000,
  qtyMin: 1,
  qtyMax: 1_000_000_000,
  idemKeyMax: 64,
} as const;

export interface Order {
  orderId: string;
  commandSeq: number;
  side: Side;
  price: number;
  origQty: number;
  filledQty: number;
  cancelledQty: number;
  status: OrderStatus;
  idemKey: string;
  createdAt: string;
}

export interface Trade {
  tradeId: string;
  commandSeq: number;
  /** 同一主动命令内的成交序号，从 1 开始。 */
  seqInCommand: number;
  takerOrderId: string;
  makerOrderId: string;
  price: number;
  qty: number;
  takerSide: Side;
}

export interface BookLevel {
  price: number;
  remainingQty: number;
  orderCount: number;
}

export interface BookSnapshot {
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface PlaceOrderInput {
  side: Side;
  price: number;
  qty: number;
  idemKey: string;
  symbol?: string;
}

export interface PlaceOrderResult {
  orderId: string;
  commandSeq: number;
  status: OrderStatus;
  remainingQty: number;
  filledQty: number;
  trades: Trade[];
  idempotentReplay: boolean;
}

export interface CancelResult {
  orderId: string;
  commandSeq: number;
  cancelledQty: number;
  remainingQty: number;
  status: OrderStatus;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
