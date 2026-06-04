import { q } from './db.js';
import { listMediaWithComments, listConversations } from './instagram.js';
import { handleComment, handleMessage, log } from './processor.js';
import { safeJson } from './util.js';

export async function pollAccount(account, { verbose = false } = {}) {
  const summary = { accountId: account.id, account: account.username || account.ig_user_id, comments: 0, messages: 0, errors: [] };

  if (verbose) {
    await log({ account_id: account.id, source: 'poll', status: 'poll_started', reason: 'Manual polling started for comments and Direct messages' });
  }

  try {
    const media = await listMediaWithComments(account.access_token, 10);
    const mediaCount = (media.data || []).length;
    for (const item of media.data || []) {
      for (const c of item.comments?.data || []) {
        summary.comments++;
        await handleComment({
          account,
          source: 'comment_poll',
          value: { id: c.id, text: c.text, username: c.username, from: c.from, media: { id: item.id, media_product_type: item.media_type } }
        });
      }
    }
    summary.media = mediaCount;
  } catch (e) {
    const err = safeJson(e);
    summary.errors.push({ source: 'comments', error: err });
    await log({ account_id: account.id, source:'poll', status:'error', reason:`comments_poll_failed:${err}` });
  }

  try {
    const conv = await listConversations(account.access_token, 10);
    const convCount = (conv.data || []).length;
    for (const c of conv.data || []) {
      for (const m of c.messages?.data || []) {
        summary.messages++;
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
    summary.conversations = convCount;
  } catch (e) {
    const err = safeJson(e);
    summary.errors.push({ source: 'messages', error: err });
    await log({ account_id: account.id, source:'poll', status:'error', reason:`messages_poll_failed:${err}` });
  }

  if (verbose || summary.comments === 0 && summary.messages === 0) {
    const reason = `poll_summary: media=${summary.media ?? 'n/a'} comments=${summary.comments} conversations=${summary.conversations ?? 'n/a'} messages=${summary.messages} errors=${summary.errors.length}`;
    await log({ account_id: account.id, source: 'poll', status: summary.errors.length ? 'poll_finished_with_errors' : 'poll_finished', reason, raw: summary });
  }

  return summary;
}

export async function pollAllAccounts({ verbose = false } = {}) {
  const { rows } = await q('select * from instagram_accounts where active=true order by id desc');
  const out = [];
  if (!rows.length && verbose) {
    await log({ source:'poll', status:'poll_finished', reason:'poll_summary: no active accounts connected' });
  }
  for (const account of rows) out.push(await pollAccount(account, { verbose }));
  return out;
}
