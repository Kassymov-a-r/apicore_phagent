import { chromium } from 'playwright';
import path from 'path';
import { db, logEvent, parseJson } from '../db/index.js';

const running = new Map();

function sessionDir(account) {
  return path.resolve(account.session_path);
}

async function createContext(account, { headless = false } = {}) {
  return chromium.launchPersistentContext(sessionDir(account), {
    headless,
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
  });
}

export async function openLogin(accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
  if (!account) throw new Error('Account not found');
  const context = await createContext(account, { headless: false });
  const page = await context.newPage();
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });
  logEvent({ accountId, status: 'login_window_opened', details: 'Login manually, then close browser window or return to dashboard.' });
  return { ok: true };
}

export async function checkSession(accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
  if (!account) throw new Error('Account not found');
  const context = await createContext(account, { headless: process.env.HEADLESS === 'true' });
  const page = await context.newPage();
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const url = page.url();
  const loggedIn = !url.includes('/accounts/login');
  db.prepare('UPDATE accounts SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(loggedIn ? 'session_ok' : 'login_required', accountId);
  await context.close();
  logEvent({ accountId, status: loggedIn ? 'session_ok' : 'login_required' });
  return { ok: loggedIn, status: loggedIn ? 'session_ok' : 'login_required' };
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').trim();
}

function matchRule(accountId, text) {
  const rows = db.prepare('SELECT * FROM rules WHERE enabled=1 AND (account_id IS NULL OR account_id=?) ORDER BY id DESC').all(accountId);
  const ntext = normalize(text);
  for (const rule of rows) {
    const keywords = parseJson(rule.keywords, []);
    for (const kw of keywords) {
      if (kw && ntext.includes(normalize(kw))) return { rule, keyword: kw };
    }
  }
  return null;
}

function canReply(accountId) {
  const max = Number(process.env.MAX_REPLIES_PER_ACCOUNT_PER_HOUR || 20);
  const hour = new Date().toISOString().slice(0, 13);
  const row = db.prepare('SELECT count FROM reply_limits WHERE account_id=? AND hour_key=?').get(accountId, hour);
  return !row || row.count < max;
}

function incReply(accountId) {
  const hour = new Date().toISOString().slice(0, 13);
  db.prepare(`INSERT INTO reply_limits(account_id,hour_key,count) VALUES(?,?,1)
    ON CONFLICT(account_id,hour_key) DO UPDATE SET count=count+1`).run(accountId, hour);
}

async function tryClick(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      try { await loc.click({ timeout: 2000 }); return true; } catch {}
    }
  }
  return false;
}

async function closePopups(page) {
  await tryClick(page, [
    'text=Not Now', 'text=Не сейчас', 'text=Cancel', 'text=Отмена',
    'button:has-text("Not Now")', 'button:has-text("Не сейчас")'
  ]);
}

async function sendMessage(page, reply) {
  const box = page.locator('[contenteditable="true"][role="textbox"], div[contenteditable="true"]').last();
  await box.click({ timeout: 5000 });
  await page.keyboard.type(reply, { delay: 20 });
  await page.keyboard.press('Enter');
}

async function pollInbox({ account, context, page }) {
  await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await closePopups(page);
  await page.waitForTimeout(3000);

  // This is intentionally conservative: it opens the first visible threads and checks the last text nodes.
  const threadLinks = await page.locator('a[href*="/direct/t/"]').evaluateAll(els => [...new Set(els.map(a => a.href))].slice(0, 8)).catch(() => []);
  if (!threadLinks.length) {
    logEvent({ accountId: account.id, status: 'dm_no_threads_found' });
    return;
  }

  for (const href of threadLinks) {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    const texts = await page.locator('div[dir="auto"], span[dir="auto"]').evaluateAll(nodes => nodes.map(n => n.textContent?.trim()).filter(Boolean).slice(-12)).catch(() => []);
    const lastText = texts.filter(t => t.length < 500).at(-1);
    if (!lastText) continue;

    const match = matchRule(account.id, lastText);
    logEvent({ accountId: account.id, status: match ? 'dm_matched' : 'dm_seen_no_match', text: lastText, details: match ? { ruleId: match.rule.id, keyword: match.keyword } : null });
    if (!match) continue;
    if (!canReply(account.id)) {
      logEvent({ accountId: account.id, status: 'rate_limited', text: lastText });
      continue;
    }
    const replies = parseJson(match.rule.dm_replies, []);
    const reply = replies[Math.floor(Math.random() * replies.length)] || 'Спасибо! Скоро ответим.';
    try {
      await sendMessage(page, reply);
      incReply(account.id);
      logEvent({ accountId: account.id, status: 'dm_replied', text: lastText, details: { reply, ruleId: match.rule.id } });
      await page.waitForTimeout(1500);
    } catch (err) {
      logEvent({ accountId: account.id, level: 'error', status: 'dm_reply_error', text: lastText, details: err.message });
    }
  }
}

export async function startAgent(accountId) {
  if (running.has(accountId)) return { ok: true, status: 'already_running' };
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
  if (!account) throw new Error('Account not found');
  let stopped = false;
  const context = await createContext(account, { headless: process.env.HEADLESS === 'true' });
  const page = await context.newPage();
  running.set(accountId, { stop: async () => { stopped = true; await context.close().catch(() => {}); } });
  db.prepare('UPDATE accounts SET status=? WHERE id=?').run('running', accountId);
  logEvent({ accountId, status: 'agent_started' });
  (async () => {
    while (!stopped) {
      try {
        await pollInbox({ account, context, page });
      } catch (err) {
        logEvent({ accountId, level: 'error', status: 'agent_error', details: err.message });
      }
      await page.waitForTimeout(Number(process.env.POLL_INTERVAL_MS || 25000));
    }
  })().finally(() => {
    running.delete(accountId);
    db.prepare('UPDATE accounts SET status=? WHERE id=?').run('stopped', accountId);
  });
  return { ok: true, status: 'started' };
}

export async function stopAgent(accountId) {
  const item = running.get(accountId);
  if (!item) return { ok: true, status: 'not_running' };
  await item.stop();
  running.delete(accountId);
  db.prepare('UPDATE accounts SET status=? WHERE id=?').run('stopped', accountId);
  logEvent({ accountId, status: 'agent_stopped' });
  return { ok: true, status: 'stopped' };
}
