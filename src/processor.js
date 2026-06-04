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
async function log(data) {
  await q(`insert into activity_logs(account_id,event_id,source,status,username,sender_id,comment_id,media_id,message_id,text,response,reason,raw)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [
    data.account_id || null, data.event_id || null, data.source || null, data.status,
    data.username || null, data.sender_id || null, data.comment_id || null, data.media_id || null,
    data.message_id || null, data.text || null, data.response || null, data.reason || null,
    data.raw ? JSON.stringify(data.raw) : null
  ]);
}

function isMetaSample(v) {
  return v?.from?.username === 'test' || v?.text === 'This is an example.' || v?.media?.id === '123123123';
}

async function processCommentChange({ eventId, entryId, value }) {
  if (isMetaSample(value)) {
    await log({ event_id:eventId, source:'comment', status:'ignored', text:value?.text, username:value?.from?.username, reason:'meta_sample_event_ignored', raw:value });
    return { status:'ignored', reason:'meta_sample_event_ignored' };
  }
  const account = await getAccountByIgUserId(entryId);
  if (!account) {
    await log({ event_id:eventId, source:'comment', status:'ignored', text:value?.text, username:value?.from?.username, reason:`no_account_for_ig_user_id:${entryId}`, raw:value });
    return { status:'ignored', reason:'no_account' };
  }
  let text = value?.text || '';
  let commentId = value?.id;
  let detail = null;
  if (commentId && !text) {
    try { detail = await fetchComment(commentId, account.access_token); text = detail.text || ''; } catch (e) { /* keep empty */ }
  }
  const rules = await getRules(account.id);
  for (const rule of rules) {
    const kw = keywordMatch(text, rule.keywords);
    if (!kw) continue;
    const response = pick(rule.public_replies);
    await log({ account_id:account.id, event_id:eventId, source:'comment', status:'matched', username:value?.from?.username, comment_id:commentId, text, response, reason:`keyword=${kw}`, raw:value });
    if (!rule.reply_to_comments || !response) return { status:'matched_no_reply' };
    if (dryRun()) {
      await log({ account_id:account.id, event_id:eventId, source:'comment', status:'dry_run', comment_id:commentId, text, response, reason:'DRY_RUN=true' });
      return { status:'dry_run' };
    }
    try {
      const api = await replyToComment(commentId, response, account.access_token);
      await log({ account_id:account.id, event_id:eventId, source:'comment', status:'sent', comment_id:commentId, text, response, raw:api });
      return { status:'sent' };
    } catch (e) {
      await log({ account_id:account.id, event_id:eventId, source:'comment', status:'error', comment_id:commentId, text, response, reason:safeJson(e) });
      return { status:'error', error:safeJson(e) };
    }
  }
  await log({ account_id:account.id, event_id:eventId, source:'comment', status:'ignored', comment_id:commentId, text, reason:'keyword_not_matched', raw:value });
  return { status:'ignored', reason:'keyword_not_matched' };
}

async function processMessage({ eventId, entryId, msg }) {
  const account = await getAccountByIgUserId(entryId);
  if (!account) {
    await log({ event_id:eventId, source:'dm', status:'ignored', reason:`no_account_for_ig_user_id:${entryId}`, raw:msg });
    return { status:'ignored', reason:'no_account' };
  }
  if (msg.message_edit) {
    await log({ account_id:account.id, event_id:eventId, source:'dm', status:'ignored', message_id:msg.message_edit.mid, reason:'message_edit_ignored', raw:msg });
    return { status:'ignored', reason:'message_edit' };
  }
  const text = msg.message?.text || msg.postback?.payload || '';
  const senderId = msg.sender?.id || msg.from?.id;
  const messageId = msg.message?.mid || msg.postback?.mid;
  if (!text || !senderId) {
    await log({ account_id:account.id, event_id:eventId, source:'dm', status:'received', sender_id:senderId, message_id:messageId, reason:'message_without_text_or_sender', raw:msg });
    return { status:'received', reason:'message_without_text_or_sender' };
  }
  const rules = await getRules(account.id);
  for (const rule of rules) {
    const kw = keywordMatch(text, rule.keywords);
    if (!kw) continue;
    const response = pick(rule.dm_replies);
    await log({ account_id:account.id, event_id:eventId, source:'dm', status:'matched', sender_id:senderId, message_id:messageId, text, response, reason:`keyword=${kw}`, raw:msg });
    if (!rule.reply_to_dm || !response) return { status:'matched_no_reply' };
    if (dryRun()) {
      await log({ account_id:account.id, event_id:eventId, source:'dm', status:'dry_run', sender_id:senderId, text, response, reason:'DRY_RUN=true' });
      return { status:'dry_run' };
    }
    try {
      const api = await sendDm(senderId, response, account.access_token);
      await log({ account_id:account.id, event_id:eventId, source:'dm', status:'sent', sender_id:senderId, text, response, raw:api });
      return { status:'sent' };
    } catch (e) {
      await log({ account_id:account.id, event_id:eventId, source:'dm', status:'error', sender_id:senderId, text, response, reason:safeJson(e) });
      return { status:'error', error:safeJson(e) };
    }
  }
  await log({ account_id:account.id, event_id:eventId, source:'dm', status:'ignored', sender_id:senderId, message_id:messageId, text, reason:'keyword_not_matched', raw:msg });
  return { status:'ignored', reason:'keyword_not_matched' };
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
