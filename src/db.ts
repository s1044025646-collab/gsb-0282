import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { RULES_VERSION } from "./types";

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS orders (
  order_id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_seq INTEGER NOT NULL REFERENCES commands(seq),
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  price INTEGER NOT NULL CHECK (price > 0),
  qty INTEGER NOT NULL CHECK (qty > 0),
  filled INTEGER NOT NULL DEFAULT 0,
  canceled INTEGER NOT NULL DEFAULT 0,
  CHECK (filled + canceled <= qty)
);

CREATE TABLE IF NOT EXISTS trades (
  trade_id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_seq INTEGER NOT NULL REFERENCES commands(seq),
  buy_order_id INTEGER NOT NULL REFERENCES orders(order_id),
  sell_order_id INTEGER NOT NULL REFERENCES orders(order_id),
  price INTEGER NOT NULL CHECK (price > 0),
  qty INTEGER NOT NULL CHECK (qty > 0)
);

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_seq INTEGER NOT NULL REFERENCES commands(seq),
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
`;

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES('rules_version', ?)").run(RULES_VERSION);
  const stored = db.prepare("SELECT value FROM meta WHERE key='rules_version'").get() as { value: string };
  if (stored.value !== RULES_VERSION) {
    throw new Error(`规则版本不兼容: 数据库=${stored.value}, 当前=${RULES_VERSION}`);
  }
  return db;
}

export function defaultDataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), "data");
}

export function defaultDbFile(): string {
  return process.env.DB_FILE || path.join(defaultDataDir(), "orderbook.db");
}
