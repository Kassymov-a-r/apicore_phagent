import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.SQLITE_PATH || 'storage/data.sqlite';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      session_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      name TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      comment_replies TEXT NOT NULL DEFAULT '[]',
      dm_replies TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      level TEXT NOT NULL DEFAULT 'info',
      status TEXT NOT NULL,
      actor TEXT,
      text TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reply_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      hour_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(account_id, hour_key)
    );

    CREATE TABLE IF NOT EXISTS processed_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      message_key TEXT NOT NULL UNIQUE,
      text TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export function logEvent({ accountId = null, level = 'info', status, actor = null, text = null, details = null }) {
  db.prepare(`INSERT INTO logs(account_id, level, status, actor, text, details) VALUES(?,?,?,?,?,?)`)
    .run(accountId, level, status, actor, text, typeof details === 'string' ? details : details ? JSON.stringify(details) : null);
}

export function parseJson(value, fallback = []) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}
