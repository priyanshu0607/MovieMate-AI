import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRules, CORPUS } from '../agent/intentCorpus.js';
import { extractTicketPriceFilter, detectRequestIntents, shouldPauseBookingForInterruption } from '../agent/workflowPolicy.js';
import { filterShowsByTicketPrice, filterSeatCategoriesByTicketPrice } from '../cinema/ticketPrice.js';
import { parseTicketCount, resolveShowSelection, getSeatOptions, parseSeatLabels } from '../agent/bookingFlow.js';

const shows = [
  { showId: 'show-1', movieTitle: 'Heart of the Beast', theatre: 'PVR INOX', mall: 'M5 Mall', date: '2026-11-18', time: '19:00' },
  { showId: 'show-2', movieTitle: 'Black Gold', theatre: 'PVR INOX', mall: 'M5 Mall', date: '2026-11-18', time: '19:00' },
  { showId: 'show-3', movieTitle: 'Heart of the Beast', theatre: 'Cinepolis', mall: 'Orion Mall', date: '2026-11-18', time: '20:00' }
];

test('the supplied intent corpus passes, including movie-title selection after show discovery', () => {
  for (const [message, expected, session = {}] of CORPUS) {
    const result = classifyRules(message, session);
    assert.equal(result.intent, expected, `${message} should classify as ${expected}, got ${result.intent}`);
  }
});

test('booking follow-up selects exact movie title from pending screenings', () => {
  assert.equal(resolveShowSelection('book Heart of the beast', shows).status, 'ambiguous');
  assert.equal(resolveShowSelection('Heart of the Beast at 7 pm', shows).show.showId, 'show-1');
  assert.equal(resolveShowSelection('option 2', shows).show.showId, 'show-2');
  assert.equal(resolveShowSelection('the first one', shows).show.showId, 'show-1');
});

test('ticket counts accept digits and number words', () => {
  assert.equal(parseTicketCount('2 tickets'), 2);
  assert.equal(parseTicketCount('two please'), 2);
  assert.equal(parseTicketCount('10 seats'), 10);
  assert.equal(parseTicketCount('twenty tickets'), null);
  assert.equal(parseTicketCount('7 pm'), null, 'a showtime must not be interpreted as a ticket count');
  assert.equal(parseTicketCount('7:00 PM'), null, 'a clock time must not be interpreted as a ticket count');
  assert.equal(parseTicketCount('19:00'), null, 'a 24-hour showtime must not be interpreted as a ticket count');
});

test('seat selection parses labels and validates against available options', () => {
  assert.deepEqual(parseSeatLabels('P5 and P6 please'), ['P5', 'P6']);
  const options = getSeatOptions({ categories: [{ category: 'Picture Perfect', price: 450, availableSeats: ['P1','P2','P3','P4'] }] }, 2);
  assert.deepEqual(options[0].recommended, ['P1', 'P2']);
});


test('genre recommendation follow-ups support choosing a title or skipping to genre-wide showtimes', () => {
  assert.equal(classifyRules('2', { stage: 'choosing_genre_movie' }).intent, 'select_movie');
  assert.equal(classifyRules('showtimes', { stage: 'choosing_genre_movie' }).intent, 'skip_movie_choice');
  assert.equal(classifyRules('7 pm', { stage: 'awaiting_genre_showtime' }).intent, 'provide_time');
});

test('cancellation flow requires selecting a booking and confirming it', () => {
  assert.equal(classifyRules('2', { stage: 'cancelling_booking' }).intent, 'select_booking_to_cancel');
  assert.equal(classifyRules('Confirm cancellation', { stage: 'cancelling_booking' }).intent, 'confirm_cancel_booking');
  assert.equal(classifyRules('keep booking', { stage: 'cancelling_booking' }).intent, 'decline');
});


test('ticket quantity changes are classified during an active booking', () => {
  assert.equal(classifyRules('Actually make it 3 tickets', { stage: 'awaiting_confirm' }).intent, 'modify_ticket_count');
  assert.equal(classifyRules('change it to two', { stage: 'awaiting_seat_choice' }).intent, 'modify_ticket_count');
  assert.equal(classifyRules('change the showtime to 9 pm', { stage: 'awaiting_confirm' }).intent, 'modify_showtime');
});

test('ticket price filters parse maximum, minimum and ranges', () => {
  assert.deepEqual(extractTicketPriceFilter('Find movie tickets under ₹250'), { maxPrice: 250 });
  assert.deepEqual(extractTicketPriceFilter('tickets above 180 rupees'), { minPrice: 180 });
  assert.deepEqual(extractTicketPriceFilter('movies between ₹150 and ₹300'), { minPrice: 150, maxPrice: 300 });
  assert.equal(detectRequestIntents('Find movies under 2 hours').ticketPrice, false);
  assert.equal(detectRequestIntents('Find movie tickets under 250').ticketPrice, true);
});


test('a fresh discovery request pauses an active booking but booking edits do not', () => {
  assert.equal(shouldPauseBookingForInterruption('awaiting_seat_choice', { movieRecommendation: true }), true);
  assert.equal(shouldPauseBookingForInterruption('awaiting_confirm', { showtimes: true }, { intent: 'modify_showtime' }), false);
  assert.equal(shouldPauseBookingForInterruption('awaiting_confirm', { trailer: true }), true);
});

test('ticket-price filters retain only screenings with at least one affordable category', () => {
  const shows = [
    { id: 'cheap', seat_categories: { standard: { price: 180 }, recliner: { price: 350 } } },
    { id: 'expensive', seat_categories: { standard: { price: 280 }, recliner: { price: 450 } } }
  ];
  assert.deepEqual(filterShowsByTicketPrice(shows, { maxPrice: 250 }).map(show => show.id), ['cheap']);
  assert.deepEqual(filterSeatCategoriesByTicketPrice([{ price: 180 }, { price: 350 }], { maxPrice: 250 }), [{ price: 180 }]);
});

test('fresh movie discovery interrupts a stale screening-selection stage even when it contains a time', () => {
  const fresh = detectRequestIntents('Find a movie near me, preferably in English, after 8 PM');
  assert.equal(fresh.movieRecommendation, true);
  assert.equal(shouldPauseBookingForInterruption('picking_show', fresh, { intent: 'select_show' }), true);
});
