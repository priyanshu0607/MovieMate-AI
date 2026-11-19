import { Router } from 'express';
import { activityBus, getRecentActivity } from '../database/db.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try { res.json(await getRecentActivity(req.query.limit)); }
  catch (error) { next(error); }
});

router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: 'connected', at: new Date().toISOString() })}\n\n`);

  const send = event => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'activity', event })}\n\n`);
  };
  activityBus.on('activity', send);
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    activityBus.off('activity', send);
  });
});

export default router;
