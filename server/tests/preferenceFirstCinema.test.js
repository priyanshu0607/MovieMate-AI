import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCinemaMoviePreference } from '../agent/workflowPolicy.js';
import { isCinemaTimeWorkflowRequest } from '../cinema/locationResolver.js';
import { filterShowsByCandidateTitles, filterShowsByGenre } from '../cinema/movieMatching.js';

test('genre-led timed cinema requests are routed to cinema discovery', () => {
  assert.equal(isCinemaTimeWorkflowRequest('Find a comedy movie near me at 7 PM'), true);
  assert.equal(isCinemaTimeWorkflowRequest('Find a horror movie playing near me around 8 PM'), true);
  assert.equal(isCinemaTimeWorkflowRequest('Find Dune near me at 7 PM'), true);
  assert.equal(isCinemaTimeWorkflowRequest('Find Interstellar showtimes near me at 7 PM'), true);
});

test('generic timed show search remains unfiltered', () => {
  assert.equal(isCinemaTimeWorkflowRequest('Find a 7 PM show for a movie near me and show me the available seats'), true);
  assert.equal(buildCinemaMoviePreference('Find a 7 PM show for a movie near me and show me the available seats'), null);
});

test('genre preference extracts TMDB genre IDs before searching screenings', () => {
  assert.deepEqual(buildCinemaMoviePreference('Find a comedy movie near me at 7 PM'), {
    type: 'genre', genreIds: ['35'], searchArgs: { sortBy: 'popularity.desc', page: 1, genre: '35' }, count: 1, label: 'Comedy'
  });
  assert.deepEqual(buildCinemaMoviePreference('Find a sci-fi thriller playing near me at 7 PM'), {
    type: 'genre', genreIds: ['878', '53'], searchArgs: { sortBy: 'popularity.desc', page: 1, genre: '878,53' }, count: 5, label: 'Science Fiction + Thriller'
  });
});

test('explicit movie title is extracted for exact schedule matching', () => {
  assert.deepEqual(buildCinemaMoviePreference('Find Interstellar showtimes near me at 7 PM'), {
    type: 'title', title: 'Interstellar', label: 'Interstellar', count: 5
  });
  assert.deepEqual(buildCinemaMoviePreference('Find Dune: Part Two near me at 7 PM'), {
    type: 'title', title: 'Dune: Part Two', label: 'Dune: Part Two', count: 5
  });
});

test('schedule is intersected with TMDB candidate titles without unrelated fallback', () => {
  const shows = [
    { movieTitle: 'Dune: Part Two', showId: '1' },
    { movieTitle: 'Interstellar', showId: '2' },
    { movieTitle: 'Black Gold', showId: '3' }
  ];
  assert.deepEqual(filterShowsByCandidateTitles(shows, ['dune part two', 'interstellar']).map(s => s.showId), ['1', '2']);
  assert.deepEqual(filterShowsByCandidateTitles(shows, ['The Batman']), []);
});

test('cinema movie preference preserves requested count and quality filters', () => {
  const preference = buildCinemaMoviePreference('Find 3 highly rated comedy movies playing near me at 7 PM');
  assert.equal(preference.count, 3);
  assert.equal(preference.searchArgs.sortBy, 'vote_average.desc');
  assert.equal(preference.searchArgs.genre, '35');
});

test('genre-filtered cinema screenings return only the requested primary genre', () => {
  const shows = [
    { movieTitle: 'Ramayana', genre: 'Fantasy' },
    { movieTitle: 'Interstellar', genre: 'Science Fiction' },
    { movieTitle: 'The Cat in the Hat', genre: 'Fantasy' }
  ];
  assert.deepEqual(filterShowsByGenre(shows, 'Fantasy').map(show => show.movieTitle), ['Ramayana', 'The Cat in the Hat']);
});

test('natural fantasy-film wording is parsed as a Fantasy preference', () => {
  const preference = buildCinemaMoviePreference('I want to watch a fantasy film');
  assert.equal(preference?.type, 'genre');
  assert.equal(preference?.label, 'Fantasy');
});


test('direct booking requests preserve the full movie title even before time and location are supplied', () => {
  assert.deepEqual(buildCinemaMoviePreference('Book 2 tickets for Ramayana: Rise of a Legend'), {
    type: 'title', title: 'Ramayana: Rise of a Legend', label: 'Ramayana: Rise of a Legend', count: 5
  });
  assert.equal(isCinemaTimeWorkflowRequest('Book 2 tickets for Ramayana: Rise of a Legend'), true);
  assert.deepEqual(buildCinemaMoviePreference('Book 2 tickets for Ramayana: Rise of a Legend'), {
    type: 'title', title: 'Ramayana: Rise of a Legend', label: 'Ramayana: Rise of a Legend', count: 5
  });
});
