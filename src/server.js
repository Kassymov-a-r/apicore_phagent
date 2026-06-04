import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import OpenAI from 'openai';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { initDb, q, dbInfo } from './db.js';
import { callbackUrl, webhookUrl, instagramScopes, instagramClientId, appSecret, dryRun, graphVersion, instagramWebhookFields, requireWebhookSignature } from './config.js';
import { publicDebug, buildInstagramLoginUrl, buildFacebookFallbackLoginUrl, exchangeInstagramCodeForToken, exchangeFacebookCodeForToken, exchangeLongLivedInstagramToken, getMe, refreshLongLivedInstagramToken, listMediaDiagnostics, listConversations, subscribeInstagramWebhooks, listAppSubscriptions } from './instagram.js';
import { processWebhook, log } from './processor.js';
import { keywordMatch } from './util.js';
import { applyBuiltInDefaults, loadSettingsIntoEnv, listSettings, saveSettings } from './settings.js';
import { pollAllAccounts } from './poller.js';

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = Buffer.from(buf || ''); } }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

function asyncRoute(fn){ return (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next); }
function ownerMode(){ return { id:'owner', role:'owner', noAuth:true }; }
function decodeState(s='') { try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); } catch { return {}; } }

function verifyMetaSignature(req) {
  const signature = req.get('x-hub-signature-256') || '';
  const secret = appSecret();
  if (!signature) return { ok: !requireWebhookSignature(), present: false, required: requireWebhookSignature(), reason: 'missing_x_hub_signature_256' };
  if (!secret) return { ok: !requireWebhookSignature(), present: true, required: requireWebhookSignature(), reason: 'missing_app_secret' };
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from('')).digest('hex');
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  return { ok, present: true, required: requireWebhookSignature(), reason: ok ? 'signature_ok' : 'signature_mismatch' };
}
function webhookReadiness(req) {
  const mode = String(process.env.META_APP_MODE || 'development').toLowerCase();
  return {
    ok: true,
    webhookUrl: webhookUrl(req),
    verifyTokenConfigured: !!process.env.META_WEBHOOK_VERIFY_TOKEN,
    signatureRequired: requireWebhookSignature(),
    appMode: mode,
    liveModeRecommended: true,
    note: mode === 'live' ? 'App mode is marked live in settings.' : 'Meta docs say Consumer apps must be in Live Mode to receive Instagram webhooks beyond dashboard tests.',
    subscribedFieldsRequired: instagramWebhookFields,
    oauthScopes: instagramScopes,
    pollingMode: 'diagnostic_only',
    webhookMode: 'primary_for_real_comments_and_messages'
  };
}


const DATA_DIR = process.env.DATA_DIR || process.env.RENDER_DISK_PATH || path.join(process.cwd(), 'data');
const ASSISTANT_FILES_DIR = path.join(DATA_DIR, 'assistant-files');

async function ensureAssistantFilesDir() {
  await fs.mkdir(ASSISTANT_FILES_DIR, { recursive: true });
}
function safeFileName(name) {
  const base = path.basename(String(name || 'file.txt'));
  return base.replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]/g, '_').slice(0, 160) || 'file.txt';
}
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
async function saveAssistantFile(filename, content) {
  await ensureAssistantFilesDir();
  const clean = safeFileName(filename);
  const full = path.join(ASSISTANT_FILES_DIR, clean);
  await fs.writeFile(full, content, 'utf8');
  return { name: clean, url: `/api/assistant/files/${encodeURIComponent(clean)}`, size: Buffer.byteLength(content, 'utf8') };
}
async function listAssistantFiles() {
  await ensureAssistantFilesDir();
  const names = await fs.readdir(ASSISTANT_FILES_DIR).catch(() => []);
  const out = [];
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(ASSISTANT_FILES_DIR, name));
      if (st.isFile()) out.push({ name, url: `/api/assistant/files/${encodeURIComponent(name)}`, size: st.size, updatedAt: st.mtime.toISOString() });
    } catch {}
  }
  return out.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
