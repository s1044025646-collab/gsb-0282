import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db";
import { Engine } from "./engine";

export interface ReplayReport {
  ok: boolean;
  commandsReplayed: number;
  ordersCompared: number;
  tradesCompared: number;
  differences: string[];
}

// 从空簿按接受序号重放已保存命令，核对最终订单状态与成交序列；不修改当前库。
export function replayVerify(sourceDb: DatabaseSync): ReplayReport {
  const mem = openDatabase(":memory:");
  try {
    const engine = new Engine(mem);
    const commands = sourceDb.prepare("SELECT seq, type, payload FROM commands ORDER BY seq").all() as { seq: number; type: string; payload: string }[];
    for (const cmd of commands) {
      const payload = JSON.parse(cmd.payload);
      if (cmd.type === "submit") {
        engine.submitLimitOrder({ idempotencyKey: `replay-${cmd.seq}`, ...payload });
      } else if (cmd.type === "cancel") {
        engine.cancelOrder({ idempotencyKey: `replay-${cmd.seq}`, ...payload });
      }
    }
    const differences: string[] = [];
    const srcOrders = sourceDb.prepare("SELECT * FROM orders ORDER BY order_id").all() as Record<string, unknown>[];
    const repOrders = mem.prepare("SELECT * FROM orders ORDER BY order_id").all() as Record<string, unknown>[];
    if (srcOrders.length !== repOrders.length) differences.push(`订单数不一致: 当前=${srcOrders.length} 重放=${repOrders.length}`);
    for (let i = 0; i < Math.min(srcOrders.length, repOrders.length); i++) {
      for (const key of ["order_id", "side", "price", "qty", "filled", "canceled"]) {
        if (String(srcOrders[i][key]) !== String(repOrders[i][key])) {
          differences.push(`订单 ${srcOrders[i].order_id} 字段 ${key}: 当前=${srcOrders[i][key]} 重放=${repOrders[i][key]}`);
        }
      }
    }
    const srcTrades = sourceDb.prepare("SELECT * FROM trades ORDER BY trade_id").all() as Record<string, unknown>[];
    const repTrades = mem.prepare("SELECT * FROM trades ORDER BY trade_id").all() as Record<string, unknown>[];
    if (srcTrades.length !== repTrades.length) differences.push(`成交数不一致: 当前=${srcTrades.length} 重放=${repTrades.length}`);
    for (let i = 0; i < Math.min(srcTrades.length, repTrades.length); i++) {
      for (const key of ["trade_id", "buy_order_id", "sell_order_id", "price", "qty"]) {
        if (String(srcTrades[i][key]) !== String(repTrades[i][key])) {
          differences.push(`成交 ${srcTrades[i].trade_id} 字段 ${key}: 当前=${srcTrades[i][key]} 重放=${repTrades[i][key]}`);
        }
      }
    }
    return {
      ok: differences.length === 0,
      commandsReplayed: commands.length,
      ordersCompared: srcOrders.length,
      tradesCompared: srcTrades.length,
      differences,
    };
  } finally {
    mem.close();
  }
}
