import './config/loadEnv.js';
import express from 'express';
import cors from 'cors';
import chatRoutes from './routes/chat.js';
import movieRoutes from './routes/movies.js';
import activityRoutes from './routes/activity.js';
import { initializeDatabase, getDatabaseHealth } from './database/db.js';
import { checkOllama } from './services/ollama.js';
import { isGroqConfigured } from './services/groq.js';

const app = express();
const port = Number(process.env.PORT || 5000);
const allowedOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

app.use(cors({ origin: allowedOrigin === '*' ? true : allowedOrigin }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (_req, res) => {
  let ollama = { connected: false, model: process.env.OLLAMA_MODEL || 'qwen3:8b', installed: false };
  let storage = { connected: false, storage: 'local-json' };
  try { ollama = await checkOllama(); } catch (error) { ollama.error = error.message; }
  try { storage = await getDatabaseHealth(); } catch (error) { storage.error = error.message; }
  res.json({
    status: 'ok',
    ollama,
    groqConfigured: isGroqConfigured(),
    tmdbConfigured: Boolean(process.env.TMDB_API_KEY?.trim()),
    tmdbKeyLength: process.env.TMDB_API_KEY?.trim().length || 0,
    storage
  });
});

app.use('/api/chat', chatRoutes);
app.use('/api/movies', movieRoutes);
app.use('/api/activity', activityRoutes);

app.use((error, _req, res, _next) => {
  console.error('[server]', error);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: error.message || 'Internal server error.' });
});

await initializeDatabase();
app.listen(port, () => console.log(`[server] MovieMate API listening on http://localhost:${port}`));
