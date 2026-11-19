import axios from 'axios';

const ollama = axios.create({
  baseURL: process.env.OLLAMA_URL || 'http://localhost:11434',
  timeout: 120000
});

export async function chatWithOllama({ messages, tools }) {
  const response = await ollama.post('/api/chat', {
    model: process.env.OLLAMA_MODEL || 'qwen3:8b',
    messages,
    tools,
    stream: false,
    think: false,
    options: { temperature: 0.2 }
  });
  return response.data.message;
}

export async function checkOllama() {
  const response = await ollama.get('/api/tags', { timeout: 5000 });
  const model = process.env.OLLAMA_MODEL || 'qwen3:8b';
  return { connected: true, model, installed: response.data.models?.some(m => m.name === model || m.name.startsWith(`${model}:`)) ?? false };
}