async function getProjectSnapshot() {
  const [accounts, rules, logs, events] = await Promise.all([
    q('select id,ig_user_id,username,account_type,active,connection_method,token_expires_at,created_at,updated_at from instagram_accounts order by id desc').catch(e=>({ rows:[], error:e.message })),
    q(`select r.*, a.username from automation_rules r left join instagram_accounts a on a.id=r.account_id order by r.id desc`).catch(e=>({ rows:[], error:e.message })),
    q('select * from activity_logs order by id desc limit 20').catch(e=>({ rows:[], error:e.message })),
    q('select id,object_type,entry_count,change_fields,messaging_count,processed_count,status,error,created_at from webhook_events order by id desc limit 20').catch(e=>({ rows:[], error:e.message }))
  ]);
  return {
    app: 'IG Agent Instagram Login',
    databaseInfo: dbInfo(),
    config: {
      appBaseUrl: process.env.APP_BASE_URL || null,
      hasAppId: !!instagramClientId(),
      hasAppSecret: !!appSecret(),
      graphVersion: graphVersion(),
      dryRun: dryRun(),
      oauthScopes: instagramScopes
    },
    accounts: (accounts.rows || []).map(a => ({ ...a, access_token: undefined, token_present: undefined })),
    rules: (rules.rows || []).map(r => ({ id:r.id, account_id:r.account_id, account:r.username, name:r.name, enabled:r.enabled, keywords:r.keywords, public_replies_count:(r.public_replies||[]).length, dm_replies_count:(r.dm_replies||[]).length })),
    latestLogs: logs.rows || [],
    latestEvents: events.rows || []
  };
}
function projectKnowledge() {
  return `
Project context:
- This project is IG Agent: Instagram automation panel for one owner and a few Instagram Professional accounts.
- Current architecture: Node/Express, Instagram Login API, Manual Token Connect, JSON fallback database if DATABASE_URL is absent, optional PostgreSQL, detailed logs, polling fallback, webhooks.
- Required Instagram Login scopes: instagram_business_basic, instagram_business_manage_comments, instagram_business_manage_messages.
- Meta Webhook fields to watch: comments, live_comments, mentions, messages, message_edit, message_reactions, messaging_postbacks, messaging_seen.
- Current operational problem history: Facebook Page flow caused pages_manage_metadata issues, so the project moved to Instagram Login API and Manual Token mode. Real webhook availability may depend on Meta app mode/review. Polling is used as fallback.
- The interface has Accounts, Automations, Logs, Secrets, Debug. Logs can be expanded to see full JSON payloads and errors.
- The assistant cannot redeploy the server by itself. It can generate downloadable files: instructions, JSON diagnostics, patch drafts, README text, code snippets, and change plans.
- Never recommend password scraping, private API abuse, spam, mass unsolicited messages, or aggressive automation. Prefer official API and safe rate limits.
`;
}
function localAssistantAnswer(question, snapshot) {
  return `Я работаю в локальном режиме, потому что OPENAI_API_KEY не настроен.\n\nЧто вижу по проекту:\n- Аккаунтов: ${snapshot.accounts?.length ?? 0}\n- Правил: ${snapshot.rules?.length ?? 0}\n- Последних логов: ${snapshot.latestLogs?.length ?? 0}\n- База: ${snapshot.databaseInfo?.mode || 'unknown'}\n\nПо твоему вопросу: ${question}\n\nБыстрый порядок диагностики:\n1. Открой «Секреты» и проверь INSTAGRAM_CLIENT_ID, INSTAGRAM_CLIENT_SECRET, META_WEBHOOK_VERIFY_TOKEN, OPENAI_API_KEY.\n2. Открой «Аккаунты» и проверь, что аккаунт active и токен подключён.\n3. В «Автоматизации» нажми «Тест правила» с нужным словом.\n4. В «Логи» нажми «Проверить Instagram сейчас» и раскрой последние события.\n5. Пришли раскрытый JSON события, если ответ не сработал.\n\nЯ также создал diagnostic JSON файл, который можно скачать из списка файлов помощника.`;
}

