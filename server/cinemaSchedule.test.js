import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { haversineKm } from '../cinema/locationService.js';
import { resolveLocalMovieTitle } from '../cinema/cinemaService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(await readFile(path.resolve(here, '../data/cinema.json'), 'utf8'));

test('demo schedule covers all six Indian metro cities and every seeded theatre', () => {
  assert.equal(data.cities.length, 6);
  assert.equal(data.theatres.length, 8);
  assert.ok(data.cities.every(city => !city.country_code || city.country_code === 'IN'));
  assert.ok(data.theatres.every(theatre => data.cities.some(city => city.name === theatre.city)));
});

test('all seeded screenings are English or Hindi and carry a primary genre', () => {
  assert.ok(data.shows.length > 0);
  assert.ok(data.shows.every(show => ['English', 'Hindi'].includes(show.language)));
  assert.ok(data.shows.every(show => typeof show.genre === 'string' && show.genre.length > 0));
  assert.ok(data.shows.some(show => show.genre === 'Fantasy'));
});

test('requested titles are present in the generated catalogue', () => {
  const titles = new Set(data.movies.map(movie => movie.title));
  for (const title of ['Ramayana: Rise of a Legend', 'Jailer', 'I Play Rocky', 'The Hunger Games', 'Udta Teer']) assert.ok(titles.has(title), title);
});

test('Haversine distance returns zero for identical points and plausible Bengaluru distance', () => {
  assert.equal(haversineKm({ lat: 12.97, lon: 77.59 }, { lat: 12.97, lon: 77.59 }), 0);
  const distance = haversineKm({ lat: 12.97, lon: 77.59 }, { lat: 13.04, lon: 77.60 });
  assert.ok(distance > 7 && distance < 9);
});


test('renamed Ramayana title resolves directly from the local cinema catalogue', async () => {
  assert.equal(await resolveLocalMovieTitle('Ramayana: Rise of a Legend'), 'Ramayana: Rise of a Legend');
});
