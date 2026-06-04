import crypto from 'node:crypto';
import { graphBase, graphRoot, graphVersion, callbackUrl, instagramScopes, instagramClientId, appSecret, fbFallbackScopes } from './config.js';

function asForm(body = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) p.set(k, String(v));
  return p;
}

export function scrubSensitive(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value
      .replace(/access_token=([^&]+)/g, 'access_token=***')
      .replace(/client_secret=([^&]+)/g, 'client_secret=***');
  }
  if (Array.isArray(value)) return value.map(scrubSensitive);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|secret|authorization/i.test(k)) out[k] = v ? '***' : v;
      else out[k] = scrubSensitive(v);
    }
    return out;
  }
  return value;
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

export async function graphGetUrl(urlLike) {
  const r = await fetch(urlLike);
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

export async function listMedia(token, limit = 50) {
  return graphGet('/me/media', token, {
    // Keep media listing separate from comments fetching. In practice Meta can return
    // comments_count while omitting nested comments expansion, so we call /{media_id}/comments explicitly.
    fields: 'id,caption,media_type,media_product_type,permalink,timestamp,comments_count',
    limit
  });
}

export async function listCommentsForMedia(mediaId, token, limit = 50) {
  return graphGet(`/${mediaId}/comments`, token, {
    fields: 'id,text,username,from,timestamp,parent_id,replies.limit(10){id,text,username,timestamp}',
    limit
  });
}

export async function listCommentsForMediaPaginated(mediaId, token, { pageLimit = 50, maxPages = 8 } = {}) {
  const diagnostics = {
    attempted: true,
    endpoint: `/${mediaId}/comments`,
    limit: pageLimit,
    max_pages: maxPages,
    ok: null,
    error: null,
    pages: [],
    raw: null
  };
  const all = [];
  let page = null;
  try {
    page = await listCommentsForMedia(mediaId, token, pageLimit);
    diagnostics.pages.push({
      page: 1,
      data_length: (page.data || []).length,
      paging: scrubSensitive(page.paging || null)
    });
    all.push(...(page.data || []));

    let next = page.paging?.next;
    let pageNo = 1;
    while (next && pageNo < maxPages) {
      pageNo += 1;
      const nextPage = await graphGetUrl(next);
      diagnostics.pages.push({
        page: pageNo,
        data_length: (nextPage.data || []).length,
        paging: scrubSensitive(nextPage.paging || null)
      });
      all.push(...(nextPage.data || []));
      next = nextPage.paging?.next;
      if (all.length >= pageLimit * maxPages) break;
    }

    diagnostics.ok = true;
    diagnostics.raw = scrubSensitive({
      first_page: page,
      page_count: diagnostics.pages.length,
      total_fetched: all.length,
      note: all.length === 0 && diagnostics.pages.length > 1
        ? 'Instagram returned paging cursors/next pages, but every fetched page had empty data.'
        : undefined
    });
    return { data: all, paging: page?.paging || null, diagnostics };
  } catch (e) {
    diagnostics.ok = false;
    diagnostics.error = e?.message || String(e);
    diagnostics.raw = scrubSensitive({ first_page: page });
    return { data: all, paging: page?.paging || null, diagnostics };
  }
}

export async function listMediaWithComments(token, limit = 50, commentsLimit = 50) {
  const media = await listMedia(token, limit);
  const out = [];
  const maxCommentPages = Math.max(1, Number(process.env.POLL_COMMENT_MAX_PAGES || 8));
  for (const item of media.data || []) {
    const copy = { ...item };
    const commentsCount = Number(item.comments_count || 0);
    if (commentsCount > 0) {
      const fetched = await listCommentsForMediaPaginated(item.id, token, { pageLimit: commentsLimit, maxPages: maxCommentPages });
      copy.comments = { data: fetched.data || [], paging: fetched.paging || null };
      copy.comments_fetch = fetched.diagnostics;
    } else {
      copy.comments = { data: [] };
      copy.comments_fetch = {
        attempted: false,
        endpoint: `/${item.id}/comments`,
        limit: commentsLimit,
        max_pages: maxCommentPages,
        ok: true,
        error: null,
        pages: [],
        raw: { data: [] }
      };
    }
    out.push(copy);
  }
  return { ...media, data: out, media_raw: scrubSensitive(media) };
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
      comments_fetch: item.comments_fetch || null,
      sample_comments: (item.comments?.data || []).slice(0, 3).map(c => ({ id: c.id, username: c.username, text: c.text, timestamp: c.timestamp }))
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
