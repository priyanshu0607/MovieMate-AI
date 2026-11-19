import { Router } from 'express';
import { getWatchlist, removeFromWatchlist } from '../database/db.js';
const router = Router();

router.get('/watchlist', async (_req, res, next) => {
  try { res.json(await getWatchlist()); } catch (error) { next(error); }
});

router.delete('/watchlist/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'Invalid movie ID.' });
  try { res.json({ removed: await removeFromWatchlist(id) }); } catch (error) { next(error); }
});

export default router;