app.get('/healthz', asyncRoute(async (req,res)=>{
  let db='missing';
  try { await q('select 1'); db='connected'; } catch(e) { db=e.message; }
  res.json({ ok:true, app:'ig-agent-best-practices', database:db, databaseInfo: dbInfo(), dryRun:dryRun() });
}));
app.get('/api/me', (req,res)=>res.json({ user: ownerMode() }));
app.get('/api/meta/debug', (req,res)=>res.json(publicDebug(req)));
app.get('/api/auth/debug', (req,res)=>{
  const ig = buildInstagramLoginUrl(req, { debug:true });
  const fb = buildFacebookFallbackLoginUrl(req, { debug:true });
  res.json({
    ok:true,
    recommended:'instagram_login',
    hasAppId: !!instagramClientId(),
    hasAppSecret: !!appSecret(),
    clientIdSource: process.env.INSTAGRAM_CLIENT_ID ? 'INSTAGRAM_CLIENT_ID' : process.env.META_APP_ID ? 'META_APP_ID' : process.env.APP_ID ? 'APP_ID' : 'missing',
    clientIdPreview: instagramClientId() ? `${instagramClientId().slice(0,4)}...${instagramClientId().slice(-4)}` : null,
    callbackUrl: callbackUrl(req),
    instagramLoginUrl: ig.loginUrl.toString(),
    instagramThirdPartyUrl: ig.thirdPartyUrl.toString(),
    instagramDirectApiUrl: ig.directApiUrl.toString(),
    facebookFallbackUrl: fb.loginUrl.toString(),
    scopes: instagramScopes,
    requiredMetaSetup: {
      instagramLoginRedirectUri: callbackUrl(req),
      webhookCallbackUrl: webhookUrl(req),
      webhookVerifyTokenConfigured: !!process.env.META_WEBHOOK_VERIFY_TOKEN,
      webhookFields: instagramWebhookFields,
      appMode: process.env.META_APP_MODE || 'development',
      signatureRequired: requireWebhookSignature()
    },
    webhookReadiness: webhookReadiness(req)
  });
});

app.get('/api/settings', asyncRoute(async (req,res)=>res.json({ settings: await listSettings() })));
app.post('/api/settings', asyncRoute(async (req,res)=>res.json({ ok:true, saved: await saveSettings(req.body || {}), settings: await listSettings() })));
app.post('/api/settings/reset-builtins', asyncRoute(async (req,res)=>{
  applyBuiltInDefaults();
  res.json({ ok:true, settings: await listSettings() });
}));


app.get('/auth/instagram', (req,res)=>{
  if (!instagramClientId()) return res.status(400).send('Missing Instagram Client ID. Add INSTAGRAM_CLIENT_ID or META_APP_ID in Settings/Render Environment.');
  if (!appSecret()) return res.status(400).send('Missing App Secret. Add INSTAGRAM_CLIENT_SECRET or META_APP_SECRET in Settings/Render Environment.');
  res.redirect(buildInstagramLoginUrl(req).loginUrl.toString());
});
app.get('/auth/instagram/direct', (req,res)=>{
  if (!instagramClientId()) return res.status(400).send('Missing Instagram Client ID.');
  res.redirect(buildInstagramLoginUrl(req).directApiUrl.toString());
});
app.get('/auth/facebook-fallback', (req,res)=>{
  if (!instagramClientId()) return res.status(400).send('Missing META_APP_ID.');
  res.redirect(buildFacebookFallbackLoginUrl(req).loginUrl.toString());
});

async function saveConnectedAccount({ token, expiresIn, userId, username, accountType, method }) {
  const expiresAt = expiresIn ? new Date(Date.now() + Number(expiresIn)*1000).toISOString() : null;
  const { rows } = await q(`insert into instagram_accounts(ig_user_id,username,account_type,access_token,token_expires_at,active,connection_method,updated_at)
    values($1,$2,$3,$4,$5,true,$6,now())
    on conflict(ig_user_id) do update set username=excluded.username, account_type=excluded.account_type,
      access_token=excluded.access_token, token_expires_at=excluded.token_expires_at, active=true,
      connection_method=excluded.connection_method, updated_at=now() returning *`,
    [String(userId), username || `ig_${userId}`, accountType || null, token, expiresAt, method]);
  return rows[0];
}

app.get('/auth/instagram/callback', asyncRoute(async (req,res)=>{
  if (req.query.error) return res.redirect(`/?tab=debug&auth_error=${encodeURIComponent(req.query.error_description || req.query.error)}`);
  const code = req.query.code;
  if (!code) return res.redirect('/?tab=debug&auth_error=missing_code');
  const state = decodeState(req.query.state);
  let tokenResponse;
  let method = 'instagram_login';
  if (state.type === 'facebook_fallback') {
    tokenResponse = await exchangeFacebookCodeForToken({ code, redirectUri: callbackUrl(req) });
    method = 'facebook_fallback';
  } else {
    const short = await exchangeInstagramCodeForToken({ code, redirectUri: callbackUrl(req) });
    try { tokenResponse = await exchangeLongLivedInstagramToken(short.access_token); }
    catch { tokenResponse = short; }
  }
  const token = tokenResponse.access_token;
  const expiresIn = tokenResponse.expires_in || 60*60*24*60;
  const me = await getMe(token);
  await saveConnectedAccount({
    token,
    expiresIn,
    userId: me.user_id || me.id || tokenResponse.user_id,
    username: me.username,
    accountType: me.account_type,
    method
  });
  res.redirect('/?connected=1&tab=accounts');
}));

