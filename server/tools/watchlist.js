import { addToWatchlist, getWatchlist, removeFromWatchlist } from '../database/db.js';

export const addWatchlistTool = {
  name: 'add_to_watchlist',
  description: 'Save a movie to the user watchlist. Only call after the user explicitly asks to save/add it or confirms a selection.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'integer' }, title: { type: 'string' }, year: { type: 'string' },
      poster: { type: 'string' }, rating: { type: 'number' }, overview: { type: 'string' }
    },
    required: ['id', 'title']
  },
  execute: addToWatchlist
};

export const listWatchlistTool = {
  name: 'get_watchlist',
  description: 'Retrieve the user saved movie watchlist.',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: getWatchlist
};

export const removeWatchlistTool = {
  name: 'remove_from_watchlist',
  description: 'Remove a movie from the watchlist by TMDB movie ID. Only call when the user asks to remove it.',
  parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  execute: async ({ id }) => ({ removed: await removeFromWatchlist(id) })
};
