import { getShowSeats } from '../cinema/cinemaService.js';

export const cinemaSeatsTool = {
  name: 'get_show_seats',
  description: 'Get the seat map for the exact show the user selected. Prefer showId from the screening result. If that ID is unavailable in the current turn, resolve it using the exact movieTitle, city, theatre, mall, auditorium, date and time previously presented to the user. Never call with an invented ID or only a movie title.',
  parameters: {
    type: 'object',
    properties: {
      showId: { type: 'string', description: 'Exact show ID from the screening result, when available.' },
      movieTitle: { type: 'string', description: 'Exact movie title previously recommended.' },
      city: { type: 'string' },
      theatre: { type: 'string', description: 'Exact theatre name previously presented.' },
      mall: { type: 'string' },
      auditorium: { type: 'string' },
      date: { type: 'string', description: 'Exact show date YYYY-MM-DD.' },
      time: { type: 'string', description: 'Exact show time HH:MM.' }
    },
    required: []
  },
  execute: getShowSeats
};