app.get('/webhook/instagram', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  if (!mode) return res.json({ ok:true, message:'Instagram webhook endpoint. Use Meta verification with hub.challenge.', webhookUrl:webhookUrl(req), verifyTokenConfigured:!!process.env.META_WEBHOOK_VERIFY_TOKEN });
  return res.sendStatus(403);
});
app.get('/webhook/meta', (req,res)=>res.redirect(307, `/webhook/instagram?${new URLSearchParams(req.query).toString()}`));
app.post('/webhook/instagram', asyncRoute(async (req,res)=>{
  const sig = verifyMetaSignature(req);
  if (!sig.ok) {
    await log({ source:'webhook', status:'forbidden', reason:sig.reason, raw:{ signature:sig, headers:{ 'x-hub-signature-256': req.get('x-hub-signature-256') ? 'present' : 'missing' } } }).catch(()=>{});
    return res.status(403).json({ ok:false, error:sig.reason });
  }
  const body = req.body || {};
  const entries = body.entry || [];
  const changeFields = entries.flatMap(e => (e.changes||[]).map(c=>c.field)).filter(Boolean);
  const messagingCount = entries.reduce((s,e)=>s+(e.messaging?.length||0),0);
  const rawEvent = { ...body, _meta: { signature:sig, receivedAt:new Date().toISOString(), webhookReadiness:webhookReadiness(req) } };
  const { rows } = await q(`insert into webhook_events(object_type,raw_event,entry_count,change_fields,messaging_count,status)
    values($1,$2,$3,$4,$5,'received') returning id`, [body.object || 'unknown', JSON.stringify(rawEvent), entries.length, changeFields, messagingCount]);
  const eventId = rows[0].id;
  res.json({ ok:true, eventId });
  processWebhook(eventId, body).catch(async e=>{
    await q('update webhook_events set status=$1,error=$2 where id=$3', ['error', e.message, eventId]).catch(()=>{});
  });
}));
app.post('/webhook/meta', (req,res,next)=>app._router.handle(req,res,next));

app.get('/api/accounts', asyncRoute(async (req,res)=>{
  const { rows } = await q('select id,ig_user_id,username,account_type,active,connection_method,token_expires_at,created_at,updated_at from instagram_accounts order by id desc');
  res.json({ accounts: rows });
}));
app.post('/api/accounts/manual-token', asyncRoute(async (req,res)=>{
  const token = String(req.body.access_token || '').trim();
  if (!token) return res.status(400).json({ ok:false, error:'access_token is required' });
  const me = await getMe(token);
  let finalToken = token;
  let expiresIn = null;
  try {
    const long = await exchangeLongLivedInstagramToken(token);
    finalToken = long.access_token || token;
    expiresIn = long.expires_in;
  } catch { /* pasted token can already be long-lived */ }
  const account = await saveConnectedAccount({ token: finalToken, expiresIn, userId: me.user_id || me.id, username: me.username, accountType: me.account_type, method:'manual_token' });
  res.json({ ok:true, account: { ...account, access_token: undefined } });
}));
app.post('/api/accounts/:id/refresh-token', asyncRoute(async (req,res)=>{
  const { rows } = await q('select * from instagram_accounts where id=$1', [req.params.id]);
  const account = rows[0];
  if (!account) return res.status(404).json({ ok:false, error:'account_not_found' });
  const data = await refreshLongLivedInstagramToken(account.access_token);
  const expiresAt = data.expires_in ? new Date(Date.now()+Number(data.expires_in)*1000).toISOString() : account.token_expires_at;
  await q('update instagram_accounts set access_token=$1, token_expires_at=$2, updated_at=now() where id=$3', [data.access_token || account.access_token, expiresAt, account.id]);
  res.json({ ok:true, expiresAt });
}));
app.delete('/api/accounts/:id', asyncRoute(async (req,res)=>{ await q('delete from instagram_accounts where id=$1', [req.params.id]); res.json({ ok:true }); }));

