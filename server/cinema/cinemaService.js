import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { recordActivity } from '../database/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.resolve(here, '../data/cinema.json');
let queue = Promise.resolve();

async function readData() {
  const raw = await readFile(dataFile, 'utf8');
  return JSON.parse(raw);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function updateData(mutator) {
  const task = queue.then(async () => {
    const data = await readData();
    const result = await mutator(data);
    await mkdir(path.dirname(dataFile), { recursive: true });
    const temp = `${dataFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    let lastError;
    for (let attempt = 0; attempt < 7; attempt++) {
      try { await rename(temp, dataFile); return result; }
      catch (error) {
        lastError = error;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 6) break;
        await sleep(40 * (attempt + 1));
      }
    }
    try { await unlink(temp); } catch {}
    throw new Error(`Could not replace cinema data file after retries: ${lastError?.code || ''} ${lastError?.message || ''}`);
  });
  queue = task.catch(() => {});
  return task;
}
async function readConsistent(fn) {
  await queue;
  return fn(await readData());
}

export async function getSupportedCities() {
  return readConsistent(data => data.cities);
}

export async function resolveLocalMovieTitle(title) {
  const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const wanted = normalize(title);
  if (!wanted) return null;
  return readConsistent(data => {
    const titles = [...new Set([
      ...(data.movies || []).map(movie => movie.title),
      ...(data.shows || []).map(show => show.movie_title)
    ].filter(Boolean))];
    return titles.find(candidate => normalize(candidate) === wanted) || null;
  });
}

export async function searchCinemaShows({ city, movieTitle, locality, date } = {}) {
  return readConsistent(data => {
    const cityRow = data.cities.find(c => c.name.toLowerCase() === String(city || '').trim().toLowerCase());
    if (!cityRow) return { supported: false, message: 'This location does not exist in my memory yet.', supportedCities: data.cities.map(c => c.name), shows: [] };
    const theatres = data.theatres.filter(t => t.city === cityRow.name && (!locality || t.locality.toLowerCase().includes(String(locality).toLowerCase()) || t.mall.toLowerCase().includes(String(locality).toLowerCase())));
    const theatreMap = new Map(theatres.map(t => [t.id, t]));
    const wantedMovie = String(movieTitle || '').trim().toLowerCase();
    const shows = data.shows.filter(s => theatreMap.has(s.theatre_id) && (!wantedMovie || s.movie_title.toLowerCase().includes(wantedMovie)) && (!date || s.date === date)).map(s => {
      const theatre = theatreMap.get(s.theatre_id);
      return { showId: s.id, movieTitle: s.movie_title, city: theatre.city, mall: theatre.mall, theatre: theatre.name, locality: theatre.locality, distanceKm: theatre.distance_km, auditorium: s.auditorium, date: s.date, time: s.time, language: s.language, format: s.format, seatCategories: Object.entries(s.seat_categories).map(([key, c]) => ({ key, label: c.label, price: c.price })) };
    });
    return { supported: true, city: cityRow.name, shows };
  });
}

export async function getShowSeats(input = {}) {
  // Accept common model-generated key variants and, when the opaque ID was
  // lost between chat turns, resolve the show from the details shown to the user.
  const showId = input.showId || input.show_id || input.id;
  const movieTitle = input.movieTitle || input.movie_title;
  const city = input.city;
  const theatreName = input.theatre || input.theatreName || input.theatre_name;
  const mall = input.mall;
  const auditorium = input.auditorium;
  const date = input.date;
  const time = input.time;
  return readConsistent(data => {
    let show = showId ? data.shows.find(s => s.id === String(showId)) : null;
    if (!show && (movieTitle || theatreName || mall || auditorium || (date && time))) {
      const matching = data.shows.filter(s => {
        const t = data.theatres.find(row => row.id === s.theatre_id);
        if (!t) return false;
        const eq = (a, b) => !b || String(a || '').trim().toLowerCase() === String(b).trim().toLowerCase();
        return eq(s.movie_title, movieTitle) && eq(t.city, city) &&
          eq(t.name, theatreName) && eq(t.mall, mall) &&
          eq(s.auditorium, auditorium) && eq(s.date, date) && eq(s.time, time);
      });
      if (matching.length >= 1) show = matching.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
      /* Exact duplicate schedule rows are resolved deterministically by ID. */
      else if (matching.length > 1) {
        return {
          found: false, ambiguous: true,
          message: 'More than one show matches. Supply the exact date and time, or the showId.',
          matches: matching.slice(0, 12).map(s => {
            const t = data.theatres.find(row => row.id === s.theatre_id);
            return { showId: s.id, movieTitle: s.movie_title, city: t.city, theatre: t.name, mall: t.mall, auditorium: s.auditorium, date: s.date, time: s.time };
          })
        };
      }
    }
    if (!show) {
      throw new Error(`Show not found. Provide the exact showId, or movieTitle + theatre/mall + date + time. Received showId: ${showId || '(missing)'}.`);
    }
    const theatre = data.theatres.find(t => t.id === show.theatre_id);
    const occupied = new Set(data.bookings.filter(b => b.show_id === show.id && b.status === 'CONFIRMED').flatMap(b => b.seats));
    const categories = Object.entries(show.seat_categories).map(([key, category]) => ({
      key, label: category.label, price: category.price,
      seats: category.seats.map(seat => ({ seat, status: occupied.has(seat) ? 'OCCUPIED' : 'AVAILABLE' }))
    }));
    return { showId: show.id, movieTitle: show.movie_title, city: theatre.city, mall: theatre.mall, theatre: theatre.name, auditorium: show.auditorium, date: show.date, time: show.time, format: show.format, categories };
  });
}

export async function listMyBookings(userId = 'default-user') {
  return readConsistent(data => data.bookings.filter(b => b.user_id === userId).sort((a,b) => b.created_at.localeCompare(a.created_at)));
}

export async function bookSeats({ showId, seats, userId = 'default-user' }) {
  if (!Array.isArray(seats) || seats.length < 1 || seats.length > 10) throw new Error('Choose between 1 and 10 seats.');
  const normalizedSeats = [...new Set(seats.map(s => String(s).trim().toUpperCase()))];
  if (normalizedSeats.length !== seats.length) throw new Error('Duplicate seat numbers were supplied.');
  const booking = await updateData(data => {
    const show = data.shows.find(s => s.id === showId);
    if (!show) throw new Error(`Show not found: ${showId}`);
    const theatre = data.theatres.find(t => t.id === show.theatre_id);
    const allSeats = Object.entries(show.seat_categories).flatMap(([key, c]) => c.seats.map(seat => ({ seat, key, category: c })));
    const invalid = normalizedSeats.filter(seat => !allSeats.some(s => s.seat === seat));
    if (invalid.length) throw new Error(`Invalid seat number(s): ${invalid.join(', ')}.`);
    const occupied = new Set(data.bookings.filter(b => b.show_id === show.id && b.status === 'CONFIRMED').flatMap(b => b.seats));
    const unavailable = normalizedSeats.filter(seat => occupied.has(seat));
    if (unavailable.length) throw new Error(`Seat(s) ${unavailable.join(', ')} are already occupied. Please choose different seats.`);
    const categories = normalizedSeats.map(seat => allSeats.find(s => s.seat === seat));
    const categoryKeys = [...new Set(categories.map(s => s.key))];
    if (categoryKeys.length !== 1) throw new Error('For this demo, select seats from the same seating category.');
    const category = categories[0].category;
    const amount = normalizedSeats.reduce((sum, seat) => sum + allSeats.find(s => s.seat === seat).category.price, 0);
    const row = {
      id: `MM-${randomUUID().slice(0,8).toUpperCase()}`, user_id: userId, show_id: showId,
      movie_title: show.movie_title, city: theatre.city, mall: theatre.mall, theatre: theatre.name,
      auditorium: show.auditorium, date: show.date, time: show.time, format: show.format,
      seats: normalizedSeats, seat_category: category.label, amount, status: 'CONFIRMED',
      payment_mode: 'SIMULATED', created_at: new Date().toISOString()
    };
    data.bookings.push(row);
    return row;
  });
  await recordActivity('booking', 'Demo cinema booking confirmed', 'success', { bookingId: booking.id, movie: booking.movie_title, seats: booking.seats, theatre: booking.theatre });
  return { ...booking, simulated: true, message: 'Demo booking confirmed. No real tickets or payment were issued.' };
}


/** Cancel one confirmed demo booking. Its seats become available again because
 * occupancy is derived only from bookings whose status is CONFIRMED. */
export async function cancelDemoBooking({ bookingId, userId = 'default-user' } = {}) {
  const id = String(bookingId || '').trim().toUpperCase();
  if (!id) throw new Error('A booking ID is required to cancel a booking.');
  const result = await updateData(data => {
    const booking = data.bookings.find(row => row.id.toUpperCase() === id && row.user_id === userId);
    if (!booking) throw new Error(`Booking ${id} was not found for this user.`);
    if (booking.status === 'CANCELLED') return { booking, alreadyCancelled: true };
    if (booking.status !== 'CONFIRMED') throw new Error(`Booking ${id} cannot be cancelled because its status is ${booking.status}.`);
    booking.status = 'CANCELLED';
    booking.cancelled_at = new Date().toISOString();
    return { booking, alreadyCancelled: false };
  });
  if (!result.alreadyCancelled) {
    await recordActivity('booking', 'Demo cinema booking cancelled', 'success', { bookingId: result.booking.id, movie: result.booking.movie_title, seats: result.booking.seats, theatre: result.booking.theatre });
  }
  return { ...result.booking, alreadyCancelled: result.alreadyCancelled, simulated: true };
}
