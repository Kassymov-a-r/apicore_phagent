import { q } from './db.js';
import { listMediaWithComments, listConversations } from './instagram.js';
import { handleComment, handleMessage, log } from './processor.js';
import { safeJson } from './util.js';

export async function pollAccount(account) {
  const summary = { account: account.username || account.ig_user_id, comments: 0, messages: 0, errors: [] };
  try {
    const media = await listMediaWithComments(account.access_token, 10);
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
  } catch (e) {
    summary.errors.push({ source: 'comments', error: safeJson(e) });
    await log({ account_id: account.id, source:'poll', status:'error', reason:`comments_poll_failed:${safeJson(e)}` });
  }
  try {
    const conv = await listConversations(account.access_token, 10);
    for (const c of conv.data || []) {
      for (const m of c.messages?.data || []) {
        summary.messages++;
        await handleMessage({
          account,
          source: 'dm_poll',
          msg: {
            sender: { id: m.from?.id },
            message: { mid: m.id, text: m.message },
            raw_conversation_id: c.id
          }
        });
      }
    }
  } catch (e) {
    summary.errors.push({ source: 'messages', error: safeJson(e) });
    await log({ account_id: account.id, source:'poll', status:'error', reason:`messages_poll_failed:${safeJson(e)}` });
  }
  return summary;
}

export async function pollAllAccounts() {
  const { rows } = await q('select * from instagram_accounts where active=true order by id desc');
  const out = [];
  for (const account of rows) out.push(await pollAccount(account));
  return out;
}