app.get('/api/rules', asyncRoute(async (req,res)=>{
  const { rows } = await q(`select r.*, a.username from automation_rules r left join instagram_accounts a on a.id=r.account_id order by r.id desc`);
  res.json({ rules: rows });
}));
app.post('/api/rules', asyncRoute(async (req,res)=>{
  const b=req.body;
  const { rows } = await q(`insert into automation_rules(account_id,name,enabled,keywords,public_replies,dm_replies,reply_to_comments,reply_to_dm)
    values($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [
    b.account_id, b.name || 'Rule', b.enabled !== false,
    b.keywords || [], b.public_replies || [], b.dm_replies || [], b.reply_to_comments !== false, b.reply_to_dm !== false
  ]);
  res.json({ ok:true, rule:rows[0] });
}));
app.delete('/api/rules/:id', asyncRoute(async (req,res)=>{ await q('delete from automation_rules where id=$1',[req.params.id]); res.json({ok:true}); }));

app.get('/api/logs', asyncRoute(async (req,res)=>{
  const { rows } = await q('select * from activity_logs order by id desc limit 150');
  res.json({ logs: rows });
}));
app.get('/api/logs/:id', asyncRoute(async (req,res)=>{
  const { rows } = await q('select * from activity_logs where id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ ok:false, error:'log_not_found' });
  let event = null;
  if (rows[0].event_id) {
    const er = await q('select * from webhook_events where id=$1', [rows[0].event_id]);
    event = er.rows[0] || null;
  }
  res.json({ ok:true, log: rows[0], event });
}));
app.get('/api/webhook/events', asyncRoute(async (req,res)=>{
  const { rows } = await q('select id,object_type,entry_count,change_fields,messaging_count,processed_count,status,error,created_at from webhook_events order by id desc limit 100');
  res.json({ events: rows });
}));
app.get('/api/webhook/events/:id', asyncRoute(async (req,res)=>{
  const { rows } = await q('select * from webhook_events where id=$1',[req.params.id]);
  res.json(rows[0] || null);
}));
app.get('/api/webhook/status', asyncRoute(async (req,res)=>{
  let appSubscriptions = null;
  let subscriptionError = null;
  try { appSubscriptions = await listAppSubscriptions({}); } catch (e) { subscriptionError = e.message; }
  res.json({ ok:true, ...webhookReadiness(req), appSubscriptions, subscriptionError });
}));
app.post('/api/webhook/subscribe', asyncRoute(async (req,res)=>{
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) return res.status(400).json({ ok:false, error:'META_WEBHOOK_VERIFY_TOKEN is not configured' });
  const fields = Array.isArray(req.body?.fields) && req.body.fields.length ? req.body.fields : instagramWebhookFields;
  try {
    const apiResponse = await subscribeInstagramWebhooks({ callbackUrl:webhookUrl(req), verifyToken, fields });
    await log({ source:'webhook', status:'subscribe_attempt', reason:'instagram_app_subscriptions_success', raw:{ callbackUrl:webhookUrl(req), fields, apiResponse } }).catch(()=>{});
    res.json({ ok:true, callbackUrl:webhookUrl(req), fields, apiResponse });
  } catch (e) {
    await log({ source:'webhook', status:'subscribe_error', reason:e.message, raw:{ callbackUrl:webhookUrl(req), fields } }).catch(()=>{});
    res.status(400).json({ ok:false, callbackUrl:webhookUrl(req), fields, error:e.message });
  }
}));

app.get('/api/debug/state', asyncRoute(async (req,res)=>{
  const accounts = await q('select * from instagram_accounts where active=true order by id desc');
  const rules = await q('select r.*, a.username from automation_rules r left join instagram_accounts a on a.id=r.account_id order by r.id desc');
  const logs = await q('select * from activity_logs order by id desc limit 10');
  const events = await q('select id,object_type,entry_count,change_fields,messaging_count,processed_count,status,error,created_at from webhook_events order by id desc limit 10');
  res.json({
    ok:true,
    databaseInfo: dbInfo(),
    accounts: accounts.rows.map(a => ({ id:a.id, username:a.username, ig_user_id:a.ig_user_id, active:a.active, account_type:a.account_type, connection_method:a.connection_method, token_expires_at:a.token_expires_at, token_present: !!a.access_token })),
    rules: rules.rows.map(r => ({ id:r.id, account_id:r.account_id, account:r.username, name:r.name, enabled:r.enabled, keywords:r.keywords, public_replies_count:(r.public_replies||[]).length, dm_replies_count:(r.dm_replies||[]).length })),
    latestLogs: logs.rows,
    latestEvents: events.rows
  });
}));

app.post('/api/poll/run', asyncRoute(async (req,res)=>{
  const out = await pollAllAccounts({ verbose:true });
  res.json({ ok:true, message:'Polling finished. Open Logs to see poll_summary / errors / matched replies.', result:out });
}));

app.get('/api/poll/media-debug', asyncRoute(async (req,res)=>{
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || process.env.POLL_MEDIA_LIMIT || 50)));
  const { rows: accounts } = await q('select * from instagram_accounts where active=true order by id desc');
  const result = [];
  for (const account of accounts) {
    try {
      const media = await listMediaDiagnostics(account.access_token, limit);
      result.push({
        accountId: account.id,
        username: account.username,
        igUserId: account.ig_user_id,
        limit,
        mediaCount: media.data?.length || 0,
        mediaWithCommentsCount: media.diagnostics.filter(x => Number(x.comments_count || 0) > 0).length,
        mediaWithFetchedComments: media.diagnostics.filter(x => x.fetched_comments > 0).length,
        media: media.diagnostics
      });
    } catch (e) {
      result.push({ accountId: account.id, username: account.username, ok:false, error: e.message });
    }
  }
  res.json({ ok:true, accounts: result });
}));

app.get('/api/poll/conversations-debug', asyncRoute(async (req,res)=>{
  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 10)));
  const { rows: accounts } = await q('select * from instagram_accounts where active=true order by id desc');
  const result = [];
  for (const account of accounts) {
    try {
      const conv = await listConversations(account.access_token, limit);
      result.push({ accountId: account.id, username: account.username, conversationsCount: conv.data?.length || 0, raw: conv });
    } catch (e) {
      result.push({ accountId: account.id, username: account.username, ok:false, error: e.message });
    }
  }
  res.json({ ok:true, accounts: result });
}));



app.get('/api/assistant/files', asyncRoute(async (req,res)=>{
  res.json({ ok:true, files: await listAssistantFiles() });
}));
app.get('/api/assistant/files/:name', asyncRoute(async (req,res)=>{
  const name = safeFileName(req.params.name);
  const full = path.join(ASSISTANT_FILES_DIR, name);
  try {
    await fs.access(full);
    res.download(full, name);
  } catch {
    res.status(404).json({ ok:false, error:'file_not_found' });
  }
}));
app.get('/api/assistant/knowledge', asyncRoute(async (req,res)=>{
  res.json({ ok:true, knowledge: projectKnowledge(), snapshot: await getProjectSnapshot(), files: await listAssistantFiles() });
}));
app.post('/api/assistant/ask', asyncRoute(async (req,res)=>{
  const question = String(req.body?.question || '').trim();
  const mode = String(req.body?.mode || 'answer');
  if (!question) return res.status(400).json({ ok:false, error:'question is required' });
  const snapshot = await getProjectSnapshot();
  let answer = '';
  const system = `${projectKnowledge()}\nAnswer in Russian. Be direct and practical. When code changes are needed, provide a patch plan with file names. If asked to create files, generate downloadable file content. Do not claim you applied changes to the deployed server.`;
  if (process.env.OPENAI_API_KEY) {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const r = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role:'system', content: system },
        { role:'user', content: `Question/request:\n${question}\n\nCurrent project snapshot JSON:\n${JSON.stringify(snapshot, null, 2).slice(0, 24000)}` }
      ],
      temperature: 0.3
    });
    answer = r.choices[0]?.message?.content || '';
  } else {
    answer = localAssistantAnswer(question, snapshot);
  }
  const files = [];
  files.push(await saveAssistantFile(`assistant-answer-${stamp()}.md`, `# AI Assistant Answer\n\n${answer}\n\n---\n\n## Question\n\n${question}\n`));
  files.push(await saveAssistantFile(`diagnostic-snapshot-${stamp()}.json`, JSON.stringify(snapshot, null, 2)));
  if (/patch|патч|код|файл|zip|архив|исправ/i.test(question) || mode === 'patch') {
    const patchDraft = `# Patch / Change Plan\n\nUser request:\n${question}\n\nAssistant answer:\n${answer}\n\n## Important\nThis file is a draft. Apply changes in the source project, commit, then redeploy.\n`;
    files.push(await saveAssistantFile(`patch-plan-${stamp()}.md`, patchDraft));
  }
  await log({ source:'assistant', status:'assistant_answer', text:question, response:answer, reason:`files=${files.length}`, raw:{ mode, files } }).catch(()=>{});
  res.json({ ok:true, answer, files, snapshotSummary:{ accounts:snapshot.accounts?.length||0, rules:snapshot.rules?.length||0, logs:snapshot.latestLogs?.length||0, database:snapshot.databaseInfo } });
}));

app.post('/api/ai/generate', asyncRoute(async (req,res)=>{
  if (!process.env.OPENAI_API_KEY) return res.status(400).json({ ok:false, error:'OPENAI_API_KEY is not configured' });
  const { topic='Instagram reply', tone='friendly', count=5, type='comment' } = req.body || {};
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const r = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role:'user', content:`Generate ${count} short ${type} reply templates in Russian. Topic: ${topic}. Tone: ${tone}. Rules: natural language, no spam, no hard sell, one reply per line, no numbering.` }],
    temperature: 0.8
  });
  const text = r.choices[0]?.message?.content || '';
  res.json({ ok:true, items: text.split('\n').map(s=>s.replace(/^[-\d.\s]+/,'').trim()).filter(Boolean) });
}));


