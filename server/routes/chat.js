import { Router } from 'express';
import { runAgent } from '../agent/agent.js';
import { getConversation } from '../database/db.js';
const router = Router();

router.get('/conversation/:id', async (req, res, next) => {
  try { res.json(await getConversation(req.params.id)); }
  catch (error) { next(error); }
});

router.post('/stream', async (req, res) => {
  const { message, conversationId, location } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'A non-empty message is required.' });
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = event => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  try { await runAgent(message.trim(), send, conversationId, location); }
  catch (error) { send({ type: 'error', message: error.message || 'Agent failed.' }); }
  finally {
    if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
  }
});
export default router;
