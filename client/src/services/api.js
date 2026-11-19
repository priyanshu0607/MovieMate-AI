const API = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

export async function getHealth() {
  const res = await fetch(`${API}/health`);
  if (!res.ok) throw new Error('Backend unavailable');
  return res.json();
}
export async function getConversation(id) {
  const res = await fetch(`${API}/chat/conversation/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('Could not load conversation history');
  return res.json();
}
export async function getWatchlist() {
  const res = await fetch(`${API}/movies/watchlist`);
  if (!res.ok) throw new Error('Could not load watchlist');
  return res.json();
}
export async function removeWatchlist(id) {
  const res = await fetch(`${API}/movies/watchlist/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Could not remove movie');
  return res.json();
}
export async function sendChat(message, onEvent, conversationId, location = null) {
  const res = await fetch(`${API}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversationId, location })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Chat request failed');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      try { onEvent(JSON.parse(payload)); } catch { /* Ignore malformed events. */ }
    }
  }
}
