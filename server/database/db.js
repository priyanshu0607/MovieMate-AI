import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(here, '../data');
const dataFile = path.join(dataDirectory, 'moviemate.json');

const emptyStore = () => ({
  version: 1,
  counters: { messages: 0, executions: 0, toolLogs: 0, activities: 0 },
  conversations: [],
  messages: [],
  conversation_states: [],
  watchlist: [],
  agent_executions: [],
  tool_logs: [],
  activity_events: []
});

export const activityBus = new EventEmitter();
activityBus.setMaxListeners(100);

let writeQueue = Promise.resolve();
let initialized = false;

async function readStore() {
  try {
    const raw = await readFile(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    const defaults = emptyStore();
    return { ...defaults, ...parsed, counters: { ...defaults.counters, ...(parsed.counters || {}) } };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    throw new Error(`Could not read MovieMate data file: ${error.message}`);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function writeStore(store) {
  await mkdir(dataDirectory, { recursive: true });
  // Unique temp names prevent collisions between watcher/server processes.
  const tempFile = `${dataFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  let lastError;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      await rename(tempFile, dataFile);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 6) break;
      await sleep(40 * (attempt + 1));
    }
  }
  try { await unlink(tempFile); } catch {}
  throw new Error(`Could not replace MovieMate data file after retries: ${lastError?.code || ''} ${lastError?.message || ''}`);
}


function mutateStore(mutator) {
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    const result = mutator(store);
    await writeStore(store);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

async function readConsistent(mutator) {
  await writeQueue;
  return mutator(await readStore());
}

export async function initializeDatabase() {
  await mkdir(dataDirectory, { recursive: true });
  await writeQueue;
  const exists = await readStore();
  await writeStore(exists);
  initialized = true;
  if (exists.activity_events.length === 0) {
    await recordActivity('system', 'Local JSON storage initialized', 'success', {
      storage: 'server/data/moviemate.json'
    });
  }
  console.log(`[storage] Using ${dataFile}`);
}

export async function recordActivity(eventType, action, status = 'success', details = {}) {
  const event = await mutateStore(store => {
    const row = {
      id: ++store.counters.activities,
      event_type: eventType,
      action,
      status,
      details: details ?? {},
      created_at: new Date().toISOString()
    };
    store.activity_events.push(row);
    if (store.activity_events.length > 2000) store.activity_events.splice(0, store.activity_events.length - 2000);
    return row;
  });
  activityBus.emit('activity', event);
  return event;
}

export async function ensureConversation(conversationId, title = 'New conversation') {
  return mutateStore(store => {
    let conversation = store.conversations.find(item => item.id === conversationId);
    const now = new Date().toISOString();
    if (!conversation) {
      conversation = { id: conversationId, title: String(title).slice(0, 120), created_at: now, updated_at: now };
      store.conversations.push(conversation);
    } else {
      conversation.updated_at = now;
    }
    return conversation;
  });
}

export async function saveConversation(conversationId, role, content) {
  const row = await mutateStore(store => {
    let conversation = store.conversations.find(item => item.id === conversationId);
    const now = new Date().toISOString();
    if (!conversation) {
      conversation = { id: conversationId, title: String(content).slice(0, 80), created_at: now, updated_at: now };
      store.conversations.push(conversation);
    }
    conversation.updated_at = now;
    const message = {
      id: ++store.counters.messages,
      conversation_id: conversationId,
      role,
      content: String(content),
      created_at: now
    };
    store.messages.push(message);
    return message;
  });
  await recordActivity('message', `Saved ${role} message`, 'success', {
    messageId: row.id, conversationId, role, preview: String(content).slice(0, 180)
  });
  return row;
}

export async function getRecentConversation(conversationId, limit = 12) {
  return readConsistent(store => store.messages
    .filter(message => message.conversation_id === conversationId)
    .slice(-Math.max(1, Number(limit) || 12))
    .map(({ role, content }) => ({ role, content })));
}

export async function getConversation(conversationId) {
  return readConsistent(store => store.messages
    .filter(message => message.conversation_id === conversationId)
    .map(({ id, role, content, created_at }) => ({ id, role, content, created_at })));
}

export async function addToWatchlist(movie) {
  const row = await mutateStore(store => {
    const now = new Date().toISOString();
    const existing = store.watchlist.find(item => Number(item.movie_id) === Number(movie.id));
    const value = {
      movie_id: Number(movie.id), title: movie.title, year: movie.year || null,
      poster: movie.poster || null, rating: movie.rating ?? null,
      overview: movie.overview || null,
      added_at: existing?.added_at || now, updated_at: now
    };
    if (existing) Object.assign(existing, value);
    else store.watchlist.push(value);
    return value;
  });
  await recordActivity('watchlist', 'Movie saved to watchlist', 'success', { movieId: movie.id, title: movie.title });
  return row;
}

export async function getWatchlist() {
  return readConsistent(store => [...store.watchlist].sort((a, b) => b.added_at.localeCompare(a.added_at)));
}

export async function removeFromWatchlist(id) {
  const removed = await mutateStore(store => {
    const index = store.watchlist.findIndex(item => Number(item.movie_id) === Number(id));
    if (index < 0) return null;
    return store.watchlist.splice(index, 1)[0];
  });
  if (removed) await recordActivity('watchlist', 'Movie removed from watchlist', 'success', { movieId: removed.movie_id, title: removed.title });
  return Boolean(removed);
}

export async function startExecution(conversationId, userRequest) {
  const row = await mutateStore(store => {
    const execution = {
      id: ++store.counters.executions, conversation_id: conversationId,
      user_request: userRequest, status: 'running', steps: 0, error: null,
      started_at: new Date().toISOString(), completed_at: null
    };
    store.agent_executions.push(execution);
    return execution;
  });
  await recordActivity('agent', 'Agent execution started', 'running', {
    executionId: row.id, conversationId, request: userRequest.slice(0, 220)
  });
  return row;
}

export async function finishExecution(id, status, steps, error = null) {
  const row = await mutateStore(store => {
    const execution = store.agent_executions.find(item => item.id === Number(id));
    if (!execution) return null;
    Object.assign(execution, { status, steps, error, completed_at: new Date().toISOString() });
    return execution;
  });
  if (row) await recordActivity('agent', `Agent execution ${status}`, status === 'failed' ? 'error' : 'success', { executionId: id, steps, error });
  return row;
}

export async function saveToolLog({ executionId, conversationId, toolName, args, result, status, durationMs, error }) {
  const row = await mutateStore(store => {
    const log = {
      id: ++store.counters.toolLogs, execution_id: executionId, conversation_id: conversationId,
      tool_name: toolName, arguments: args ?? {}, result: result === undefined ? null : result,
      status, duration_ms: durationMs ?? null, error: error ?? null,
      created_at: new Date().toISOString()
    };
    store.tool_logs.push(log);
    return log;
  });
  await recordActivity('tool', `Tool ${toolName} ${status}`, status === 'error' ? 'error' : 'success', {
    toolLogId: row.id, executionId, conversationId, toolName,
    arguments: args ?? {}, resultPreview: result === undefined ? null : JSON.stringify(result).slice(0, 500),
    durationMs: durationMs ?? null, error: error ?? null
  });
  return row;
}

export async function getRecentActivity(limit = 40) {
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 100);
  return readConsistent(store => store.activity_events.slice(-safeLimit).reverse());
}

export async function getConversationState(conversationId) {
  return readConsistent(store => {
    const row = store.conversation_states.find(item => item.conversation_id === conversationId);
    return row ? structuredClone(row.state) : null;
  });
}

export async function setConversationState(conversationId, state) {
  return mutateStore(store => {
    let row = store.conversation_states.find(item => item.conversation_id === conversationId);
    if (!row) {
      row = { conversation_id: conversationId, state: {}, updated_at: new Date().toISOString() };
      store.conversation_states.push(row);
    }
    row.state = structuredClone(state || {});
    row.updated_at = new Date().toISOString();
    return row.state;
  });
}

export async function clearConversationState(conversationId) {
  return mutateStore(store => {
    const index = store.conversation_states.findIndex(item => item.conversation_id === conversationId);
    if (index >= 0) store.conversation_states.splice(index, 1);
    return index >= 0;
  });
}

export async function getDatabaseHealth() {
  await readConsistent(store => store);
  return { connected: true, storage: 'local-json', file: 'server/data/moviemate.json', initialized };
}
