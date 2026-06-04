import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import OpenAI from 'openai';
import { initDb, q } from './db.js';
import { callbackUrl, webhookUrl, instagramScopes, instagramClientId, appSecret, dryRun } from './config.js';
import { publicDebug, buildInstagramLoginUrl, buildFacebookFallbackLoginUrl, exchangeInstagramCodeForToken, exchangeFacebookCodeForToken, exchangeLongLivedInstagramToken, getMe, refreshLongLivedInstagramToken } from './instagram.js';
import { processWebhook } from './processor.js';
import { keywordMatch } from './util.js';
import { loadSettingsIntoEnv, listSettings, saveSettings } from './settings.js';
import { pollAllAccounts } from './poller.js';

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

function asyncRoute(fn){ return (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next); }
function ownerMode(){ return { id:'owner', role:'owner', noAuth:true }; }
function decodeState(s='') { try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); } catch { return {}; } }

app.get('/healthz', asyncRoute(async (req,res)=>{
  let db='missing';
  try { await q('select 1'); db='connected'; } catch(e) { db=e.message; }
  res.json({ ok:true, app:'ig-agent-best-practices', database:db, dryRun:dryRun() });
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
      webhookVerifyTokenConfigured: !!process.env.META_WEBHOOK_VERIFY_TOKEN
    }
  });
});

app.get('/api/settings', asyncRoute(async (req,res)=>res.json({ settings: await listSettings() })));
app.post('/api/settings', asyncRoute(async (req,res)=>res.json({ ok:true, saved: await saveSettings(req.body || {}), settings: await listSettings() })));

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
  const body = req.body || {};
  const entries = body.entry || [];
  const changeFields = entries.flatMap(e => (e.changes||[]).map(c=>c.field)).filter(Boolean);
  const messagingCount = entries.reduce((s,e)=>s+(e.messaging?.length||0),0);
  const { rows } = await q(`insert into webhook_events(object_type,raw_event,entry_count,change_fields,messaging_count,status)
    values($1,$2,$3,$4,$5,'received') returning id`, [body.object || 'unknown', JSON.stringify(body), entries.length, changeFields, messagingCount]);
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
app.get('/api/webhook/events', asyncRoute(async (req,res)=>{
  const { rows } = await q('select id,object_type,entry_count,change_fields,messaging_count,processed_count,status,error,created_at from webhook_events order by id desc limit 100');
  res.json({ events: rows });
}));
app.get('/api/webhook/events/:id', asyncRoute(async (req,res)=>{
  const { rows } = await q('select * from webhook_events where id=$1',[req.params.id]);
  res.json(rows[0] || null);
}));

app.post('/api/poll/run', asyncRoute(async (req,res)=>{
  const out = await pollAllAccounts();
  res.json({ ok:true, result:out });
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

await initDb();
await loadSettingsIntoEnv();
const port = process.env.PORT || 10000;
app.listen(port, ()=>console.log(`IG Agent Best Practices running on ${port}`));
