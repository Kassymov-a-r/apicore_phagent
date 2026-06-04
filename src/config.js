export function graphVersion() { return process.env.META_GRAPH_VERSION || 'v23.0'; }
export function graphBase() { return `https://graph.instagram.com/${graphVersion()}`; }
export function graphRoot() { return 'https://graph.instagram.com'; }

export function graphFacebookBase() { return `https://graph.facebook.com/${graphVersion()}`; }
export function appAccessToken() {
  const id = instagramClientId();
  const secret = appSecret();
  return id && secret ? `${id}|${secret}` : '';
}
export const instagramWebhookFields = [
  'comments',
  'live_comments',
  'mentions',
  'messages',
  'message_edit',
  'message_reactions',
  'messaging_postbacks',
  'messaging_seen'
];
export function requireWebhookSignature() { return String(process.env.WEBHOOK_REQUIRE_SIGNATURE || 'false').toLowerCase() === 'true'; }
export function appBaseUrl(req) {
  return (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}
export function callbackUrl(req) { return `${appBaseUrl(req)}/auth/instagram/callback`; }
export function webhookUrl(req) { return `${appBaseUrl(req)}/webhook/instagram`; }
export function dryRun() { return String(process.env.DRY_RUN || 'false').toLowerCase() === 'true'; }
export function instagramClientId() {
  return process.env.INSTAGRAM_CLIENT_ID || process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || process.env.APP_ID || '';
}
export function appSecret() { return process.env.INSTAGRAM_CLIENT_SECRET || process.env.META_APP_SECRET || process.env.APP_SECRET || ''; }
export const instagramScopes = [
  'instagram_business_basic',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages'
];
export const fbFallbackScopes = [
  'pages_show_list',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_manage_comments',
  'instagram_manage_messages'
];
