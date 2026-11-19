import axios from 'axios';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const timeoutMs = Number(process.env.GROQ_TIMEOUT_MS || 25000);

export function isGroqConfigured() {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

/**
 * One-shot final reasoning call. Groq never receives the local agent's full
 * message history, tool schemas, raw TMDB payloads, or booking/watchlist data.
 */
export async function generateGroqFinal({ userMessage, draft, evidence }) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error('GROQ_API_KEY is not configured.');

  const compactEvidence = (evidence || []).slice(0, 6).map(item => ({
    tool: String(item.tool || '').slice(0, 50),
    result: item.summary
  }));

  const payload = {
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    temperature: 0.2,
    max_tokens: Number(process.env.GROQ_MAX_OUTPUT_TOKENS || 450),
    stream: false,
    messages: [
      {
        role: 'system',
        content: 'You are MovieMate, a concise movie assistant. Improve the draft using only the supplied evidence. For theatre recommendations, choose only among movies in the supplied screened-candidate list, rank preference fit first and TMDB rating/vote count as supporting signals, and if no movie is a meaningful preference match choose one candidate at random. Preserve the actual showtime/theatre details supplied. Do not invent titles, ratings, availability, facts, or actions. If evidence is insufficient, say so. Do not claim bookings or external actions occurred. Return only the user-facing answer.'
      },
      {
        role: 'user',
        content: JSON.stringify({
          request: String(userMessage || '').slice(0, 1200),
          localAgentDraft: String(draft || '').slice(0, 1800),
          verifiedMovieEvidence: compactEvidence
        })
      }
    ]
  };

  const response = await axios.post(GROQ_URL, payload, {
    timeout: timeoutMs,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  const content = response.data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Groq returned an empty response.');
  return content;
}