app.post('/api/debug/test-rule', asyncRoute(async (req,res)=>{
  const text = String(req.body?.text || req.query.text || '').trim();
  const source = String(req.body?.source || req.query.source || 'test').trim();
  if (!text) return res.status(400).json({ ok:false, error:'text is required' });
  const { rows } = await q(`select r.*, a.username from automation_rules r left join instagram_accounts a on a.id=r.account_id where r.enabled=true order by r.id desc`);
  const checked = [];
  let first = null;
  for (const r of rows) {
    const matchedKeyword = keywordMatch(text, r.keywords || []);
    const item = {
      ruleId: r.id,
      ruleName: r.name,
      accountId: r.account_id,
      account: r.username,
      keywords: r.keywords || [],
      matchedKeyword,
      publicReply: matchedKeyword ? (r.public_replies || [])[0] || null : null,
      dmReply: matchedKeyword ? (r.dm_replies || [])[0] || null : null
    };
    checked.push(item);
    if (!first && matchedKeyword) first = item;
  }
  await log({
    account_id: first?.accountId || null,
    source: `debug_${source}`,
    status: first ? 'matched' : 'ignored',
    text,
    response: first?.publicReply || first?.dmReply || null,
    reason: first ? `test_rule_matched: rule=${first.ruleName}; keyword=${first.matchedKeyword}` : 'test_rule_keyword_not_matched',
    raw: { text, source, checked }
  });
  res.json({ ok:true, text, matched: !!first, matchedRule:first, checked });
}));

