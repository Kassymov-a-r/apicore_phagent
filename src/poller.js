import { q } from './db.js';
import { listMediaWithComments, listConversations } from './instagram.js';
import { handleComment, handleMessage, log, debugLog } from './processor.js';
import { safeJson } from './util.js';

function maskToken(v) {
  if (!v) return null;
  const s = String(v);
  return s.length <= 12 ? '***' : `${s.slice(0, 6)}...${s.slice(-4)}`;
}

export async function pollAccount(account, { verbose = false } = {}) {
  const summary = {
    accountId: account.id,
    account: account.username || account.ig_user_id,
    igUserId: account.ig_user_id,
    comments: 0,
    messages: 0,
    errors: []
  };

  await debugLog({
    account_id: account.id,
    source: 'poll',
    status: verbose ? 'poll_started' : 'debug_poll_started',
    reason: verbose ? 'Manual polling started for comments and Direct messages' : 'Auto polling started',
    raw: { account: { id: account.id, username: account.username, ig_user_id: account.ig_user_id, active: account.active, method: account.connection_method, token: maskToken(account.access_token) }, verbose }
  });

  try {
    const mediaLimit = Math.max(10, Number(process.env.POLL_MEDIA_LIMIT || 50));
    await debugLog({ account_id: account.id, source:'poll', status:'debug_poll_media_request', reason:`requesting media with comments; limit=${mediaLimit}`, raw:{ endpoint:'/me/media', fields:'id,caption,media_type,media_product_type,permalink,timestamp,comments_count + explicit /{media_id}/comments per media', limit:mediaLimit, strategy:'separate_media_then_comments_edge' } });
    const media = await listMediaWithComments(account.access_token, mediaLimit);
    const mediaCount = (media.data || []).length;
    summary.media_limit = mediaLimit;
    summary.media_diagnostics = (media.data || []).map(item => ({
      id: item.id,
      media_type: item.media_type,
      media_product_type: item.media_product_type,
      permalink: item.permalink,
      timestamp: item.timestamp,
      comments_count: item.comments_count ?? null,
      fetched_comments: item.comments?.data?.length || 0,
      comments_fetch: item.comments_fetch || null,
      sample_comments: (item.comments?.data || []).slice(0, 3).map(c => ({ id:c.id, username:c.username, text:c.text, timestamp:c.timestamp })),
      caption: item.caption ? String(item.caption).slice(0, 120) : ''
    }));
    summary.media_with_fetched_comments = summary.media_diagnostics.filter(x => x.fetched_comments > 0).length;
    summary.media_with_comments_count = summary.media_diagnostics.filter(x => Number(x.comments_count || 0) > 0).length;
    summary.media_comment_fetch_attempts = summary.media_diagnostics.filter(x => x.comments_fetch?.attempted).length;
    summary.media_comment_fetch_errors = summary.media_diagnostics.filter(x => x.comments_fetch && x.comments_fetch.ok === false).length;
    summary.media = mediaCount;

    await debugLog({
      account_id: account.id,
      source:'poll',
      status:'debug_poll_media_response',
      reason:`media=${mediaCount}; media_with_comments_count=${summary.media_with_comments_count}; media_with_fetched_comments=${summary.media_with_fetched_comments}`,
      raw:{ diagnostics: summary.media_diagnostics, paging: media.paging || null, media_raw: media.media_raw || null, rawSummary: { mediaCount, mediaWithCommentsCount: summary.media_with_comments_count, mediaWithFetchedComments: summary.media_with_fetched_comments, mediaCommentFetchAttempts: summary.media_comment_fetch_attempts, mediaCommentFetchErrors: summary.media_comment_fetch_errors } }
    });

    if (verbose) {
      for (const item of summary.media_diagnostics.slice(0, 50)) {
        await debugLog({ account_id: account.id, source:'poll_media_item', status:'debug_media_item', media_id:item.id, reason:`comments_count=${item.comments_count}; fetched_comments=${item.fetched_comments}; fetch_ok=${item.comments_fetch?.ok}; fetch_error=${item.comments_fetch?.error || ''}`, raw:item });
      }
    }

    for (const item of media.data || []) {
      for (const c of item.comments?.data || []) {
        summary.comments++;
        await debugLog({ account_id: account.id, source:'comment_poll', status:'debug_poll_comment_found', username:c.username, comment_id:c.id, media_id:item.id, text:c.text, reason:'comment found in media comments edge', raw:{ media:item, comment:c } });
        await handleComment({
          account,
          source: 'comment_poll',
          value: { id: c.id, text: c.text, username: c.username, from: c.from, media: { id: item.id, media_product_type: item.media_type } }
        });
      }
    }
  } catch (e) {
    const err = safeJson(e);
    summary.errors.push({ source: 'comments', error: err });
    await log({ account_id: account.id, source:'poll', status:'error', reason:`comments_poll_failed:${err}`, raw:{ step:'comments_poll', error:err } });
  }

  try {
    await debugLog({ account_id: account.id, source:'poll', status:'debug_poll_conversations_request', reason:'requesting Instagram conversations', raw:{ endpoint:'/me/conversations', platform:'instagram', fields:'id,updated_time,messages.limit(5){id,created_time,from,to,message}', limit:10 } });
    const conv = await listConversations(account.access_token, 10);
    const convCount = (conv.data || []).length;
    summary.conversations = convCount;
    summary.conversation_diagnostics = (conv.data || []).map(c => ({ id:c.id, updated_time:c.updated_time, messages_count:c.messages?.data?.length || 0, sample_messages:(c.messages?.data || []).slice(0,3).map(m=>({ id:m.id, from:m.from, to:m.to, message:m.message, created_time:m.created_time })) }));
    await debugLog({ account_id: account.id, source:'poll', status:'debug_poll_conversations_response', reason:`conversations=${convCount}; messages_in_payload=${summary.conversation_diagnostics.reduce((s,x)=>s+x.messages_count,0)}`, raw:{ diagnostics:summary.conversation_diagnostics, paging:conv.paging || null } });
    for (const c of conv.data || []) {
      for (const m of c.messages?.data || []) {
        summary.messages++;
        await debugLog({ account_id: account.id, source:'dm_poll', status:'debug_poll_message_found', sender_id:m.from?.id, message_id:m.id, text:m.message, reason:'message found in conversations edge', raw:{ conversation:c.id, message:m } });
        await handleMessage({
          account,
          source: 'dm_poll',
          msg: {
            sender: { id: m.from?.id },
            message: { mid: m.id, text: m.message },
            raw_conversation_id: c.id,
            raw_message: m
          }
        });
      }
    }
  } catch (e) {
    const err = safeJson(e);
    summary.errors.push({ source: 'messages', error: err });
    await log({ account_id: account.id, source:'poll', status:'error', reason:`messages_poll_failed:${err}`, raw:{ step:'messages_poll', error:err } });
  }

  if (verbose || summary.comments === 0 && summary.messages === 0) {
    let reason = `poll_summary: media=${summary.media ?? 'n/a'} media_with_comments_count=${summary.media_with_comments_count ?? 'n/a'} media_with_fetched_comments=${summary.media_with_fetched_comments ?? 'n/a'} comment_fetch_attempts=${summary.media_comment_fetch_attempts ?? 'n/a'} comment_fetch_errors=${summary.media_comment_fetch_errors ?? 'n/a'} comments=${summary.comments} conversations=${summary.conversations ?? 'n/a'} messages=${summary.messages} errors=${summary.errors.length}`;
    if (!summary.comments && summary.media_with_comments_count > 0 && summary.media_comment_fetch_errors > 0) reason += '; comments_edge_errors_seen_expand_log';
    if (!summary.comments && summary.media_with_comments_count > 0 && !summary.media_comment_fetch_errors) reason += '; comments_count_exists_but_comments_edge_empty_or_limited';
    if (!summary.comments && summary.media_with_comments_count === 0) reason += '; latest_media_have_no_comments';
    if (!summary.messages && summary.conversations === 0) reason += '; no_conversations_returned_by_api';
    await log({ account_id: account.id, source: 'poll', status: summary.errors.length ? 'poll_finished_with_errors' : 'poll_finished', reason, raw: summary });
  }

  return summary;
}

export async function pollAllAccounts({ verbose = false } = {}) {
  const { rows } = await q('select * from instagram_accounts where active=true order by id desc');
  const out = [];
  await debugLog({ source:'poll', status:'debug_poll_accounts_loaded', reason:`active_accounts=${rows.length}`, raw:{ activeAccounts: rows.map(a => ({ id:a.id, username:a.username, ig_user_id:a.ig_user_id, active:a.active, method:a.connection_method, tokenExpiresAt:a.token_expires_at, token:maskToken(a.access_token) })) } });
  if (!rows.length && verbose) {
    await log({ source:'poll', status:'poll_finished', reason:'poll_summary: no active accounts connected', raw:{ activeAccounts:0 } });
  }
  for (const account of rows) out.push(await pollAccount(account, { verbose }));
  return out;
}
