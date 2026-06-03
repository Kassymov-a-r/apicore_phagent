import OpenAI from 'openai';

export async function generateReplies({ purpose, keyword, tone = 'friendly', count = 5 }) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      ok: false,
      error: 'OPENAI_API_KEY is not set',
      suggestions: []
    };
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const prompt = `Generate ${count} short Instagram ${purpose} reply variants.\nKeyword: ${keyword}\nTone: ${tone}\nRequirements: natural, concise, not spammy, no promises, max 120 characters each. Return only a JSON array of strings.`;
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8
  });
  const text = res.choices?.[0]?.message?.content || '[]';
  try {
    const suggestions = JSON.parse(text);
    return { ok: true, suggestions: Array.isArray(suggestions) ? suggestions : [] };
  } catch {
    return { ok: true, suggestions: text.split('\n').map(s => s.replace(/^[-\d.\s]+/, '').trim()).filter(Boolean) };
  }
}
