import { q } from './db.js';

export const CONFIG_KEYS = [
  'APP_BASE_URL',
  'INSTAGRAM_CLIENT_ID',
  'INSTAGRAM_CLIENT_SECRET',
  'META_APP_ID',
  'META_APP_SECRET',
  'META_WEBHOOK_VERIFY_TOKEN',
  'META_GRAPH_VERSION',
  'DRY_RUN',
  'OPENAI_API_KEY'
];

export const SECRET_KEYS = new Set(['INSTAGRAM_CLIENT_SECRET','META_APP_SECRET','OPENAI_API_KEY','META_WEBHOOK_VERIFY_TOKEN']);

export async function loadSettingsIntoEnv() {
  try {
    const { rows } = await q('select key,value from settings');
    for (const row of rows) {
      if (CONFIG_KEYS.includes(row.key) && row.value) process.env[row.key] = row.value;
    }
  } catch (e) {
    console.warn('Settings were not loaded:', e.message);
  }
}

export async function listSettings() {
  const { rows } = await q('select key,value,updated_at from settings order by key');
  const map = Object.fromEntries(rows.map(r => [r.key, r]));
  return CONFIG_KEYS.map(key => {
    const envValue = process.env[key] || '';
    const dbValue = map[key]?.value || '';
    const value = dbValue || envValue || '';
    return {
      key,
      value: SECRET_KEYS.has(key) && value ? '********' : value,
      configured: !!value,
      source: dbValue ? 'database' : envValue ? 'environment' : 'missing',
      updated_at: map[key]?.updated_at || null,
      secret: SECRET_KEYS.has(key)
    };
  });
}

export async function saveSettings(input = {}) {
  const saved = [];
  for (const key of CONFIG_KEYS) {
    if (!(key in input)) continue;
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (value === '********') continue;
    if (!value) {
      await q('delete from settings where key=$1', [key]);
      delete process.env[key];
      saved.push({ key, action:'deleted' });
      continue;
    }
    await q(`insert into settings(key,value,updated_at) values($1,$2,now())
      on conflict(key) do update set value=excluded.value, updated_at=now()`, [key, value]);
    process.env[key] = value;
    saved.push({ key, action:'saved' });
  }
  return saved;
}
