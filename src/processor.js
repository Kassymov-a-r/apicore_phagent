import { q } from './db.js';
import { keywordMatch, pick, safeJson } from './util.js';
import { dryRun } from './config.js';
import { fetchComment, replyToComment, sendDm } from './instagram.js';

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
    data.raw ? JSON.stringify(data.raw) : null
  ]);
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

export async function handleComment({ account, eventId = null, value, source = 'comment' }) {
  if (isMetaSample(value)) {
    await log({ account_id:account?.id, event_id:eventId, source, status:'ignored', text:value?.text, username:value?.from?.username, reason:'meta_sample_event_ignored', raw:value });
    return { status:'ignored', reason:'meta_sample_event_ignored' };
  }
  if (!account) return { status:'ignored', reason:'no_account' };
  let text = value?.text || '';
  const commentId = value?.id || value?.comment_id;
  const mediaId = value?.media?.id || value?.media_id;
  const username = value?.from?.username || value?.username || null;
  if (commentId && !(await markProcessed(account.id, commentId, source))) return { status:'duplicate' };
  if (commentId && !text) {
    try {
      const detail = await fetchComment(commentId, account.access_token);
      text = detail.text || '';
    } catch (e) {
      await log({ account_id:account.id, event_id:eventId, source, status:'received', username, comment_id:commentId, media_id:mediaId, reason:`comment_detail_fetch_failed:${safeJson(e)}`, raw:value });
    }
  }
  if (username && account.username && username.toLowerCase() === account.username.toLowerCase()) {
    await log({ account_id:account.id, event_id:eventId, source, status:'ignored', username, comment_id:commentId, media_id:mediaId, text, reason:'own_comment_ignored', raw:value });
    return { status:'ignored', reason:'own_comment' };
  }
  const rules = await getRules(account.id);
  for (const rule of rules) {
    const kw = keywordMatch(text, rule.keywords);
    if (!kw) continue;
    const response = pick(rule.public_replies);
    await log({ account_id:account.id, event_id:eventId, source, status:'matched', username, comment_id:commentId, media_id:mediaId, text, response, reason:`keyword=${kw}`, raw:value });
    if (!rule.reply_to_comments || !response) return { status:'matched_no_reply' };
    if (dryRun()) {
      await log({ account_id:account.id, event_id:eventId, source, status:'dry_run', comment_id:commentId, media_id:mediaId, text, response, reason:'DRY_RUN=true' });
      return { status:'dry_run' };
    }
    try {
      const api = await replyToComment(commentId, response, account.access_token);
      await log({ account_id:account.id, event_id:eventId, source, status:'sent', comment_id:commentId, media_id:mediaId, text, response, raw:api });
      return { status:'sent' };
    } catch (e) {
      await log({ account_id:account.id, event_id:eventId, source, status:'error', comment_id:commentId, media_id:mediaId, text, response, reason:safeJson(e) });
      return { status:'error', error:safeJson(e) };
    }
  }
  await log({ account_id:account.id, event_id:eventId, source, status:'ignored', username, comment_id:commentId, media_id:mediaId, text, reason:'keyword_not_matched', raw:value });
  return { status:'ignored', reason:'keyword_not_matched' };
}

export async function handleMessage({ account, eventId = null, msg, source = 'dm' }) {
  if (!account) return { status:'ignored', reason:'no_account' };
  const { text, senderId, messageId, type } = extractMessageText(msg || {});
  if (type === 'message_edit') {
    await log({ account_id:account.id, event_id:eventId, source, status:'ignored', sender_id:senderId, message_id:messageId, reason:'message_edit_ignored_no_text_payload', raw:msg });
    return { status:'ignored', reason:'message_edit' };
  }
  if (messageId && !(await markProcessed(account.id, messageId, source))) return { status:'duplicate' };
  if (!text || !senderId) {
    await log({ account_id:account.id, event_id:eventId, source, status:'received', sender_id:senderId, message_id:messageId, reason:`message_without_text_or_sender:type=${type}`, raw:msg });
    return { status:'received', reason:'message_without_text_or_sender' };
  }
  const rules = await getRules(account.id);
  for (const rule of rules) {
    const kw = keywordMatch(text, rule.keywords);
    if (!kw) continue;
    const response = pick(rule.dm_replies);
    await log({ account_id:account.id, event_id:eventId, source, status:'matched', sender_id:senderId, message_id:messageId, text, response, reason:`keyword=${kw}`, raw:msg });
    if (!rule.reply_to_dm || !response) return { status:'matched_no_reply' };
    if (dryRun()) {
      await log({ account_id:account.id, event_id:eventId, source, status:'dry_run', sender_id:senderId, text, response, reason:'DRY_RUN=true' });
      return { status:'dry_run' };
    }
    try {
      const api = await sendDm(senderId, response, account.access_token);
      await log({ account_id:account.id, event_id:eventId, source, status:'sent', sender_id:senderId, text, response, raw:api });
      return { status:'sent' };
    } catch (e) {
      await log({ account_id:account.id, event_id:eventId, source, status:'error', sender_id:senderId, text, response, reason:safeJson(e) });
      return { status:'error', error:safeJson(e) };
    }
  }
  await log({ account_id:account.id, event_id:eventId, source, status:'ignored', sender_id:senderId, message_id:messageId, text, reason:'keyword_not_matched', raw:msg });
  return { status:'ignored', reason:'keyword_not_matched' };
}

async function processCommentChange({ eventId, entryId, value }) {
  const account = await getAccountByIgUserId(entryId);
  if (!account) {
    await log({ event_id:eventId, source:'comment', status:'ignored', text:value?.text, username:value?.from?.username, reason:`no_account_for_ig_user_id:${entryId}`, raw:value });
    return { status:'ignored', reason:'no_account' };
  }
  return handleComment({ account, eventId, value, source:'comment_webhook' });
}

async function processMessage({ eventId, entryId, msg }) {
  const account = await getAccountByIgUserId(entryId);
  if (!account) {
    await log({ event_id:eventId, source:'dm', status:'ignored', reason:`no_account_for_ig_user_id:${entryId}`, raw:msg });
    return { status:'ignored', reason:'no_account' };
  }
  return handleMessage({ account, eventId, msg, source:'dm_webhook' });
}

export async function processWebhook(eventId, payload) {
  let count = 0;
  const entries = payload.entry || [];
  for (const entry of entries) {
    const entryId = String(entry.id || '');
    for (const ch of entry.changes || []) {
      if (['comments','live_comments','mentions'].includes(ch.field)) {
        await processCommentChange({ eventId, entryId, value: ch.value || {} }); count++;
      }
    }
    for (const msg of entry.messaging || []) {
      await processMessage({ eventId, entryId, msg }); count++;
    }
  }
  await q('update webhook_events set processed_count=$1,status=$2 where id=$3', [count, 'processed', eventId]);
  return { processed: count };
}
