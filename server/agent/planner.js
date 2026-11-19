import { chatWithOllama } from '../services/ollama.js';
import { toolsForIntent } from './toolRegistry.js';
import { systemPrompt } from './systemPrompt.js';
import { compactHistory } from './contextBuilder.js';

export async function planNextAction(messages, intent = 'movie') {
  // Keep local context bounded too; persistent history remains untouched in JSON.
  const boundedMessages = compactHistory(messages, 8, 4200);
  return chatWithOllama({
    messages: [{ role: 'system', content: systemPrompt }, ...boundedMessages],
    tools: toolsForIntent(intent)
  });
}
