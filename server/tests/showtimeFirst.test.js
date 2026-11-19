import test from 'node:test';
import assert from 'node:assert/strict';
import { timeToMinutes } from '../cinema/timeUtils.js';
import { compactToolResult, shouldUseGroq } from '../agent/contextBuilder.js';

test('parses 24-hour showtimes', () => {
  assert.equal(timeToMinutes('20:00'), 1200);
  assert.equal(timeToMinutes('06:30'), 390);
});

test('rejects invalid showtimes', () => {
  assert.throws(() => timeToMinutes('25:90'));
  assert.throws(() => timeToMinutes('8pm'));
});

test('Groq can rank candidates for showtime-first movie recommendations', () => {
  const toolResults = [{ tool: 'find_recommendable_shows', result: { shows: [{ movieTitle: 'Example' }], movies: [{ showTitle: 'Example', rating: 8.1 }] } }];
  assert.equal(shouldUseGroq('Recommend a movie in theatres tonight around 8pm', toolResults), true);
});

test('Groq remains bypassed for cinema-only operations', () => {
  const toolResults = [{ tool: 'find_recommendable_shows', result: { shows: [{ movieTitle: 'Example' }] } }];
  assert.equal(shouldUseGroq('Check showtimes around 8pm', toolResults), false);
  assert.equal(shouldUseGroq('Book two seats', toolResults), false);
});

test('Groq remains available for ordinary TMDB movie recommendations', () => {
  const toolResults = [{ tool: 'search_movies', result: [{ id: 1, title: 'Example', rating: 8 }] }];
  assert.equal(shouldUseGroq('Recommend a movie based on my preferences', toolResults), true);
});


test('showtime compaction preserves every screening returned by the cinema search', () => {
  const screenings = Array.from({ length: 40 }, (_, index) => ({
    movieTitle: 'Example', theatre: `Theatre ${index}`, mall: `Mall ${index}`,
    locality: 'Central', time: '20:00', date: '2026-11-19', showId: `show-${index}`,
    format: '2D', language: 'English'
  }));
  const compacted = compactToolResult({ city: 'Bengaluru', date: '2026-11-19', requestedTime: '20:00', shows: screenings, movies: [] });
  assert.equal(compacted.shows.length, screenings.length);
  assert.equal(compacted.shows.at(-1).showId, 'show-39');
});
