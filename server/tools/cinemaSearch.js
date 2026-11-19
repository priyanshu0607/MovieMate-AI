import { searchCinemaShows } from '../cinema/cinemaService.js';

export const cinemaSearchTool = {
  name: 'search_cinema_shows',
  description: 'Search the local demo cinema catalogue for screenings in a supported city. Use this after identifying a movie and obtaining the user city. Only returns seeded demo data; it is not live theatre availability.',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'Supported city, e.g. Bengaluru, Mumbai, Delhi NCR, Hyderabad, Chennai or Pune.' },
      movieTitle: { type: 'string', description: 'Optional movie title to filter screenings.' },
      locality: { type: 'string', description: 'Optional locality or mall, e.g. Rajajinagar or M5 Mall.' },
      date: { type: 'string', description: 'Optional show date in YYYY-MM-DD format.' }
    },
    required: ['city']
  },
  execute: searchCinemaShows
};
