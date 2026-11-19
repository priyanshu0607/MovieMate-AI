import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getShowSeats } from '../cinema/cinemaService.js';

test('get_show_seats resolves an exact showId and returns its ID', async () => {
  const result = await getShowSeats({ showId: 'show-blr-m5-a5-interstellar' });
  assert.equal(result.showId, 'show-blr-m5-a5-interstellar');
  assert.ok(result.categories.length > 0);
  assert.ok(result.categories.every(category => Array.isArray(category.seats) && category.seats.length > 0));
});

test('get_show_seats accepts model-generated show_id alias', async () => {
  const result = await getShowSeats({ show_id: 'show-blr-m5-a5-interstellar' });
  assert.equal(result.showId, 'show-blr-m5-a5-interstellar');
});

test('get_show_seats resolves using exact details when show ID is absent', async () => {
  const result = await getShowSeats({
    movieTitle: 'Interstellar', city: 'Bengaluru', theatre: 'PVR INOX',
    mall: 'M5 Mall', auditorium: 'Audi 5', date: '2026-11-16', time: '19:30'
  });
  assert.ok(result.showId);
  assert.equal(result.movieTitle, 'Interstellar');
  assert.ok(result.categories.flatMap(c => c.seats).length > 0);
});

test('get_show_seats returns a useful error when no show selector is provided', async () => {
  await assert.rejects(() => getShowSeats({}), /Show not found\. Provide the exact showId/);
});
