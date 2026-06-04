export function graphVersion() { return process.env.META_GRAPH_VERSION || 'v23.0'; }
export function graphBase() { return `https://graph.instagram.com/${graphVersion()}`; }
export function appBaseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}
export function callbackUrl(req) { return `${appBaseUrl(req)}/auth/instagram/callback`; }
export function webhookUrl(req) { return `${appBaseUrl(req)}/webhook/instagram`; }
export function dryRun() { return String(process.env.DRY_RUN || 'false').toLowerCase() === 'true'; }
export const instagramScopes = [
  'instagram_business_basic',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages'
];
