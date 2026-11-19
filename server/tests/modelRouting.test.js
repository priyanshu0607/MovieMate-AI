import test from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory, makeGroqEvidence, shouldUseGroq } from '../agent/contextBuilder.js';

test('Groq is selected for complex movie recommendations with movie evidence', () => {
  assert.equal(shouldUseGroq('Recommend similar movies and compare them', [
    { tool: 'search_movies', result: [{ id: 1, title: 'Arrival', rating: 7.9 }] }
  ]), true);
});

test('Groq is not selected for bookings or watchlist requests', () => {
  const evidence = [{ tool: 'search_movies', result: [{ id: 1, title: 'Arrival' }] }];
  assert.equal(shouldUseGroq('Book two seats for this movie', evidence), false);
  assert.equal(shouldUseGroq('Show my watchlist', evidence), false);
});


test('Groq is bypassed for cinema show searches, even when movie evidence exists', () => {
  const evidence = [
    { tool: 'search_movies', result: [{ id: 1, title: 'Arrival' }] },
    { tool: 'search_cinema_shows', result: [{ movieTitle: 'Arrival', theatre: 'PVR' }] }
  ];
  assert.equal(shouldUseGroq('Check shows for Arrival', evidence), false);
  assert.equal(shouldUseGroq('Recommend a movie and check its showtimes', evidence), false);
});

test('Groq is bypassed for cinema-only and seat workflows', () => {
  assert.equal(shouldUseGroq('Find cinema shows near me', [
    { tool: 'search_cinema_shows', result: [{ theatre: 'PVR' }] }
  ]), false);
  assert.equal(shouldUseGroq('Are seats P7 and P8 available?', [
    { tool: 'search_movies', result: [{ id: 1, title: 'Arrival' }] }
  ]), false);
});

test('Groq evidence excludes private and mutating local tools', () => {
  const evidence = makeGroqEvidence([
    { tool: 'search_movies', result: [{ id: 1, title: 'Arrival', rating: 7.9 }] },
    { tool: 'list_my_bookings', result: [{ seats: ['P7', 'P8'] }] },
    { tool: 'get_watchlist', result: [{ title: 'Private list item' }] }
  ]);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].summary[0].title, 'Arrival');
});

test('bounded local history preserves Ollama tool-call handoff fields', () => {
  const toolCalls = [{ function: { name: 'search_movies', arguments: { query: 'Arrival' } } }];
  const result = compactHistory([
    { role: 'assistant', content: '', tool_calls: toolCalls },
    { role: 'tool', tool_name: 'search_movies', content: 'result' }
  ]);
  assert.deepEqual(result[0].tool_calls, toolCalls);
  assert.equal(result[1].tool_name, 'search_movies');
});
