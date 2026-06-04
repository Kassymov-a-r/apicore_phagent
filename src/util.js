export function normalize(s='') {
  return String(s).toLowerCase().replace(/ё/g,'е').trim();
}
export function keywordMatch(text, keywords=[]) {
  const n = normalize(text);
  for (const kw of keywords || []) {
    const k = normalize(kw);
    if (!k) continue;
    if (n === k || n.includes(k)) return kw;
  }
  return null;
}
export function pick(arr=[]) {
  const clean = (arr || []).filter(Boolean);
  if (!clean.length) return '';
  return clean[Math.floor(Math.random() * clean.length)];
}
export function safeJson(err) {
  if (!err) return null;
  if (typeof err === 'string') return err;
  return err.message || JSON.stringify(err);
}
