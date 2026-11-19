import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRequestedTime, extractSupportedCity, isCinemaTimeWorkflowRequest
} from '../cinema/locationResolver.js';
import { isLikelyPendingCinemaReply, MOVIE_DISCOVERY_TOOL_NAMES, CINEMA_TOOL_NAMES } from '../agent/workflowPolicy.js';

test('ordinary movie recommendations stay on the TMDB workflow', () => {
  assert.equal(isCinemaTimeWorkflowRequest('Recommend 3 highly rated sci-fi thrillers under 2 hours'), false);
  assert.equal(isCinemaTimeWorkflowRequest('Recommend a movie to me'), false);
  assert.equal(isCinemaTimeWorkflowRequest('Get me 3 sci-fi movies'), false);
});

test('explicit showtime and booking requests enter the cinema workflow', () => {
  assert.equal(isCinemaTimeWorkflowRequest('Are there showtimes near me for Dune?'), true);
  assert.equal(isCinemaTimeWorkflowRequest('Book a movie for me at 8pm'), true);
  assert.equal(isCinemaTimeWorkflowRequest('Get me tickets for Dune'), true);
  assert.equal(isCinemaTimeWorkflowRequest('Recommend a movie to watch in theatres tonight'), true);
  assert.equal(isCinemaTimeWorkflowRequest('Find a 7 PM show for a movie near me and show me the available seats.'), true);
  assert.equal(isCinemaTimeWorkflowRequest('Show me available seats for the 8pm show'), true);
});

test('booking/showtime flow can request a missing time', () => {
  assert.equal(extractRequestedTime('Book a movie for me'), null);
  assert.equal(extractRequestedTime('8pm'), '20:00');
});

test('supported city names and common aliases are recognized', () => {
  assert.equal(extractSupportedCity('I am in Bangalore'), 'Bengaluru');
  assert.equal(extractSupportedCity('Find screenings in Pune'), 'Pune');
  assert.equal(extractSupportedCity('I am somewhere else'), null);
});


test('the reported sci-fi recommendation request is never classified as cinema intent', () => {
  const prompt = 'Find 3 highly rated sci-fi thrillers released after 2020, under 2 hours.';
  assert.equal(isCinemaTimeWorkflowRequest(prompt), false);
  const names = MOVIE_DISCOVERY_TOOL_NAMES;
  assert.ok(names.includes('search_movies'));
  assert.ok(!names.includes('find_recommendable_shows'));
  assert.ok(!names.includes('search_cinema_shows'));
  assert.ok(!names.includes('find_nearby_cinemas'));
});

test('cinema tools are available only in explicit cinema workflows', () => {
  const names = [...MOVIE_DISCOVERY_TOOL_NAMES, ...CINEMA_TOOL_NAMES];
  assert.ok(names.includes('find_recommendable_shows'));
  assert.ok(names.includes('search_cinema_shows'));
});

test('a fresh recommendation does not resume an old pending cinema prompt', () => {
  const history = [{ role: 'assistant', content: 'What time would you like to watch the movie?' }];
  assert.equal(isLikelyPendingCinemaReply(history, 'Find 3 highly rated sci-fi thrillers released after 2020, under 2 hours.'), false);
  assert.equal(isLikelyPendingCinemaReply(history, '8pm'), true);
  assert.equal(isLikelyPendingCinemaReply(history, 'in Bengaluru'), true);
});

import { detectRequestIntents, isSeatAvailabilityRequest, buildMovieRecommendationSearch, shouldClearPendingCinemaState } from '../agent/workflowPolicy.js';

test('multi-intent cinema request detects showtime and seat availability independently', () => {
  const intents = detectRequestIntents('Find a 7 PM show for a movie near me and show me the available seats.');
  assert.equal(intents.showtimes, true);
  assert.equal(intents.seatAvailability, true);
  assert.equal(intents.booking, false);
  assert.equal(isSeatAvailabilityRequest('Find a 7 PM show and show me available seats'), true);
});

test('multi-intent movie requests preserve every explicitly requested action', () => {
  const intents = detectRequestIntents('Find Interstellar, show me its trailer, and tell me where I can stream it.');
  assert.equal(intents.trailer, true);
  assert.equal(intents.streaming, true);
  assert.equal(intents.movieDetails, false);
  assert.equal(intents.booking, false);
});

test('booking intent is distinguished from read-only seat availability', () => {
  const availability = detectRequestIntents('Show me available seats for the 8 PM show');
  const booking = detectRequestIntents('Book 2 tickets for the 8 PM show');
  assert.equal(availability.seatAvailability, true);
  assert.equal(availability.booking, false);
  assert.equal(booking.booking, true);
});


import { isExplicitBookingConfirmation, assistantRequestedBookingConfirmation } from '../agent/workflowPolicy.js';