app.get('/api/debug/match', asyncRoute(async (req,res)=>{
  const text = String(req.query.text || '');
  const { rows } = await q(`select r.id,r.name,r.keywords,a.username from automation_rules r join instagram_accounts a on a.id=r.account_id where r.enabled=true`);
  const checked = rows.map(r=>({ ruleId:r.id, ruleName:r.name, account:r.username, keywords:r.keywords, matchedKeyword: keywordMatch(text, r.keywords) }));
  res.json({ text, matched: checked.some(x=>x.matchedKeyword), checkedRules: checked });
}));

app.use((err,req,res,next)=>{
  console.error(err);
  res.status(500).json({ ok:false, error: err.message });
});

applyBuiltInDefaults();
await initDb();
await loadSettingsIntoEnv();

const autoPollEnabled = String(process.env.AUTO_POLL_ENABLED || 'true').toLowerCase() !== 'false';
const autoPollSeconds = Math.max(30, Number(process.env.AUTO_POLL_SECONDS || 60));
if (autoPollEnabled) {
  console.log(`Auto polling enabled every ${autoPollSeconds}s`);
  setInterval(() => {
    pollAllAccounts({ verbose:false }).catch(e => console.error('auto poll failed', e));
  }, autoPollSeconds * 1000);
}

const port = process.env.PORT || 10000;
app.listen(port, ()=>console.log(`IG Agent Best Practices running on ${port}`));
