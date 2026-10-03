import * as http from "node:http";
import { AddressInfo } from "node:net";
import { openDatabase, defaultDbFile } from "./db";
import { Engine } from "./engine";
import { replayVerify } from "./replay";
import { ApiError } from "./types";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("VALIDATION_ERROR", "请求体必须是合法 JSON");
  }
}

export function createServer(dbFile = defaultDbFile()): { server: http.Server; engine: Engine } {
  const db = openDatabase(dbFile);
  const engine = new Engine(db);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, service: "limit-order-book-sim", simulation: true });
      }
      if (method === "POST" && path === "/orders") {
        const body = await readBody(req);
        return send(res, 201, engine.submitLimitOrder({
          idempotencyKey: body.idempotencyKey as string,
          side: body.side as "buy" | "sell",
          price: body.price as number,
          qty: body.qty as number,
        }));
      }
      const cancelMatch = path.match(/^\/orders\/(\d+)\/cancel$/);
      if (method === "POST" && cancelMatch) {
        const body = await readBody(req);
        return send(res, 200, engine.cancelOrder({
          idempotencyKey: body.idempotencyKey as string,
          orderId: Number(cancelMatch[1]),
        }));
      }
      const orderMatch = path.match(/^\/orders\/(\d+)$/);
      if (method === "GET" && orderMatch) {
        return send(res, 200, engine.getOrderView(Number(orderMatch[1])));
      }
      if (method === "GET" && path === "/trades") {
        const orderId = url.searchParams.get("orderId");
        return send(res, 200, engine.getTrades(orderId ? Number(orderId) : undefined));
      }
      if (method === "GET" && path === "/book") {
        return send(res, 200, engine.getBook());
      }
      if (method === "GET" && path === "/events") {
        const from = Number(url.searchParams.get("from") ?? "0");
        return send(res, 200, engine.getEvents(from));
      }
      if (method === "POST" && path === "/replay/verify") {
        return send(res, 200, replayVerify(db));
      }
      if (method === "GET" && path === "/invariants") {
        const problems = engine.checkInvariants();
        return send(res, problems.length ? 500 : 200, { ok: problems.length === 0, problems });
      }
      throw new ApiError("NOT_FOUND", `未找到路由 ${method} ${path}`, 404);
    } catch (err) {
      if (err instanceof ApiError) {
        return send(res, err.status, { error: { code: err.code, message: err.message } });
      }
      return send(res, 500, { error: { code: "INTERNAL_ERROR", message: String(err) } });
    }
  });

  return { server, engine };
}

if (require.main === module) {
  const portArg = process.argv.find(a => a.startsWith("--port="));
  const port = portArg ? Number(portArg.split("=")[1]) : Number(process.env.PORT ?? "0"); // 默认 0 = 空闲端口
  const { server } = createServer();
  server.listen(port, () => {
    const addr = server.address() as AddressInfo;
    console.log(`[模拟撮合服务] 已启动: http://127.0.0.1:${addr.port} (仅本地模拟，不连接真实交易)`);
  });
}
