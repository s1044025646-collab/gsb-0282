import { openDatabase, defaultDbFile } from "./db";
import { Engine } from "./engine";
import { replayVerify } from "./replay";
import { ApiError } from "./types";

const USAGE = `用法: node dist/src/cli.js <命令> [参数]
命令:
  submit --key <幂等键> --side buy|sell --price <正整数> --qty <正整数>
  cancel --key <幂等键> --order <订单ID>
  order --id <订单ID>
  trades [--order <订单ID>]
  book
  events [--from <事件ID>]
  replay
  invariants
环境变量: DB_FILE (默认 data/orderbook.db), DATA_DIR`;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i] ?? "";
  }
  return out;
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.log(USAGE);
    process.exit(1);
  }
  const args = parseArgs(rest);
  const db = openDatabase(defaultDbFile());
  const engine = new Engine(db);
  try {
    switch (cmd) {
      case "submit":
        console.log(JSON.stringify(engine.submitLimitOrder({
          idempotencyKey: args.key, side: args.side as "buy" | "sell",
          price: Number(args.price), qty: Number(args.qty),
        }), null, 2));
        break;
      case "cancel":
        console.log(JSON.stringify(engine.cancelOrder({ idempotencyKey: args.key, orderId: Number(args.order) }), null, 2));
        break;
      case "order":
        console.log(JSON.stringify(engine.getOrderView(Number(args.id)), null, 2));
        break;
      case "trades":
        console.log(JSON.stringify(engine.getTrades(args.order ? Number(args.order) : undefined), null, 2));
        break;
      case "book":
        console.log(JSON.stringify(engine.getBook(), null, 2));
        break;
      case "events":
        console.log(JSON.stringify(engine.getEvents(Number(args.from ?? "0")), null, 2));
        break;
      case "replay":
        console.log(JSON.stringify(replayVerify(db), null, 2));
        break;
      case "invariants": {
        const problems = engine.checkInvariants();
        console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
        if (problems.length) process.exitCode = 1;
        break;
      }
      default:
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(JSON.stringify({ error: { code: err.code, message: err.message } }));
      process.exit(2);
    }
    throw err;
  } finally {
    db.close();
  }
}

main();
