import express from 'express';
import bodyParser from 'body-parser';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 10000;
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage');
const DATA_DIR = path.join(STORAGE_DIR, 'data');
const SESSIONS_DIR = path.join(STORAGE_DIR, 'sessions');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const RULES_FILE = path.join(DATA_DIR, 'rules.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');

app.use(bodyParser.json({ limit: '2mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

const browsers = new Map();

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  for (const [file, fallback] of [[ACCOUNTS_FILE, []], [RULES_FILE, []], [LOGS_FILE, []]]) {
    try { await fs.access(file); } catch { await fs.writeFile(file, JSON.stringify(fallback, null, 2)); }
  }
}
async function readJson(file, fallback=[]) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}
async function addLog(accountId, status, message, meta={}) {
  const logs = await readJson(LOGS_FILE, []);
  logs.unshift({ id: Date.now().toString(), accountId, status, message, meta, createdAt: new Date().toISOString() });
  await writeJson(LOGS_FILE, logs.slice(0, 500));
}
function sessionPath(accountId) { return path.join(SESSIONS_DIR, `${accountId}.json`); }
async function hasSession(accountId) {
  try { await fs.access(sessionPath(accountId)); return true; } catch { return false; }
}
async function getAccount(id) {
  const accounts = await readJson(ACCOUNTS_FILE, []);
  return accounts.find(a => String(a.id) === String(id));
}
async function closeBrowser(id) {
  const item = browsers.get(String(id));
  if (item) {
    try { await item.context?.close(); } catch {}
    try { await item.browser?.close(); } catch {}
    browsers.delete(String(id));
  }
}

app.get('/healthz', async (req, res) => res.json({ ok: true, app: 'ig-remote-browser-agent' }));

app.get('/api/accounts', async (req, res) => {
  const accounts = await readJson(ACCOUNTS_FILE, []);
  const enriched = await Promise.all(accounts.map(async a => ({ ...a, hasSession: await hasSession(a.id), browserOpen: browsers.has(String(a.id)) })));
  res.json({ accounts: enriched });
});
app.post('/api/accounts', async (req, res) => {
  const username = String(req.body.username || '').trim().replace('@','');
  if (!username) return res.status(400).json({ ok:false, error:'username_required' });
  const accounts = await readJson(ACCOUNTS_FILE, []);
  const existing = accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
  if (existing) return res.json({ ok:true, account: existing });
  const account = { id: Date.now(), username, active: true, createdAt: new Date().toISOString() };
  accounts.push(account);
  await writeJson(ACCOUNTS_FILE, accounts);
  await addLog(account.id, 'account_created', `@${username}`);
  res.json({ ok:true, account });
});
app.delete('/api/accounts/:id', async (req, res) => {
  const id = String(req.params.id);
  await closeBrowser(id);
  const accounts = (await readJson(ACCOUNTS_FILE, [])).filter(a => String(a.id) !== id);
  const rules = (await readJson(RULES_FILE, [])).filter(r => String(r.accountId) !== id);
  await writeJson(ACCOUNTS_FILE, accounts);
  await writeJson(RULES_FILE, rules);
  try { await fs.rm(sessionPath(id), { force:true }); } catch {}
  await addLog(id, 'account_deleted', `account ${id}`);
  res.json({ ok:true });
});

app.post('/api/browser/:id/start', async (req, res) => {
  const id = String(req.params.id);
  const account = await getAccount(id);
  if (!account) return res.status(404).json({ ok:false, error:'account_not_found' });
  try {
    if (browsers.has(id)) return res.json({ ok:true, alreadyOpen:true });
    let browser;
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes('Executable doesn') || msg.includes('Please run the following command')) {
        console.warn('[playwright] browser executable missing, installing chromium at runtime...');
        execFileSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
      } else {
        throw err;
      }
    }
    const storageState = await hasSession(id) ? sessionPath(id) : undefined;
    const context = await browser.newContext({
      storageState,
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    browsers.set(id, { browser, context, page, lastActivity: Date.now() });
    await addLog(id, 'browser_opened', 'Remote Browser opened');
    res.json({ ok:true });
  } catch (error) {
    await addLog(id, 'browser_error', error.message);
    res.status(500).json({ ok:false, error:error.message });
  }
});
app.post('/api/browser/:id/goto', async (req, res) => {
  const item = browsers.get(String(req.params.id));
  if (!item) return res.status(404).json({ ok:false, error:'browser_not_open' });
  const url = String(req.body.url || 'https://www.instagram.com/');
  await item.page.goto(url, { waitUntil:'domcontentloaded' });
  res.json({ ok:true });
});
app.get('/api/browser/:id/screenshot', async (req, res) => {
  const item = browsers.get(String(req.params.id));
  if (!item) return res.status(404).send('browser_not_open');
  try {
    const buf = await item.page.screenshot({ type: 'jpeg', quality: 70 });
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (error) { res.status(500).send(error.message); }
});
app.post('/api/browser/:id/click', async (req, res) => {
  const item = browsers.get(String(req.params.id));
  if (!item) return res.status(404).json({ ok:false, error:'browser_not_open' });
  const vp = item.page.viewportSize() || { width:390, height:844 };
  const x = Number(req.body.x || 0) * vp.width / Number(req.body.width || vp.width);
  const y = Number(req.body.y || 0) * vp.height / Number(req.body.height || vp.height);
  await item.page.mouse.click(x, y);
  res.json({ ok:true });
});
app.post('/api/browser/:id/type', async (req, res) => {
  const item = browsers.get(String(req.params.id));
  if (!item) return res.status(404).json({ ok:false, error:'browser_not_open' });
  await item.page.keyboard.type(String(req.body.text || ''), { delay: 30 });
  res.json({ ok:true });
});
app.post('/api/browser/:id/press', async (req, res) => {
  const item = browsers.get(String(req.params.id));
  if (!item) return res.status(404).json({ ok:false, error:'browser_not_open' });
  await item.page.keyboard.press(String(req.body.key || 'Enter'));
  res.json({ ok:true });
});
app.post('/api/browser/:id/save-session', async (req, res) => {
  const id = String(req.params.id);
  const item = browsers.get(id);
  if (!item) return res.status(404).json({ ok:false, error:'browser_not_open' });
  await item.context.storageState({ path: sessionPath(id) });
  await addLog(id, 'session_saved', 'Session/cookies saved');
  res.json({ ok:true });
});
app.post('/api/browser/:id/close', async (req, res) => {
  await closeBrowser(String(req.params.id));
  res.json({ ok:true });
});

app.get('/api/rules', async (req,res)=>res.json({ rules: await readJson(RULES_FILE, []) }));
app.post('/api/rules', async (req,res)=>{
  const rules = await readJson(RULES_FILE, []);
  const rule = { id: Date.now(), accountId: req.body.accountId, keyword: String(req.body.keyword||'').trim().toLowerCase(), reply: String(req.body.reply||'').trim(), active: true };
  if (!rule.accountId || !rule.keyword || !rule.reply) return res.status(400).json({ ok:false, error:'account_keyword_reply_required' });
  rules.push(rule); await writeJson(RULES_FILE, rules); res.json({ ok:true, rule });
});
app.delete('/api/rules/:id', async (req,res)=>{
  const rules = (await readJson(RULES_FILE, [])).filter(r => String(r.id)!==String(req.params.id));
  await writeJson(RULES_FILE, rules); res.json({ ok:true });
});
app.get('/api/logs', async (req,res)=>res.json({ logs: await readJson(LOGS_FILE, []) }));

app.post('/api/ai/generate', async (req,res)=>{
  const apiKey = process.env.OPENAI_API_KEY;
  const topic = String(req.body.topic || 'reply').slice(0,200);
  const tone = String(req.body.tone || 'friendly').slice(0,50);
  if (!apiKey) {
    return res.json({ ok:true, fallback:true, replies:[
      'Спасибо за сообщение! Сейчас отправим подробности 🙌',
      'Здравствуйте! Уже готовлю информацию для вас 👌',
      'Спасибо за интерес! Напишем вам детали в сообщении 📩'
    ]});
  }
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${apiKey}` },
      body: JSON.stringify({ model:'gpt-4o-mini', messages:[{role:'system', content:'Generate short natural Instagram replies in Russian. Return JSON array only.'},{role:'user', content:`Topic: ${topic}. Tone: ${tone}. Generate 5 variants under 120 chars.`}], temperature:0.8 })
    });
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '[]';
    let replies; try { replies = JSON.parse(text); } catch { replies = text.split('\n').filter(Boolean); }
    res.json({ ok:true, replies });
  } catch(error){ res.status(500).json({ ok:false, error:error.message }); }
});

app.get('*', (req,res)=>res.sendFile(path.join(process.cwd(),'public/index.html')));

await ensureStorage();
app.listen(PORT, () => console.log(`IG Remote Browser Agent running on ${PORT}`));
