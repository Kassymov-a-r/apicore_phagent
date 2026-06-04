import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || process.env.RENDER_DISK_PATH || path.join(process.cwd(), 'data');
const JSON_DB_PATH = process.env.JSON_DB_PATH || path.join(DATA_DIR, 'ig-agent-db.json');

let pool = null;
let usingJson = false;
let jsonDb = null;

function hasPg() { return !!process.env.DATABASE_URL && !usingJson; }
function now() { return new Date().toISOString(); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function intId(v) { return Number.parseInt(String(v), 10); }
function parseJsonMaybe(v) { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } }
function cleanSql(s='') { return String(s).replace(/\s+/g, ' ').trim().toLowerCase(); }

const emptyDb = () => ({
  counters: {
    settings: 0,
    instagram_accounts: 0,
    automation_rules: 0,
    webhook_events: 0,
    processed_items: 0,
    activity_logs: 0
  },
  settings: [],
  instagram_accounts: [],
  automation_rules: [],
  webhook_events: [],
  processed_items: [],
  activity_logs: []
});

async function ensureJsonDb() {
  if (jsonDb) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(JSON_DB_PATH, 'utf8');
    jsonDb = JSON.parse(raw);
  } catch {
    jsonDb = emptyDb();
    await saveJsonDb();
  }
  for (const [k, v] of Object.entries(emptyDb())) {
    if (!(k in jsonDb)) jsonDb[k] = clone(v);
  }
}

async function saveJsonDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(JSON_DB_PATH, JSON.stringify(jsonDb, null, 2), 'utf8');
}

function nextId(table) {
  jsonDb.counters[table] = Number(jsonDb.counters[table] || 0) + 1;
  return jsonDb.counters[table];
}

function rowsResult(rows = []) { return { rows: clone(rows), rowCount: rows.length }; }
function oneResult(row, inserted = true) { return { rows: row ? [clone(row)] : [], rowCount: row && inserted ? 1 : 0 }; }

