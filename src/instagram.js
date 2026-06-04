import { graphBase, graphVersion } from './config.js';

export async function graphGet(path, token, params = {}) {
  const url = new URL(`${graphBase()}${path}`);
  for (const [k,v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

export async function graphPost(path, token, body = {}) {
  const url = new URL(`${graphBase()}${path}`);
  url.searchParams.set('access_token', token);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

export async function exchangeCodeForToken({ code, redirectUri }) {
  const url = new URL('https://api.instagram.com/oauth/access_token');
  const body = new URLSearchParams({
    client_id: process.env.INSTAGRAM_CLIENT_ID || process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || process.env.APP_ID,
    client_secret: process.env.META_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code
  });
  const r = await fetch(url, { method: 'POST', body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

export async function exchangeLongLivedToken(shortToken) {
  const url = new URL(`${graphBase()}/access_token`);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', process.env.META_APP_SECRET);
  url.searchParams.set('access_token', shortToken);
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

export async function getMe(token) {
  return graphGet('/me', token, { fields: 'user_id,username,account_type' });
}

export async function fetchComment(commentId, token) {
  return graphGet(`/${commentId}`, token, { fields: 'id,text,username,from,media' });
}

export async function replyToComment(commentId, text, token) {
  return graphPost(`/${commentId}/replies`, token, { message: text });
}

export async function sendDm(recipientId, text, token) {
  return graphPost('/me/messages', token, {
    recipient: { id: recipientId },
    message: { text }
  });
}

export function publicDebug(req) {
  const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return {
    database: process.env.DATABASE_URL ? 'configured' : 'missing',
    baseUrl: base,
    callbackUrl: `${base}/auth/instagram/callback`,
    webhookUrl: `${base}/webhook/instagram`,
    hasAppId: !!(process.env.INSTAGRAM_CLIENT_ID || process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || process.env.APP_ID),
    hasAppSecret: !!process.env.META_APP_SECRET,
    graphVersion: graphVersion(),
    loginMode: 'instagram_third_party',
    oauthAuthorizeUrl: 'https://www.instagram.com/accounts/login/ + /oauth/authorize/third_party/',
    graphBaseUrl: graphBase(),
    oauthScopes: ['instagram_business_basic','instagram_business_manage_comments','instagram_business_manage_messages']
  };
}
