export const RULES_VERSION = "1.0.0";

export const LIMITS = {
  MAX_PRICE: 1_000_000_000,
  MAX_QTY: 1_000_000_000,
  MAX_IDEMPOTENCY_KEY_LEN: 128,
} as const;

export type Side = "buy" | "sell";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export interface OrderRow {
  order_id: number;
  command_seq: number;
  side: Side;
  price: number;
  qty: number;
  filled: number;
  canceled: number;
  status: string;
}

export interface TradeRow {
  trade_id: number;
  command_seq: number;
  buy_order_id: number;
  sell_order_id: number;
  price: number;
  qty: number;
}

export function remaining(o: OrderRow): number {
  return o.qty - o.filled - o.canceled;
}

export function orderStatus(o: OrderRow): string {
  const rem = remaining(o);
  if (rem > 0) return o.filled > 0 ? "partially_filled" : "open";
  if (o.canceled > 0) return o.filled > 0 ? "canceled" : "canceled";
  return "filled";
}

export function validatePriceQty(price: unknown, qty: unknown): { price: number; qty: number } {
  if (!Number.isSafeInteger(price) || (price as number) <= 0 || (price as number) > LIMITS.MAX_PRICE) {
    throw new ApiError("VALIDATION_ERROR", `price 必须是 1..${LIMITS.MAX_PRICE} 的正整数（最小报价单位）`);
  }
  if (!Number.isSafeInteger(qty) || (qty as number) <= 0 || (qty as number) > LIMITS.MAX_QTY) {
    throw new ApiError("VALIDATION_ERROR", `qty 必须是 1..${LIMITS.MAX_QTY} 的正整数`);
  }
  return { price: price as number, qty: qty as number };
}

export function validateSide(side: unknown): Side {
  if (side !== "buy" && side !== "sell") {
    throw new ApiError("VALIDATION_ERROR", "side 必须是 \"buy\" 或 \"sell\"");
  }
  return side;
}

export function validateIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > LIMITS.MAX_IDEMPOTENCY_KEY_LEN) {
    throw new ApiError("VALIDATION_ERROR", `idempotencyKey 必须是 1..${LIMITS.MAX_IDEMPOTENCY_KEY_LEN} 字符的字符串`);
  }
  return key;
}