async function qJson(text, params = []) {
  await ensureJsonDb();
  const sql = cleanSql(text);

  if (sql === 'select 1') return rowsResult([{ '?column?': 1 }]);

  // settings
  if (sql.startsWith('select key,value from settings')) return rowsResult(jsonDb.settings.map(({ key, value }) => ({ key, value })));
  if (sql.startsWith('select key,value,updated_at from settings')) {
    return rowsResult([...jsonDb.settings].sort((a,b)=>a.key.localeCompare(b.key)));
  }
  if (sql.startsWith('delete from settings where key=')) {
    const before = jsonDb.settings.length;
    jsonDb.settings = jsonDb.settings.filter(r => r.key !== params[0]);
    await saveJsonDb();
    return { rows: [], rowCount: before - jsonDb.settings.length };
  }
  if (sql.startsWith('insert into settings')) {
    const [key, value] = params;
    let row = jsonDb.settings.find(r => r.key === key);
    if (!row) {
      row = { key, value, updated_at: now() };
      jsonDb.settings.push(row);
    } else {
      row.value = value;
      row.updated_at = now();
    }
    await saveJsonDb();
    return oneResult(row);
  }

  // instagram_accounts
  if (sql.startsWith('insert into instagram_accounts')) {
    const [ig_user_id, username, account_type, access_token, token_expires_at, connection_method] = params;
    let row = jsonDb.instagram_accounts.find(r => String(r.ig_user_id) === String(ig_user_id));
    if (!row) {
      row = { id: nextId('instagram_accounts'), ig_user_id: String(ig_user_id), username, account_type, access_token, token_expires_at, active: true, connection_method, created_at: now(), updated_at: now() };
      jsonDb.instagram_accounts.push(row);
    } else {
      row.username = username;
      row.account_type = account_type;
      row.access_token = access_token;
      row.token_expires_at = token_expires_at;
      row.active = true;
      row.connection_method = connection_method;
      row.updated_at = now();
    }
    await saveJsonDb();
    return oneResult(row);
  }
  if (sql.startsWith('select id,ig_user_id,username,account_type,active,connection_method,token_expires_at,created_at,updated_at from instagram_accounts')) {
    return rowsResult([...jsonDb.instagram_accounts].sort((a,b)=>b.id-a.id).map(({ id, ig_user_id, username, account_type, active, connection_method, token_expires_at, created_at, updated_at }) => ({ id, ig_user_id, username, account_type, active, connection_method, token_expires_at, created_at, updated_at })));
  }
  if (sql.startsWith('select * from instagram_accounts where id=')) {
    return rowsResult(jsonDb.instagram_accounts.filter(r => r.id === intId(params[0])));
  }
  if (sql.startsWith('select * from instagram_accounts where ig_user_id=')) {
    return rowsResult(jsonDb.instagram_accounts.filter(r => String(r.ig_user_id) === String(params[0]) && r.active).slice(0,1));
  }
  if (sql.startsWith('select * from instagram_accounts where active=true')) {
    return rowsResult([...jsonDb.instagram_accounts].filter(r => r.active).sort((a,b)=>b.id-a.id));
  }
  if (sql.startsWith('update instagram_accounts set access_token=')) {
    const [access_token, token_expires_at, id] = params;
    const row = jsonDb.instagram_accounts.find(r => r.id === intId(id));
    if (row) { row.access_token = access_token; row.token_expires_at = token_expires_at; row.updated_at = now(); await saveJsonDb(); }
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('delete from instagram_accounts where id=')) {
    const id = intId(params[0]);
    const before = jsonDb.instagram_accounts.length;
    jsonDb.instagram_accounts = jsonDb.instagram_accounts.filter(r => r.id !== id);
    jsonDb.automation_rules = jsonDb.automation_rules.filter(r => r.account_id !== id);
    jsonDb.processed_items = jsonDb.processed_items.filter(r => r.account_id !== id);
    jsonDb.activity_logs = jsonDb.activity_logs.map(r => r.account_id === id ? { ...r, account_id: null } : r);
    await saveJsonDb();
    return { rows: [], rowCount: before - jsonDb.instagram_accounts.length };
  }

  // automation_rules
  if (sql.startsWith('select r.*, a.username from automation_rules')) {
    const rows = [...jsonDb.automation_rules].sort((a,b)=>b.id-a.id).map(r => ({ ...r, username: jsonDb.instagram_accounts.find(a=>a.id===r.account_id)?.username || null }));
    return rowsResult(rows);
  }
  if (sql.startsWith('insert into automation_rules')) {
    const [account_id, name, enabled, keywords, public_replies, dm_replies, reply_to_comments, reply_to_dm] = params;
    const row = { id: nextId('automation_rules'), account_id: intId(account_id), name, enabled: !!enabled, keywords: keywords || [], public_replies: public_replies || [], dm_replies: dm_replies || [], reply_to_comments: !!reply_to_comments, reply_to_dm: !!reply_to_dm, created_at: now(), updated_at: now() };
    jsonDb.automation_rules.push(row);
    await saveJsonDb();
    return oneResult(row);
  }
  if (sql.startsWith('delete from automation_rules where id=')) {
    const before = jsonDb.automation_rules.length;
    jsonDb.automation_rules = jsonDb.automation_rules.filter(r => r.id !== intId(params[0]));
    await saveJsonDb();
    return { rows: [], rowCount: before - jsonDb.automation_rules.length };
  }
  if (sql.startsWith('select * from automation_rules where account_id=')) {
    return rowsResult(jsonDb.automation_rules.filter(r => r.account_id === intId(params[0]) && r.enabled).sort((a,b)=>b.id-a.id));
  }
  if (sql.startsWith('select r.id,r.name,r.keywords,a.username from automation_rules')) {
    const rows = jsonDb.automation_rules.filter(r=>r.enabled).map(r => ({ id:r.id, name:r.name, keywords:r.keywords, username: jsonDb.instagram_accounts.find(a=>a.id===r.account_id)?.username || null }));
    return rowsResult(rows);
  }

  // webhook_events
  if (sql.startsWith('insert into webhook_events')) {
    const [object_type, raw_event, entry_count, change_fields, messaging_count] = params;
    const row = { id: nextId('webhook_events'), object_type, raw_event: parseJsonMaybe(raw_event), entry_count, change_fields: change_fields || [], messaging_count, processed_count: 0, status: 'received', error: null, created_at: now() };
    jsonDb.webhook_events.push(row);
    await saveJsonDb();
    return oneResult({ id: row.id });
  }
  if (sql.startsWith('update webhook_events set status=')) {
    const [status, error, id] = params;
    const row = jsonDb.webhook_events.find(r => r.id === intId(id));
    if (row) { row.status = status; row.error = error; await saveJsonDb(); }
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('update webhook_events set processed_count=')) {
    const [processed_count, status, id] = params;
    const row = jsonDb.webhook_events.find(r => r.id === intId(id));
    if (row) { row.processed_count = processed_count; row.status = status; await saveJsonDb(); }
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('select id,object_type,entry_count,change_fields,messaging_count,processed_count,status,error,created_at from webhook_events')) {
    const rows = [...jsonDb.webhook_events].sort((a,b)=>b.id-a.id).slice(0,100).map(({ id, object_type, entry_count, change_fields, messaging_count, processed_count, status, error, created_at }) => ({ id, object_type, entry_count, change_fields, messaging_count, processed_count, status, error, created_at }));
    return rowsResult(rows);
  }
  if (sql.startsWith('select * from webhook_events where id=')) {
    return rowsResult(jsonDb.webhook_events.filter(r => r.id === intId(params[0])));
  }

  // activity_logs
  if (sql.startsWith('insert into activity_logs')) {
    const [account_id,event_id,source,status,username,sender_id,comment_id,media_id,message_id,textVal,response,reason,raw] = params;
    const row = { id: nextId('activity_logs'), account_id: account_id == null ? null : intId(account_id), event_id: event_id == null ? null : intId(event_id), source, status, username, sender_id, comment_id, media_id, message_id, text: textVal, response, reason, raw: parseJsonMaybe(raw), created_at: now() };
    jsonDb.activity_logs.push(row);
    await saveJsonDb();
    return oneResult(row);
  }
  if (sql.startsWith('select * from activity_logs where id=')) {
    return rowsResult(jsonDb.activity_logs.filter(r => r.id === intId(params[0])));
  }
  if (sql.startsWith('select * from activity_logs')) {
    return rowsResult([...jsonDb.activity_logs].sort((a,b)=>b.id-a.id).slice(0,150));
  }

  // processed_items
  if (sql.startsWith('insert into processed_items')) {
    const [account_id, external_id, source] = params;
    const exists = jsonDb.processed_items.find(r => r.account_id === intId(account_id) && String(r.external_id) === String(external_id) && r.source === source);
    if (exists) return { rows: [], rowCount: 0 };
    const row = { id: nextId('processed_items'), account_id: intId(account_id), external_id: String(external_id), source, created_at: now() };
    jsonDb.processed_items.push(row);
    await saveJsonDb();
    return oneResult(row);
  }

  throw new Error(`JSON database does not support this query yet: ${text}`);
}

export async function initDb() {
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    const schema = await fs.readFile(path.join(__dirname, '../sql/schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('Database mode: PostgreSQL');
    return;
  }
  usingJson = true;
  await ensureJsonDb();
  console.log(`Database mode: local JSON fallback (${JSON_DB_PATH})`);
}

export async function q(text, params = []) {
  if (hasPg()) return pool.query(text, params);
  return qJson(text, params);
}

export function dbInfo() {
  return process.env.DATABASE_URL && !usingJson
    ? { mode: 'postgres', configured: true }
    : { mode: 'json_fallback', configured: false, path: JSON_DB_PATH };
}
