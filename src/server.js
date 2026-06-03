import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, initDb, logEvent, parseJson } from './db/index.js';
import { openLogin, checkSession, startAgent, stopAgent } from './services/instagramAgent.js';
import { generateReplies } from './services/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
initDb();
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function asyncRoute(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(err => {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  });
}

app.get('/healthz', (req, res) => res.json({ ok: true, app: 'ig-playwright-agent' }));

app.get('/api/accounts', (req, res) => {
  res.json({ accounts: db.prepare('SELECT * FROM accounts ORDER BY id DESC').all() });
});

app.post('/api/accounts', (req, res) => {
  const username = String(req.body.username || '').trim().replace('@','');
  if (!username) return res.status(400).json({ ok: false, error: 'username required' });
  const sessionPath = `storage/sessions/${username}`;
  const info = db.prepare('INSERT INTO accounts(username, session_path) VALUES(?,?)').run(username, sessionPath);
  logEvent({ accountId: info.lastInsertRowid, status: 'account_created', actor: username });
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/accounts/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  await stopAgent(id).catch(() => {});
  db.prepare('DELETE FROM accounts WHERE id=?').run(id);
  res.json({ ok: true });
}));

app.post('/api/accounts/:id/login', asyncRoute(async (req, res) => res.json(await openLogin(Number(req.params.id)))));
app.post('/api/accounts/:id/check', asyncRoute(async (req, res) => res.json(await checkSession(Number(req.params.id)))));
app.post('/api/accounts/:id/start', asyncRoute(async (req, res) => res.json(await startAgent(Number(req.params.id)))));
app.post('/api/accounts/:id/stop', asyncRoute(async (req, res) => res.json(await stopAgent(Number(req.params.id)))));

app.get('/api/rules', (req, res) => {
  const rules = db.prepare(`SELECT r.*, a.username FROM rules r LEFT JOIN accounts a ON a.id=r.account_id ORDER BY r.id DESC`).all().map(r => ({
    ...r,
    keywords: parseJson(r.keywords),
    commentReplies: parseJson(r.comment_replies),
    dmReplies: parseJson(r.dm_replies)
  }));
  res.json({ rules });
});

app.post('/api/rules', (req, res) => {
  const accountId = req.body.accountId ? Number(req.body.accountId) : null;
  const name = String(req.body.name || '').trim();
  const keywords = Array.isArray(req.body.keywords) ? req.body.keywords : [];
  const commentReplies = Array.isArray(req.body.commentReplies) ? req.body.commentReplies : [];
  const dmReplies = Array.isArray(req.body.dmReplies) ? req.body.dmReplies : [];
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  db.prepare(`INSERT INTO rules(account_id,name,keywords,comment_replies,dm_replies,enabled) VALUES(?,?,?,?,?,?)`)
    .run(accountId, name, JSON.stringify(keywords), JSON.stringify(commentReplies), JSON.stringify(dmReplies), req.body.enabled === false ? 0 : 1);
  res.json({ ok: true });
});

app.delete('/api/rules/:id', (req, res) => {
  db.prepare('DELETE FROM rules WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/logs', (req, res) => {
  const logs = db.prepare(`SELECT l.*, a.username FROM logs l LEFT JOIN accounts a ON a.id=l.account_id ORDER BY l.id DESC LIMIT 200`).all();
  res.json({ logs });
});

app.post('/api/ai/generate', asyncRoute(async (req, res) => {
  res.json(await generateReplies(req.body));
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`IG Playwright Agent running on ${port}`));
