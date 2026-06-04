import crypto from 'node:crypto';
import { graphBase, graphRoot, graphVersion, callbackUrl, instagramScopes, instagramClientId, appSecret, fbFallbackScopes } from './config.js';

function asForm(body = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) p.set(k, String(v));
  return p;
}

export async function graphGet(path, token, params = {}, root = graphBase()) {
  const url = new URL(`${root}${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  if (token) url.searchParams.set('access_token', token);
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

export async function graphPost(path, token, body = {}, root = graphBase()) {
  const url = new URL(`${root}${path}`);
  if (token) url.searchParams.set('access_token', token);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: asForm(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

export function buildInstagramLoginUrl(req, { debug = false, forceAuth = true } = {}) {
  const clientId = instagramClientId() || (debug ? 'MISSING_INSTAGRAM_CLIENT_ID' : '');
  const statePayload = {
    type: 'instagram',
    flow: 'third_party',
    ts: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex')
  };
  const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');
  const loggerId = crypto.randomUUID();

  const thirdParty = new URL('https://www.instagram.com/oauth/authorize/third_party/');
  thirdParty.searchParams.set('redirect_uri', callbackUrl(req));
  thirdParty.searchParams.set('response_type', 'code');
  thirdParty.searchParams.set('scope', instagramScopes.join(','));
  thirdParty.searchParams.set('state', state);
  thirdParty.searchParams.set('enable_fb_login', '1');
  thirdParty.searchParams.set('client_id', clientId);
  thirdParty.searchParams.set('logger_id', loggerId);

  const loginUrl = new URL('https://www.instagram.com/accounts/login/');
  if (forceAuth) loginUrl.searchParams.set('force_authentication', '1');
  loginUrl.searchParams.set('platform_app_id', clientId);
  loginUrl.searchParams.set('next', thirdParty.pathname + thirdParty.search);
  loginUrl.searchParams.set('enable_fb_login', '1');
  loginUrl.searchParams.set('flo', 'true');

  const directApiUrl = new URL('https://api.instagram.com/oauth/authorize');
  directApiUrl.searchParams.set('client_id', clientId);
  directApiUrl.searchParams.set('redirect_uri', callbackUrl(req));
  directApiUrl.searchParams.set('scope', instagramScopes.join(','));
  directApiUrl.searchParams.set('response_type', 'code');
  directApiUrl.searchParams.set('state', state);

  return {
    loginUrl,
    thirdPartyUrl: thirdParty,
    directApiUrl,
    callbackUrl: callbackUrl(req),
    statePayload,
    clientId,
    scopes: instagramScopes
  };
}

export function buildFacebookFallbackLoginUrl(req, { debug = false } = {}) {
  const clientId = instagramClientId() || (debug ? 'MISSING_META_APP_ID' : '');
  const state = Buffer.from(JSON.stringify({ type:'facebook_fallback', ts:Date.now(), nonce:crypto.randomBytes(8).toString('hex') })).toString('base64url');
  const url = new URL(`https://www.facebook.com/${graphVersion()}/dialog/oauth`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', callbackUrl(req));
  url.searchParams.set('scope', fbFallbackScopes.join(','));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return { loginUrl:url, callbackUrl:callbackUrl(req), scopes:fbFallbackScopes, clientId };
}

export async function exchangeInstagramCodeForToken({ code, redirectUri }) {
  const clientId = instagramClientId();
  const secret = appSecret();
  if (!clientId) throw new Error('Missing INSTAGRAM_CLIENT_ID or META_APP_ID');
  if (!secret) throw new Error('Missing INSTAGRAM_CLIENT_SECRET or META_APP_SECRET');
  const r = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    body: asForm({ client_id: clientId, client_secret: secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

export async function exchangeFacebookCodeForToken({ code, redirectUri }) {
  const clientId = instagramClientId();
  const secret = appSecret();
  const url = new URL(`https://graph.facebook.com/${graphVersion()}/oauth/access_token`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('client_secret', secret);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code);
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

export async function exchangeLongLivedInstagramToken(shortToken) {
  const secret = appSecret();
  const url = new URL(`${graphRoot()}/access_token`);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', secret);
  url.searchParams.set('access_token', shortToken);
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

export async function refreshLongLivedInstagramToken(token) {
  const url = new URL(`${graphRoot()}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token);
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

export async function getMe(token) {
  return graphGet('/me', token, { fields: 'user_id,username,account_type' });
}

export async function fetchComment(commentId, token) {
  return graphGet(`/${commentId}`, token, { fields: 'id,text,username,from,media,timestamp' });
}

export async function replyToComment(commentId, text, token) {
  return graphPost(`/${commentId}/replies`, token, { message: text });
}

export async function sendDm(recipientId, text, token) {
  return graphPost('/me/messages', token, {
    recipient: JSON.stringify({ id: recipientId }),
    message: JSON.stringify({ text })
  });
}

export async function listMediaWithComments(token, limit = 50) {
  return graphGet('/me/media', token, {
    // comments_count lets us distinguish "there are really no comments" from "comments edge is not returned".
    fields: 'id,caption,media_type,media_product_type,permalink,timestamp,comments_count,comments.limit(50){id,text,username,from,timestamp}',
    limit
  });
}

export async function listMediaDiagnostics(token, limit = 50) {
  const media = await listMediaWithComments(token, limit);
  return {
    ...media,
    diagnostics: (media.data || []).map(item => ({
      id: item.id,
      media_type: item.media_type,
      media_product_type: item.media_product_type,
      permalink: item.permalink,
      caption: item.caption ? String(item.caption).slice(0, 120) : '',
      timestamp: item.timestamp,
      comments_count: item.comments_count ?? null,
      fetched_comments: item.comments?.data?.length || 0,
      sample_comments: (item.comments?.data || []).slice(0, 3).map(c => ({ id: c.id, username: c.username, text: c.text }))
    }))
  };
}

export async function listConversations(token, limit = 10) {
  return graphGet('/me/conversations', token, {
    platform: 'instagram',
    fields: 'id,updated_time,messages.limit(5){id,created_time,from,to,message}',
    limit
  });
}

export function publicDebug(req) {
  const built = buildInstagramLoginUrl(req, { debug: true });
  const fb = buildFacebookFallbackLoginUrl(req, { debug: true });
  return {
    database: process.env.DATABASE_URL ? 'configured' : 'missing',
    baseUrl: (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, ''),
    callbackUrl: callbackUrl(req),
    webhookUrl: `${(process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/webhook/instagram`,
    hasAppId: !!instagramClientId(),
    clientIdPreview: instagramClientId() ? `${instagramClientId().slice(0,4)}...${instagramClientId().slice(-4)}` : null,
    hasAppSecret: !!appSecret(),
    graphVersion: graphVersion(),
    dryRun: String(process.env.DRY_RUN || 'false').toLowerCase() === 'true',
    recommendedLoginMode: 'instagram_login_third_party',
    graphBaseUrl: graphBase(),
    oauthScopes: instagramScopes,
    instagramLoginUrl: built.loginUrl.toString(),
    instagramDirectAuthorizeUrl: built.directApiUrl.toString(),
    facebookFallbackUrl: fb.loginUrl.toString(),
    requiredRedirectUri: callbackUrl(req)
  };
}
