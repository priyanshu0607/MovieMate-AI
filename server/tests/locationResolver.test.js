import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRequestedTime, indiaLocalDate, isTheatreRecommendationRequest, reverseGeocodeSupportedCity } from '../cinema/locationResolver.js';

test('extracts 8pm and explicit 12-hour times', () => {
  assert.equal(extractRequestedTime('Recommend a movie around 8pm tonight'), '20:00');
  assert.equal(extractRequestedTime('Find a show at 12:15am'), '00:15');
  assert.equal(extractRequestedTime('Find a show at 12pm'), '12:00');
});

test('uses 8pm as the default only for a theatre request tonight', () => {
  assert.equal(extractRequestedTime('Recommend a movie in theatres tonight'), '20:00');
  assert.equal(extractRequestedTime('Recommend a movie tonight'), null);
});

test('recognizes theatre recommendation requests', () => {
  assert.equal(isTheatreRecommendationRequest('Recommend me a movie to watch in theatres tonight around 8pm and book the tickets'), true);
  assert.equal(isTheatreRecommendationRequest('Show me cinema timings tonight'), false);
});

test('calculates the local date using India time rather than server timezone', () => {
  assert.equal(indiaLocalDate(new Date('2026-11-17T19:00:00.000Z')), '2026-11-18');
});

test('reverse geocodes Bengaluru and extracts locality from Photon', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ features: [{ properties: { city: 'Bengaluru', suburb: 'Indiranagar' } }] }) });
  const result = await reverseGeocodeSupportedCity({ lat: 12.97, lon: 77.64 }, fakeFetch);
  assert.deepEqual(result, { supported: true, city: 'Bengaluru', locality: 'Indiranagar', label: 'Indiranagar, Bengaluru' });
});

test('does not guess a city when reverse geocoding returns an unsupported place', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ features: [{ properties: { city: 'Mysuru' } }] }) });
  const result = await reverseGeocodeSupportedCity({ lat: 12.3, lon: 76.6 }, fakeFetch);
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'unsupported_location');
});

test('routes local movie discovery phrased as after a specific time to cinema search', () => {
  assert.equal(isTheatreRecommendationRequest('Find a movie near me, preferably in English, after 8 PM'), true);
});
