import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { initDb, q } from './db.js';
import { appBaseUrl, callbackUrl, instagramScopes, webhookUrl } from './config.js';
import { publicDebug, exchangeCodeForToken, exchangeLongLivedToken, getMe } from './instagram.js';
import { processWebhook } from './processor.js';
import OpenAI from 'openai';
import crypto from 'crypto';

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

function asyncRoute(fn){ return (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next); }

function getInstagramClientId() {
  return process.env.INSTAGRAM_CLIENT_ID || process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || process.env.APP_ID || '';
}

app.get('/healthz', asyncRoute(async (req,res)=>{
  let db='missing';
  try { await q('select 1'); db='connected'; } catch(e) { db=e.message; }
  res.json({ ok:true, app:'ig-instagram-login-agent', database:db });
}));

app.get('/api/meta/debug', (req,res)=>res.json(publicDebug(req)));
function buildInstagramLoginUrl(req, debug = false) {
  const clientId = getInstagramClientId() || (debug ? 'MISSING_INSTAGRAM_CLIENT_ID' : '');
  const statePayload = {
    type: 'instagram',
    flow: 'third_party',
    ts: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex')
  };
  const state = Buffer.from(JSON.stringify(statePayload)).toString('base64');

  const thirdParty = new URL('https://www.instagram.com/oauth/authorize/third_party/');
  thirdParty.searchParams.set('redirect_uri', callbackUrl(req));
  thirdParty.searchParams.set('response_type', 'code');
  thirdParty.searchParams.set('scope', instagramScopes.join(','));
  thirdParty.searchParams.set('state', state);
  thirdParty.searchParams.set('enable_fb_login', '1');
  thirdParty.searchParams.set('client_id', clientId);
  thirdParty.searchParams.set('logger_id', crypto.randomUUID());

  const loginUrl = new URL('https://www.instagram.com/accounts/login/');
  loginUrl.searchParams.set('force_authentication', '1');
  loginUrl.searchParams.set('platform_app_id', clientId);
  loginUrl.searchParams.set('client_id', clientId);
  loginUrl.searchParams.set('next', thirdParty.pathname + thirdParty.search);
  loginUrl.searchParams.set('enable_fb_login', '1');
  loginUrl.searchParams.set('flo', 'true');
  return { loginUrl, thirdPartyUrl: thirdParty, callbackUrl: callbackUrl(req), statePayload };
}

app.get('/api/auth/debug', (req,res)=>{
  const built = buildInstagramLoginUrl(req, true);
  res.json({
    ok:true,
    loginUrl: built.loginUrl.toString(),
    thirdPartyUrl: built.thirdPartyUrl.toString(),
    callbackUrl: built.callbackUrl,
    scopes: instagramScopes,
    hasAppId: !!getInstagramClientId(),
    clientIdSource: process.env.INSTAGRAM_CLIENT_ID ? 'INSTAGRAM_CLIENT_ID' : process.env.INSTAGRAM_APP_ID ? 'INSTAGRAM_APP_ID' : process.env.META_APP_ID ? 'META_APP_ID' : process.env.APP_ID ? 'APP_ID' : 'missing',
    clientIdPreview: getInstagramClientId() ? `${getInstagramClientId().slice(0,4)}...${getInstagramClientId().slice(-4)}` : null,
    flow: 'instagram_accounts_login_third_party'
  });
});

app.get('/auth/instagram', (req,res)=>{
  const clientId = getInstagramClientId();
  if (!clientId) return res.status(400).send('Missing Instagram Client ID. Set INSTAGRAM_CLIENT_ID or META_APP_ID in Render Environment.');
  const built = buildInstagramLoginUrl(req);
  res.redirect(built.loginUrl.toString());
});

app.get('/auth/instagram/callback', asyncRoute(async (req,res)=>{
  if (req.query.error) return res.redirect(`/?auth_error=${encodeURIComponent(req.query.error_description || req.query.error)}`);
  const code = req.query.code;
  if (!code) return res.redirect('/?auth_error=missing_code');
  const short = await exchangeCodeForToken({ code, redirectUri: callbackUrl(req) });
  const long = await exchangeLongLivedToken(short.access_token);
  const token = long.access_token || short.access_token;
  const me = await getMe(token);
  const expiresIn = long.expires_in || 60*60*24*60;
  const expiresAt = new Date(Date.now() + expiresIn*1000).toISOString();
  await q(`insert into instagram_accounts(ig_user_id,username,access_token,token_expires_at,active,updated_at)
    values($1,$2,$3,$4,true,now())
    on conflict(ig_user_id) do update set username=excluded.username, access_token=excluded.access_token, token_expires_at=excluded.token_expires_at, active=true, updated_at=now()`,
    [String(me.user_id || short.user_id), me.username || `ig_${short.user_id}`, token, expiresAt]);
  res.redirect('/?connected=1');
}));

app.get('/webhook/instagram', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  if (!mode) return res.json({ ok:true, message:'Instagram webhook endpoint. Use Meta verification with hub.challenge.', webhookUrl:webhookUrl(req) });
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
  // Respond immediately to Meta, process async.
  res.json({ ok:true });
  processWebhook(eventId, body).catch(async e=>{
    await q('update webhook_events set status=$1,error=$2 where id=$3', ['error', e.message, eventId]).catch(()=>{});
  });
}));
app.post('/webhook/meta', (req,res,next)=>app._router.handle(req,res,next));

app.get('/api/accounts', asyncRoute(async (req,res)=>{
  const { rows } = await q('select id,ig_user_id,username,active,token_expires_at,created_at from instagram_accounts order by id desc');
  res.json({ accounts: rows });
}));
app.delete('/api/accounts/:id', asyncRoute(async (req,res)=>{
  await q('delete from instagram_accounts where id=$1', [req.params.id]);
  res.json({ ok:true });
}));

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
  const { rows } = await q('select * from activity_logs order by id desc limit 100');
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

app.post('/api/ai/generate', asyncRoute(async (req,res)=>{
  if (!process.env.OPENAI_API_KEY) return res.status(400).json({ ok:false, error:'OPENAI_API_KEY is not configured' });
  const { topic='Instagram reply', tone='friendly', count=5, type='comment' } = req.body || {};
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const r = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role:'user', content:`Generate ${count} short ${type} reply templates in Russian. Topic: ${topic}. Tone: ${tone}. No numbering, one reply per line.` }],
    temperature: 0.8
  });
  const text = r.choices[0]?.message?.content || '';
  res.json({ ok:true, items: text.split('\n').map(s=>s.replace(/^[-\d.\s]+/,'').trim()).filter(Boolean) });
}));

app.get('/api/debug/match', asyncRoute(async (req,res)=>{
  const text = String(req.query.text || '');
  const { keywordMatch } = await import('./util.js');
  const { rows } = await q(`select r.id,r.name,r.keywords,a.username from automation_rules r join instagram_accounts a on a.id=r.account_id where r.enabled=true`);
  const checked = rows.map(r=>({ ruleId:r.id, ruleName:r.name, account:r.username, keywords:r.keywords, matchedKeyword: keywordMatch(text, r.keywords) }));
  res.json({ text, matched: checked.some(x=>x.matchedKeyword), checkedRules: checked });
}));

app.use((err,req,res,next)=>{
  console.error(err);
  res.status(500).json({ ok:false, error: err.message });
});

await initDb();
const port = process.env.PORT || 10000;
app.listen(port, ()=>console.log(`IG Instagram Login Agent running on ${port}`));
