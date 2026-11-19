import { bookSeats, listMyBookings, cancelDemoBooking } from '../cinema/cinemaService.js';

export const myBookingsTool = {
  name: 'list_my_bookings',
  description: 'List the current demo user’s confirmed MovieMate cinema bookings, including city, mall, theatre, auditorium, showtime, seat category and seat numbers. Use when the user asks what they booked or which seats they have.',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async () => listMyBookings('default-user')
};

export const bookSeatsTool = {
  name: 'book_demo_seats',
  description: 'Create a simulated local booking for seats in a demo show. Only use after the user explicitly asks to book. First call get_show_seats. Requires showId and exact seat numbers. The tool rejects already occupied seats and persists successful bookings to server/data/cinema.json. This is a fake booking only: no real ticket or payment is created.',
  parameters: {
    type: 'object',
    properties: {
      showId: { type: 'string', description: 'Show ID returned by search_cinema_shows.' },
      seats: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'Exact seat labels to book, e.g. ["P5", "P6"].' }
    },
    required: ['showId', 'seats']
  },
  execute: async ({ showId, seats }) => bookSeats({ showId, seats, userId: 'default-user' })
};


export const cancelBookingTool = {
  name: 'cancel_demo_booking',
  description: 'Cancel one of the current demo user’s confirmed bookings by exact booking ID. Only use after the user selects the booking and explicitly confirms cancellation. Marks it CANCELLED and releases its seats; no real refund is issued.',
  parameters: { type: 'object', properties: { bookingId: { type: 'string' } }, required: ['bookingId'] },
  execute: async ({ bookingId }) => cancelDemoBooking({ bookingId, userId: 'default-user' })
};
