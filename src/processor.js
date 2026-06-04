import { q } from './db.js';
import { keywordMatch, pick, safeJson } from './util.js';
import { dryRun } from './config.js';
import { fetchComment, replyToComment, sendDm } from './instagram.js';

function maskToken(v) {
  if (!v) return null;
  const s = String(v);
  return s.length <= 12 ? '***' : `${s.slice(0, 6)}...${s.slice(-4)}`;
}
function normalizeRaw(raw) {
  if (!raw) return null;
  try { return JSON.parse(JSON.stringify(raw)); } catch { return { value: String(raw) }; }
}

async function getAccountByIgUserId(igUserId) {
  const { rows } = await q('select * from instagram_accounts where ig_user_id=$1 and active=true limit 1', [String(igUserId)]);
  return rows[0] || null;
}
async function getRules(accountId) {
  const { rows } = await q('select * from automation_rules where account_id=$1 and enabled=true order by id desc', [accountId]);
  return rows;
}
export async function log(data) {
  await q(`insert into activity_logs(account_id,event_id,source,status,username,sender_id,comment_id,media_id,message_id,text,response,reason,raw)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [
    data.account_id || null, data.event_id || null, data.source || null, data.status,
    data.username || null, data.sender_id || null, data.comment_id || null, data.media_id || null,
    data.message_id || null, data.text || null, data.response || null, data.reason || null,
    data.raw ? JSON.stringify(normalizeRaw(data.raw)) : null
  ]);
}

export async function debugLog(data) {
  const enabled = String(process.env.DETAILED_LOGS || 'true').toLowerCase() !== 'false';
  if (!enabled) return;
  await log(data);
}

async function markProcessed(accountId, externalId, source) {
  if (!externalId) return true;
  const { rowCount } = await q(`insert into processed_items(account_id,external_id,source) values($1,$2,$3)
    on conflict(account_id,external_id,source) do nothing`, [accountId, String(externalId), source]);
  return rowCount > 0;
}

function isMetaSample(v) {
  return v?.from?.username === 'test' || v?.text === 'This is an example.' || v?.media?.id === '123123123' || v?.id === '17865799348089039';
}

function extractMessageText(msg) {
  const text = msg.message?.text || msg.message?.quick_reply?.payload || msg.postback?.payload || msg.referral?.ref || '';
  const senderId = msg.sender?.id || msg.from?.id || msg.actor?.id || null;
  const messageId = msg.message?.mid || msg.postback?.mid || msg.message_edit?.mid || msg.read?.mid || null;
  let type = 'message';
  if (msg.message_edit) type = 'message_edit';
  else if (msg.read) type = 'read';
  else if (msg.delivery) type = 'delivery';
  else if (msg.reaction) type = 'reaction';
  else if (msg.message?.attachments?.length) type = 'attachment';
  else if (msg.postback) type = 'postback';
  return { text, senderId, messageId, type };
}

function checkedRules(rules, text) {
  return (rules || []).map(rule => ({
    ruleId: rule.id,
    ruleName: rule.name,
    enabled: rule.enabled,
    keywords: rule.keywords || [],
    matchedKeyword: keywordMatch(text || '', rule.keywords || []),
    replyToComments: rule.reply_to_comments,
    replyToDm: rule.reply_to_dm,
    publicRepliesCount: (rule.public_replies || []).length,
    dmRepliesCount: (rule.dm_replies || []).length
  }));
}

export async function handleComment({ account, eventId = null, value, source = 'comment' }) {
  if (isMetaSample(value)) {
    await log({ account_id:account?.id, event_id:eventId, source, status:'ignored', text:value?.text, username:value?.from?.username, reason:'meta_sample_event_ignored', raw:{ value, step:'sample_filter' } });
    return { status:'ignored', reason:'meta_sample_event_ignored' };
  }
  if (!account) return { status:'ignored', reason:'no_account' };
  let text = value?.text || '';
  const commentId = value?.id || value?.comment_id;
  const mediaId = value?.media?.id || value?.media_id;
  const username = value?.from?.username || value?.username || null;

  await debugLog({
    account_id: account.id,
    event_id: eventId,
    source,
    status: 'debug_comment_received',
    username,
    comment_id: commentId,
    media_id: mediaId,
    text,
    reason: 'comment handler received payload',
    raw: { value, account: { id: account.id, username: account.username, ig_user_id: account.ig_user_id, token: maskToken(account.access_token) } }
  });

  if (commentId && !(await markProcessed(account.id, commentId, source))) {
    await debugLog({ account_id:account.id, event_id:eventId, source, status:'duplicate', username, comment_id:commentId, media_id:mediaId, text, reason:'already_processed_same_comment_id_source', raw:{ commentId, source } });
    return { status:'duplicate' };
  }
  if (commentId && !text) {
    try {
      await debugLog({ account_id:account.id, event_id:eventId, source, status:'debug_comment_fetch_start', comment_id:commentId, media_id:mediaId, reason:'comment text missing, fetching comment details', raw:{ commentId } });
      const detail = await fetchComment(commentId, account.access_token);
      text = detail.text || '';
      await debugLog({ account_id:account.id, event_id:eventId, source, status:'debug_comment_fetch_success', username: detail.username || username, comment_id:commentId, media_id:mediaId, text, reason:'comment details fetched', raw:detail });
    } catch (e) {
      await log({ account_id:account.id, event_id:eventId, source, status:'received', username, comment_id:commentId, media_id:mediaId, reason:`comment_detail_fetch_failed:${safeJson(e)}`, raw:{ value, error:safeJson(e) } });
    }
  }
  if (username && account.username && username.toLowerCase() === account.username.toLowerCase()) {
    await log({ account_id:account.id, event_id:eventId, source, status:'ignored', username, comment_id:commentId, media_id:mediaId, text, reason:'own_comment_ignored', raw:value });
    return { status:'ignored', reason:'own_comment' };
  }
  const rules = await getRules(account.id);
  await debugLog({ account_id:account.id, event_id:eventId, source, status:'debug_rules_loaded', username, comment_id:commentId, media_id:mediaId, text, reason:`rules_loaded:${rules.length}`, raw:{ checkedRules: checkedRules(rules, text), text } });
  if (!rules.length) {
    await log({ account_id:account.id, event_id:eventId, source, status:'ignored', username, comment_id:commentId, media_id:mediaId, text, reason:'no_enabled_rules_for_account', raw:{ accountId:account.id, text } });
    return { status:'ignored', reason:'no_enabled_rules_for_account' };
  }
  for (const rule of rules) {
    const kw = keywordMatch(text, rule.keywords);
    if (!kw) continue;
    const response = pick(rule.public_replies);
    await log({ account_id:account.id, event_id:eventId, source, status:'matched', username, comment_id:commentId, media_id:mediaId, text, response, reason:`keyword=${kw}; rule=${rule.name}`, raw:{ value, rule: { id:rule.id, name:rule.name, keywords:rule.keywords, reply_to_comments:rule.reply_to_comments, public_replies:rule.public_replies } } });
    if (!rule.reply_to_comments || !response) return { status:'matched_no_reply' };
    if (dryRun()) {
      await log({ account_id:account.id, event_id:eventId, source, status:'dry_run', comment_id:commentId, media_id:mediaId, text, response, reason:'DRY_RUN=true', raw:{ wouldCall:'replyToComment', commentId } });
      return { status:'dry_run' };
    }
    try {
      await debugLog({ account_id:account.id, event_id:eventId, source, status:'debug_comment_reply_start', comment_id:commentId, media_id:mediaId, text, response, reason:'calling Instagram reply endpoint', raw:{ endpoint:`/${commentId}/replies`, response } });
      const api = await replyToComment(commentId, response, account.access_token);
      await log({ account_id:account.id, event_id:eventId, source, status:'sent', comment_id:commentId, media_id:mediaId, text, response, reason:'comment_reply_sent', raw:{ apiResponse:api } });
      return { status:'sent' };
    } catch (e) {
      await log({ account_id:account.id, event_id:eventId, source, status:'error', comment_id:commentId, media_id:mediaId, text, response, reason:safeJson(e), raw:{ endpoint:`/${commentId}/replies`, error:safeJson(e), response } });
      return { status:'error', error:safeJson(e) };
    }
  }
  await log({ account_id:account.id, event_id:eventId, source, status:'ignored', username, comment_id:commentId, media_id:mediaId, text, reason:'keyword_not_matched', raw:{ value, checkedRules: checkedRules(rules, text), text } });
  return { status:'ignored', reason:'keyword_not_matched' };
}

export async function handleMessage({ account, eventId = null, msg, source = 'dm' }) {
  if (!account) return { status:'ignored', reason:'no_account' };
  const { text, senderId, messageId, type } = extractMessageText(msg || {});
  await debugLog({ account_id:account.id, event_id:eventId, source, status:'debug_dm_received', sender_id:senderId, message_id:messageId, text, reason:`dm payload parsed type=${type}`, raw:{ parsed:{ text, senderId, messageId, type }, payload:msg } });
  if (type === 'message_edit') {
    await log({ account_id:account.id, event_id:eventId, source, status:'ignored', sender_id:senderId, message_id:messageId, reason:'message_edit_ignored_no_text_payload', raw:msg });
    return { status:'ignored', reason:'message_edit' };
  }
  if (messageId && !(await markProcessed(account.id, messageId, source))) {
    await debugLog({ account_id:account.id, event_id:eventId, source, status:'duplicate', sender_id:senderId, message_id:messageId, text, reason:'already_processed_same_message_id_source', raw:{ messageId, source } });
    return { status:'duplicate' };
  }
  if (!text || !senderId) {
    await log({ account_id:account.id, event_id:eventId, source, status:'received', sender_id:senderId, message_id:messageId, reason:`message_without_text_or_sender:type=${type}`, raw:{ parsed:{ text, senderId, messageId, type }, payload:msg } });
    return { status:'received', reason:'message_without_text_or_sender' };
  }
  const rules = await getRules(account.id);
  await debugLog({ account_id:account.id, event_id:eventId, source, status:'debug_rules_loaded', sender_id:senderId, message_id:messageId, text, reason:`rules_loaded:${rules.length}`, raw:{ checkedRules: checkedRules(rules, text), text } });
  if (!rules.length) {
    await log({ account_id:account.id, event_id:eventId, source, status:'ignored', sender_id:senderId, message_id:messageId, text, reason:'no_enabled_rules_for_account', raw:{ accountId:account.id, text } });
    return { status:'ignored', reason:'no_enabled_rules_for_account' };
  }
  for (const rule of rules) {
    const kw = keywordMatch(text, rule.keywords);
    if (!kw) continue;
    const response = pick(rule.dm_replies);
    await log({ account_id:account.id, event_id:eventId, source, status:'matched', sender_id:senderId, message_id:messageId, text, response, reason:`keyword=${kw}; rule=${rule.name}`, raw:{ msg, rule:{ id:rule.id, name:rule.name, keywords:rule.keywords, reply_to_dm:rule.reply_to_dm, dm_replies:rule.dm_replies } } });
    if (!rule.reply_to_dm || !response) return { status:'matched_no_reply' };
    if (dryRun()) {
      await log({ account_id:account.id, event_id:eventId, source, status:'dry_run', sender_id:senderId, text, response, reason:'DRY_RUN=true', raw:{ wouldCall:'sendDm', recipientId:senderId } });
      return { status:'dry_run' };
    }
    try {
      await debugLog({ account_id:account.id, event_id:eventId, source, status:'debug_dm_send_start', sender_id:senderId, text, response, reason:'calling Instagram messages endpoint', raw:{ endpoint:'/me/messages', recipientId:senderId, response } });
      const api = await sendDm(senderId, response, account.access_token);
      await log({ account_id:account.id, event_id:eventId, source, status:'sent', sender_id:senderId, text, response, reason:'dm_sent', raw:{ apiResponse:api } });
      return { status:'sent' };
    } catch (e) {
      await log({ account_id:account.id, event_id:eventId, source, status:'error', sender_id:senderId, text, response, reason:safeJson(e), raw:{ endpoint:'/me/messages', recipientId:senderId, error:safeJson(e), response } });
      return { status:'error', error:safeJson(e) };
    }
  }
  await log({ account_id:account.id, event_id:eventId, source, status:'ignored', sender_id:senderId, message_id:messageId, text, reason:'keyword_not_matched', raw:{ msg, checkedRules: checkedRules(rules, text), text } });
  return { status:'ignored', reason:'keyword_not_matched' };
}

async function processCommentChange({ eventId, entryId, value }) {
  const account = await getAccountByIgUserId(entryId);
  if (!account) {
    await log({ event_id:eventId, source:'comment', status:'ignored', text:value?.text, username:value?.from?.username, reason:`no_account_for_ig_user_id:${entryId}`, raw:{ entryId, value } });
    return { status:'ignored', reason:'no_account' };
  }
  return handleComment({ account, eventId, value, source:'comment_webhook' });
}

async function processMessage({ eventId, entryId, msg }) {
  const account = await getAccountByIgUserId(entryId);
  if (!account) {
    await log({ event_id:eventId, source:'dm', status:'ignored', reason:`no_account_for_ig_user_id:${entryId}`, raw:{ entryId, msg } });
    return { status:'ignored', reason:'no_account' };
  }
  return handleMessage({ account, eventId, msg, source:'dm_webhook' });
}

export async function processWebhook(eventId, payload) {
  let count = 0;
  const entries = payload.entry || [];
  await debugLog({ event_id:eventId, source:'webhook', status:'debug_webhook_processing_started', reason:`entries=${entries.length}`, raw:payload });
  for (const entry of entries) {
    const entryId = String(entry.id || '');
    await debugLog({ event_id:eventId, source:'webhook', status:'debug_webhook_entry', reason:`entryId=${entryId}; changes=${entry.changes?.length||0}; messaging=${entry.messaging?.length||0}`, raw:entry });
    for (const ch of entry.changes || []) {
      if (['comments','live_comments','mentions'].includes(ch.field)) {
        const result = await processCommentChange({ eventId, entryId, value: ch.value || {} });
        await debugLog({ event_id:eventId, source:'webhook', status:'debug_change_processed', reason:`field=${ch.field}; result=${result.status}; reason=${result.reason||''}`, raw:{ field:ch.field, value:ch.value, result } });
        count++;
      } else {
        await debugLog({ event_id:eventId, source:'webhook', status:'debug_change_ignored', reason:`unsupported_field=${ch.field}`, raw:ch });
      }
    }
    for (const msg of entry.messaging || []) {
      const result = await processMessage({ eventId, entryId, msg });
      await debugLog({ event_id:eventId, source:'webhook', status:'debug_message_processed', reason:`result=${result.status}; reason=${result.reason||''}`, raw:{ msg, result } });
      count++;
    }
  }
  await q('update webhook_events set processed_count=$1,status=$2 where id=$3', [count, 'processed', eventId]);
  return { processed: count };
}
