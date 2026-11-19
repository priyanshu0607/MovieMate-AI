import { findNearbyCinemas } from '../cinema/locationService.js';
export const nearbyCinemasTool = {
  name: 'find_nearby_cinemas',
  description: 'Find and rank supported MovieMate demo cinemas near the coordinates shared by the user. Use when user asks for nearby/closest cinemas and location coordinates are available in request context. Never guess a city or coordinates.',
  parameters: { type: 'object', properties: { radiusKm: { type: 'number', description: 'Search radius in kilometres, default 30.' } } },
  execute: findNearbyCinemas
};