test('booking is authorised only after an explicit confirmation of a complete booking summary', () => {
  const summary = [{ role: 'assistant', content: 'Booking summary: Movie Dune, PVR Orion, 7:00 PM. Seats: P5, P6. Total amount: ₹900. Please confirm this booking.' }];
  assert.equal(isExplicitBookingConfirmation('Yes, confirm booking.'), true);
  assert.equal(assistantRequestedBookingConfirmation(summary), true);
  assert.equal(assistantRequestedBookingConfirmation([{ role: 'assistant', content: 'I found a show. Shall I book it?' }]), false);
  assert.equal(isExplicitBookingConfirmation('Show me seats'), false);
});


test('plain movie recommendation requests are parsed deterministically', () => {
  assert.deepEqual(buildMovieRecommendationSearch('Suggest 3 comedy movies'), {
    count: 3, args: { sortBy: 'popularity.desc', page: 1, genre: '35' }
  });
  const filtered = buildMovieRecommendationSearch('Recommend 3 highly rated sci-fi thrillers released after 2020, under 2 hours');
  assert.equal(filtered.count, 3);
  assert.equal(filtered.args.genre, '878,53');
  assert.equal(filtered.args.releaseYearGte, 2021);
  assert.equal(filtered.args.maxRuntime, 119);
  assert.equal(filtered.args.sortBy, 'vote_average.desc');
});

test('recommendation intent recognizes natural-language requests without the word movie', () => {
  assert.equal(detectRequestIntents('I want 3 comedy movies under 2 hours').movieRecommendation, true);
  assert.equal(detectRequestIntents('Find 3 highly rated sci-fi thrillers').movieRecommendation, true);
  assert.equal(detectRequestIntents('Recommend a comedy movie').movieRecommendation, true);
});

test('recommendation parser extracts count, plural genres, runtime and quality sorting', () => {
  const comedy = buildMovieRecommendationSearch('I want 3 comedy movies under 2 hours');
  assert.equal(comedy.count, 3);
  assert.equal(comedy.args.genre, '35');
  assert.equal(comedy.args.maxRuntime, 119);

  const sciFiThrillers = buildMovieRecommendationSearch('Find 3 highly rated sci-fi thrillers');
  assert.equal(sciFiThrillers.count, 3);
  assert.equal(sciFiThrillers.args.genre, '878,53');
  assert.equal(sciFiThrillers.args.sortBy, 'vote_average.desc');
});

test('cinema requests do not get mistaken for plain movie recommendations', () => {
  const intents = detectRequestIntents('Find a 7 PM show for a movie near me and show me the available seats');
  assert.equal(intents.seatAvailability, true);
  assert.equal(intents.booking, false);
  assert.equal(isCinemaTimeWorkflowRequest('Find a 7 PM show for a movie near me and show me the available seats'), true);
  assert.equal(isCinemaTimeWorkflowRequest('I want 3 comedy movies under 2 hours'), false);
  assert.equal(isCinemaTimeWorkflowRequest('Find 3 highly rated sci-fi thrillers'), false);
});


test('fresh recommendation requests release stale booking state and continue to movie discovery', () => {
  const staleStages = ['picking_show', 'awaiting_ticket_count', 'awaiting_seat_choice', 'awaiting_confirm'];
  for (const stage of staleStages) {
    const intents = detectRequestIntents('Suggest 5 horror movies');
    assert.equal(shouldClearPendingCinemaState(stage, intents, null), true, `${stage} should clear for a new recommendation`);
    const superhero = detectRequestIntents('suggest a superhero movie');
    assert.equal(superhero.movieRecommendation, true);
    assert.equal(shouldClearPendingCinemaState(stage, superhero, null), true);
    const hero = detectRequestIntents('suggest a hero movie');
    assert.equal(hero.movieRecommendation, true);
    assert.equal(shouldClearPendingCinemaState(stage, hero, null), true);
  }
});

test('actual booking-stage replies do not clear their pending booking state', () => {
  const intents = detectRequestIntents('P5 and P6');
  assert.equal(shouldClearPendingCinemaState('awaiting_seat_choice', intents, { intent: 'select_seats' }), false);
  assert.equal(shouldClearPendingCinemaState('awaiting_confirm', {}, { intent: 'confirm' }), false);
});


test('superhero and hero movie requests route to movie discovery with a single requested result', () => {
  for (const prompt of ['suggest a superhero movie', 'suggest a hero movie']) {
    const intents = detectRequestIntents(prompt);
    assert.equal(intents.movieRecommendation, true, `${prompt} should be a recommendation request`);
    const parsed = buildMovieRecommendationSearch(prompt);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.args.genre, '28');
  }
});
