import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { db, logEvent, parseJson } from '../db/index.js';

const running = new Map();

function sessionDir(account) {
  return path.resolve(account.session_path);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function createContext(account, { headless = true } = {}) {
  ensureDir(sessionDir(account));
  return chromium.launchPersistentContext(sessionDir(account), {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'ru-RU',
    timezoneId: process.env.TZ || 'Asia/Almaty',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
  });
}

async function screenshot(page, accountId, name) {
  const file = path.resolve(`storage/screenshots/account-${accountId}-${name}-${Date.now()}.png`);
  ensureDir(path.dirname(file));
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file.replace(path.resolve('.'), '');
}

async function acceptCookiesAndPopups(page) {
  const labels = [
    'Allow all cookies', 'Accept all', 'Accept', 'Разрешить все cookie', 'Принять все', 'Принять',
    'Not Now', 'Не сейчас', 'Cancel', 'Отмена', 'Сохранить данные', 'Save Info'
  ];
  for (const label of labels) {
    const loc = page.getByText(label, { exact: false }).first();
    if (await loc.count().catch(() => 0)) {
      await loc.click({ timeout: 1200 }).catch(() => {});
    }
  }
}

async function isLoggedIn(page) {
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  await acceptCookiesAndPopups(page);
  const url = page.url();
  if (url.includes('/accounts/login')) return false;
  const hasDirect = await page.locator('a[href="/direct/inbox/"], a[href*="/direct/"]').count().catch(() => 0);
  const hasProfile = await page.locator('a[href*="/accounts/edit/"], a[href*="/explore/"]').count().catch(() => 0);
  return hasDirect > 0 || hasProfile > 0 || !url.includes('/accounts/login');
}

export async function loginWithCredentials(accountId, { username, password, twoFactorCode } = {}) {
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
  if (!account) throw new Error('Account not found');
  if (!username || !password) throw new Error('Instagram username and password are required');

  const context = await createContext(account, { headless: true });
  const page = await context.newPage();
  try {
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    await acceptCookiesAndPopups(page);

    await page.locator('input[name="username"]').fill(username, { timeout: 30000 });
    await page.locator('input[name="password"]').fill(password, { timeout: 30000 });
    await page.locator('button[type="submit"]').click({ timeout: 10000 });
    await page.waitForTimeout(7000);

    if (twoFactorCode) {
      const codeInputs = page.locator('input[name="verificationCode"], input[aria-label*="Security"], input[aria-label*="код"], input[type="tel"], input[type="text"]');
      if (await codeInputs.count().catch(() => 0)) {
        await codeInputs.first().fill(String(twoFactorCode).trim(), { timeout: 5000 }).catch(() => {});
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(7000);
      }
    }

    await acceptCookiesAndPopups(page);
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      const shot = await screenshot(page, accountId, 'login-failed');
      const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
      db.prepare('UPDATE accounts SET status=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('login_required', text.slice(0, 500), accountId);
      logEvent({ accountId, level: 'error', status: 'login_failed', details: { screenshot: shot, hint: 'Instagram may require 2FA/challenge/checkpoint. Try again with code or open the account manually.' } });
      return { ok: false, status: 'login_failed', screenshot: shot, message: 'Login did not complete. Instagram may require 2FA/checkpoint.' };
    }

    db.prepare('UPDATE accounts SET status=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('session_ok', accountId);
    logEvent({ accountId, status: 'login_success' });
    return { ok: true, status: 'session_ok' };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function openLogin(accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
  if (!account) throw new Error('Account not found');
  return { ok: false, status: 'not_available_on_render', message: 'Render has no visible browser. Use login/password form in this dashboard or run locally for manual browser login.' };
}

export async function checkSession(accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
  if (!account) throw new Error('Account not found');
  const context = await createContext(account, { headless: true });
  const page = await context.newPage();
  try {
    const loggedIn = await isLoggedIn(page);
    db.prepare('UPDATE accounts SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(loggedIn ? 'session_ok' : 'login_required', accountId);
    logEvent({ accountId, status: loggedIn ? 'session_ok' : 'login_required' });
    return { ok: loggedIn, status: loggedIn ? 'session_ok' : 'login_required' };
  } finally {
    await context.close().catch(() => {});
  }
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
  const max = Number(process.env.MAX_REPLIES_PER_ACCOUNT_PER_HOUR || 12);
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
  const boxes = page.locator('[contenteditable="true"][role="textbox"], div[contenteditable="true"]');
  const count = await boxes.count().catch(() => 0);
  if (!count) throw new Error('message_box_not_found');
  const box = boxes.nth(count - 1);
  await box.click({ timeout: 8000 });
  await page.keyboard.type(reply, { delay: 25 });
  await page.keyboard.press('Enter');
}

function shouldSkipThread(texts, accountUsername) {
  const joined = texts.join(' ').toLowerCase();
  if (joined.includes('seen') || joined.includes('просмотрено')) return false;
  return false;
}

async function pollInbox({ account, page }) {
  await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await closePopups(page);
  await page.waitForTimeout(4000);

  if (page.url().includes('/accounts/login')) {
    db.prepare('UPDATE accounts SET status=? WHERE id=?').run('login_required', account.id);
    logEvent({ accountId: account.id, level: 'error', status: 'login_required' });
    return;
  }

  const threadLinks = await page.locator('a[href*="/direct/t/"]').evaluateAll(els => [...new Set(els.map(a => a.href))].slice(0, 8)).catch(() => []);
  if (!threadLinks.length) {
    logEvent({ accountId: account.id, status: 'dm_no_threads_found' });
    return;
  }

  for (const href of threadLinks) {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await closePopups(page);
    await page.waitForTimeout(2000);
    const texts = await page.locator('div[dir="auto"], span[dir="auto"]').evaluateAll(nodes => nodes.map(n => n.textContent?.trim()).filter(Boolean).slice(-18)).catch(() => []);
    if (shouldSkipThread(texts, account.username)) continue;
    const candidates = texts.filter(t => t && t.length > 0 && t.length < 500 && !/^\d+:\d+/.test(t));
    const lastText = candidates.at(-1);
    if (!lastText) continue;

    const key = `${account.id}:${href}:${lastText}`;
    const already = db.prepare('SELECT id FROM processed_messages WHERE message_key=?').get(key);
    if (already) continue;

    const match = matchRule(account.id, lastText);
    logEvent({ accountId: account.id, status: match ? 'dm_matched' : 'dm_seen_no_match', text: lastText, details: match ? { ruleId: match.rule.id, keyword: match.keyword } : null });
    db.prepare('INSERT OR IGNORE INTO processed_messages(account_id,message_key,text) VALUES(?,?,?)').run(account.id, key, lastText);
    if (!match) continue;
    if (!canReply(account.id)) {
      logEvent({ accountId: account.id, status: 'rate_limited', text: lastText });
      continue;
    }
    const replies = parseJson(match.rule.dm_replies, []);
    const reply = replies[Math.floor(Math.random() * replies.length)] || 'Спасибо! Скоро ответим.';
    try {
      if (process.env.DRY_RUN === 'true') {
        logEvent({ accountId: account.id, status: 'dry_run_reply', text: lastText, details: { reply } });
        continue;
      }
      await sendMessage(page, reply);
      incReply(account.id);
      logEvent({ accountId: account.id, status: 'dm_replied', text: lastText, details: { reply, ruleId: match.rule.id } });
      await page.waitForTimeout(2000);
    } catch (err) {
      const shot = await screenshot(page, account.id, 'reply-error');
      logEvent({ accountId: account.id, level: 'error', status: 'dm_reply_error', text: lastText, details: { error: err.message, screenshot: shot } });
    }
  }
}

export async function startAgent(accountId) {
  if (running.has(accountId)) return { ok: true, status: 'already_running' };
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
  if (!account) throw new Error('Account not found');
  let stopped = false;
  const context = await createContext(account, { headless: true });
  const page = await context.newPage();
  running.set(accountId, { stop: async () => { stopped = true; await context.close().catch(() => {}); } });
  db.prepare('UPDATE accounts SET status=? WHERE id=?').run('running', accountId);
  logEvent({ accountId, status: 'agent_started' });
  (async () => {
    while (!stopped) {
      try {
        await pollInbox({ account, page });
      } catch (err) {
        const shot = await screenshot(page, account.id, 'agent-error').catch(() => null);
        logEvent({ accountId, level: 'error', status: 'agent_error', details: { error: err.message, screenshot: shot } });
      }
      await page.waitForTimeout(Number(process.env.POLL_INTERVAL_MS || 35000));
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
