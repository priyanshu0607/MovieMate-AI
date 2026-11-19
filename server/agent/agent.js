import { randomUUID } from 'node:crypto';
import { planNextAction } from './planner.js';
import { executeTool, toolsForIntent } from './toolRegistry.js';
import { isLikelyPendingCinemaReply, detectRequestIntents, buildMovieRecommendationSearch, buildCinemaMoviePreference, extractTicketPriceFilter, isExplicitBookingConfirmation, assistantRequestedBookingConfirmation, shouldClearPendingCinemaState, shouldPauseBookingForInterruption } from './workflowPolicy.js';
import { parseTicketCount, resolveShowSelection, getSeatOptions, parseSeatLabels } from './bookingFlow.js';
import { classifyRules } from './intentCorpus.js';
import { compactToolResult, makeGroqEvidence, shouldUseGroq } from './contextBuilder.js';
import { generateGroqFinal, isGroqConfigured } from '../services/groq.js';
import {
  saveConversation, getRecentConversation, ensureConversation, getConversationState, setConversationState, clearConversationState,
  startExecution, finishExecution, saveToolLog
} from '../database/db.js';
import { findRecommendableShows } from '../cinema/recommendationService.js';
import { normalizeMovieTitle } from '../cinema/movieMatching.js';
import { searchMovies } from '../services/tmdb.js';
import { listMyBookings, cancelDemoBooking, resolveLocalMovieTitle } from '../cinema/cinemaService.js';
import { extractRequestedTime, extractSupportedCity, indiaLocalDate, isCinemaTimeWorkflowRequest, reverseGeocodeSupportedCity } from '../cinema/locationResolver.js';

const MAX_STEPS = Number(process.env.MAX_AGENT_STEPS || 5);
const MAX_LOCAL_TOOL_CHARS = Number(process.env.MAX_LOCAL_TOOL_CHARS || 40000);


function isSingleActionRequest(message) {
  return !/\b(and|also|then|plus|after that|as well as)\b/i.test(String(message || ''));
}

function isDirectBookingRequest(message) {
  return /\b(?:book|reserve|buy|get)\b.{0,55}\b(?:tickets?|seats?)\b/i.test(String(message || ''));
}

function recoverBookingMoviePreference(history = []) {
  // Prefer an earlier explicit booking instruction over unrelated discovery
  // messages. This protects the movie constraint when the user replies only
  // with a time or location.
  for (const prior of [...history].reverse()) {
    if (prior.role !== 'user' || !isDirectBookingRequest(prior.content)) continue;
    const preference = buildCinemaMoviePreference(prior.content);
    if (preference?.type === 'title') return preference;
  }
  return null;
}

function terminalToolAnswer(toolName, result) {
  if (toolName === 'add_to_watchlist') {
    return `Saved ${result?.title || 'the movie'} to your watchlist.`;
  }
  if (toolName === 'remove_from_watchlist') {
    return result?.removed ? 'Removed the movie from your watchlist.' : 'That movie was not found in your watchlist.';
  }
  if (toolName === 'book_demo_seats' && result?.status === 'CONFIRMED') {
    return `Your DEMO booking is confirmed for ${result.movie_title}: ${result.theatre}, ${result.mall}, ${result.date} at ${result.time}. Seats: ${(result.seats || []).join(', ')}. No real ticket or payment was issued.`;
  }
  return null;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function safeSerialize(value, maxChars) {
  try { return JSON.stringify(value).slice(0, maxChars); }
  catch { return JSON.stringify({ error: 'Tool result could not be serialized.' }); }
}

function displayTime(value) {
  const [hourText, minuteText] = String(value || '').split(':');
  const hour = Number(hourText);
  if (!Number.isFinite(hour)) return value || 'Time unavailable';
  return `${hour % 12 || 12}:${String(minuteText || '00').padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function isActiveBookingStage(stage) {
  return ['picking_show', 'awaiting_ticket_count', 'awaiting_seat_choice', 'awaiting_confirm'].includes(stage);
}

function formatSeatOptions(options, count) {
  return options.map(option => `- **${option.category}** — ₹${option.price} each; available: ${option.seats.slice(0, 12).join(', ')}${option.seats.length > 12 ? ', …' : ''}; suggested: ${option.recommended.join(', ')}`).join('\n');
}

async function loadSeatOptions(showId, count, location) {
  const result = await executeTool('get_show_seats', { showId }, { location, intent: 'cinema' });
  const categories = (result.categories || []).map(category => ({
    category: category.label,
    price: category.price,
    availableSeats: (category.seats || []).filter(seat => seat.status === 'AVAILABLE').map(seat => seat.seat)
  }));
  const lookup = { showId: result.showId, categories };
  return { lookup, options: getSeatOptions(lookup, count) };
}

function isResumeBookingRequest(text) {
  return /\b(resume|return to|go back to|continue with|back to)\b.{0,35}\b(booking|tickets?|reservation)\b|\bresume\b/i.test(String(text || ''));
}

function bookingSummaryText(state) {
  const show = state.selectedShow;
  return `**Booking summary**\n\n- **Movie:** ${show.movieTitle}\n- **Cinema:** ${show.theatre}, ${show.mall}\n- **Screen:** ${show.auditorium || 'Not specified'}\n- **Date:** ${show.date}\n- **Showtime:** ${displayTime(show.time)}\n- **Tickets:** ${state.ticketCount}\n- **Seats:** ${state.selectedSeats.join(', ')}\n- **Category:** ${state.selectedCategory}\n- **Total:** ₹${state.totalAmount}\n\nPlease confirm this exact booking. Reply **Confirm booking** to proceed. This is a simulated booking; no real payment or ticket will be issued.`;
}

async function maybeUseGroq({ userMessage, draft, toolResults, onEvent }) {
  if (!isGroqConfigured() || !shouldUseGroq(userMessage, toolResults)) return draft;
  const evidence = makeGroqEvidence(toolResults);
  if (!evidence.length) return draft;

  onEvent({ type: 'status', message: 'Refining the recommendation…', model: 'groq' });
  try {
    // Exactly one Groq request per user turn; no tool loop and no chat history.
    const answer = await generateGroqFinal({ userMessage, draft, evidence });
    onEvent({ type: 'model_usage', model: 'groq', calls: 1, mode: 'single_final_reasoning_call' });
    return answer;
  } catch (error) {
    console.warn('[groq] Final reasoning unavailable; keeping Ollama answer:', {
      message: error.message,
      status: error.response?.status,
      details: error.response?.data?.error?.message || error.response?.data?.message || null
    });
    onEvent({ type: 'status', message: 'Using the local model response (Groq unavailable).', model: 'ollama' });
    return draft;
  }
}

export async function runAgent(userMessage, onEvent = () => {}, requestedConversationId, location = null) {
  const conversationId = requestedConversationId || randomUUID();
  await ensureConversation(conversationId, userMessage.slice(0, 80));
  const execution = await startExecution(conversationId, userMessage);
  const history = await getRecentConversation(conversationId, 6);
  const locationContext = location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lon)) ? `Device location shared with permission: latitude ${Number(location.lat)}, longitude ${Number(location.lon)}. Do not infer a different city.` : '';
  const messages = [...history, ...(locationContext ? [{ role: 'system', content: locationContext }] : []), { role: 'user', content: userMessage }];
  await saveConversation(conversationId, 'user', userMessage);
  onEvent({ type: 'status', message: 'Understanding your request…', conversationId, executionId: execution.id });

  let completedSteps = 0;
  const toolResults = [];
  const executedToolCalls = new Map();
  try {
    // Persisted cinema booking state takes precedence over fresh intent routing.
    // This prevents short follow-ups (movie title, ticket count, seat labels) from
    // falling back into the generic Qwen planner.
    let bookingState = await getConversationState(conversationId);
    let stateStage = bookingState?.stage;
    const text = String(userMessage || '').trim();
    const stageIntent = stateStage ? classifyRules(text, {
      stage: stateStage === 'picking_show' ? 'picking_show' : stateStage === 'choosing_genre_movie' ? 'choosing_genre_movie' : stateStage === 'awaiting_genre_showtime' ? 'awaiting_genre_showtime' : stateStage === 'cancelling_booking' ? 'cancelling_booking' : stateStage === 'awaiting_ticket_count' ? 'awaiting_ticket_count' : stateStage === 'awaiting_seat_choice' ? 'awaiting_seat_choice' : stateStage === 'awaiting_confirm' ? 'awaiting_confirm' : stateStage,
      pendingShows: bookingState?.candidates || []
    }) : null;
    const freshIntents = detectRequestIntents(text);
    let pausedBookingState = bookingState?.pausedBooking || null;
    let resumedBooking = false;
    if (pausedBookingState && isResumeBookingRequest(text)) {
      bookingState = pausedBookingState;
      stateStage = bookingState.stage;
      await setConversationState(conversationId, bookingState);
      pausedBookingState = null;
      resumedBooking = true;
    } else if (shouldPauseBookingForInterruption(stateStage, freshIntents, stageIntent)) {
      // Suspend, do not destroy, an unfinished booking when the user changes topic.
      pausedBookingState = bookingState;
      await setConversationState(conversationId, { stage: 'paused_booking', pausedBooking: pausedBookingState });
      bookingState = null;
      stateStage = null;
    } else if (stateStage === 'paused_booking' && !isResumeBookingRequest(text)) {
      pausedBookingState = bookingState?.pausedBooking || null;
      bookingState = null;
      stateStage = null;
    } else if (shouldClearPendingCinemaState(stateStage, freshIntents, stageIntent)) {
      await clearConversationState(conversationId);
      bookingState = null;
      stateStage = null;
    }
    const finishDirect = async answer => {
      await saveConversation(conversationId, 'assistant', answer);
      await finishExecution(execution.id, 'completed', 0);
      onEvent({ type: 'complete', answer, steps: 0, conversationId, executionId: execution.id });
      return { answer, steps: 0, conversationId, executionId: execution.id };
    };

    if (resumedBooking && bookingState) {
      const show = bookingState.selectedShow;
      const answer = show
        ? `Welcome back. Your pending booking is restored:\n\n- **Movie:** ${show.movieTitle}\n- **Cinema:** ${show.theatre}, ${show.mall}\n- **Showtime:** ${displayTime(show.time)} on ${show.date}\n- **Tickets:** ${bookingState.ticketCount || 'Not selected yet'}\n- **Seats:** ${(bookingState.selectedSeats || []).join(', ') || 'Not selected yet'}\n\n${bookingState.stage === 'awaiting_confirm' ? 'Reply **Confirm booking** to continue, or tell me what you would like to change.' : bookingState.stage === 'awaiting_seat_choice' ? `Choose ${(bookingState.ticketCount || 1)} seats, or tell me a different ticket quantity.` : 'Tell me how many tickets you would like.'}`
        : 'Your previous booking flow has been restored. Please choose the screening to continue.';
      return await finishDirect(answer);
    }

    // Confirmed-booking cancellation: select a booking, then explicitly confirm.
    if (/\b(cancel|cancell?ation)\b.{0,30}\b(my )?(tickets?|bookings?|reservation)\b|\bcancel my tickets?\b/i.test(text) && stateStage !== 'cancelling_booking') {
      const bookings = (await listMyBookings('default-user')).filter(row => row.status === 'CONFIRMED');
      if (!bookings.length) return await finishDirect('You have no confirmed demo bookings to cancel.');
      bookingState = { stage: 'cancelling_booking', cancellableBookings: bookings.map(row => ({ bookingId: row.id, movieTitle: row.movie_title, theatre: row.theatre, mall: row.mall, date: row.date, time: row.time, seats: row.seats, amount: row.amount })) };
      await setConversationState(conversationId, bookingState);
      const rows = bookingState.cancellableBookings.map((b, i) => `${i + 1}. **${b.movieTitle}** — ${b.theatre}, ${b.mall}, ${displayTime(b.time)} (${b.date}); seats ${b.seats.join(', ')}; ID ${b.bookingId}`).join('\n');
      return await finishDirect(`Here are your confirmed demo bookings:\n\n${rows}\n\nWhich booking would you like to cancel? Reply with its number or booking ID.`);
    }
    if (stateStage === 'cancelling_booking') {
      const list = bookingState.cancellableBookings || [];
      if (/^(no|keep|stop|don't cancel|do not cancel)$/i.test(text)) {
        await clearConversationState(conversationId);
        return await finishDirect('Okay, I will keep your booking. Nothing has been cancelled.');
      }
      if (bookingState.selectedCancellation) {
        if (!/^(yes|confirm|confirm cancellation|cancel it|proceed|go ahead)$/i.test(text)) return await finishDirect(`Please reply **Confirm cancellation** to cancel booking ${bookingState.selectedCancellation.bookingId}, or **Keep booking** to leave it unchanged.`);
        try {
          const cancelled = await cancelDemoBooking({ bookingId: bookingState.selectedCancellation.bookingId, userId: 'default-user' });
          await clearConversationState(conversationId);
          return await finishDirect(cancelled.alreadyCancelled ? `Booking ${cancelled.id} was already cancelled.` : `Your demo booking has been cancelled.\n\n- **Booking ID:** ${cancelled.id}\n- **Movie:** ${cancelled.movie_title}\n- **Showtime:** ${displayTime(cancelled.time)} on ${cancelled.date}\n- **Seats released:** ${cancelled.seats.join(', ')}\n- **Status:** CANCELLED\n\nThis is a simulated cancellation; no real ticket or refund was involved.`);
        } catch (error) { return await finishDirect(`I couldn't cancel that booking: ${error.message}`); }
      }
      const idMatch = text.match(/MM-[A-Z0-9]{4,}/i);
      const ordinal = text.toLowerCase().match(/\b(\d{1,2})\b|\b(first|second|third|fourth|fifth|sixth)\b/);
      const words = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
      const index = ordinal ? Number(ordinal[1] || words[ordinal[2]]) - 1 : -1;
      const selected = idMatch ? list.find(b => b.bookingId.toUpperCase() === idMatch[0].toUpperCase()) : (index >= 0 ? list[index] : null);
      if (!selected) return await finishDirect('I could not match that to a listed booking. Reply with its number or exact booking ID.');
      bookingState = { ...bookingState, selectedCancellation: selected };
      await setConversationState(conversationId, bookingState);
      return await finishDirect(`Please confirm cancellation of **${selected.movieTitle}** at **${selected.theatre}, ${selected.mall}**, ${displayTime(selected.time)} on ${selected.date}.\n\n- **Booking ID:** ${selected.bookingId}\n- **Seats:** ${selected.seats.join(', ')}\n- **Amount:** ₹${selected.amount}\n\nReply **Confirm cancellation** to release these seats, or **Keep booking** to stop. No real refund will be issued.`);
    }

    // Select one of the genre recommendations, or skip directly to all movies in that genre.
    if (stateStage === 'choosing_genre_movie') {
      const options = bookingState.recommendedMovies || [];
      const ordinal = text.toLowerCase().match(/\b(\d{1,2})\b|\b(first|second|third|fourth|fifth|sixth)\b/);
      const wordNums = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
      const index = ordinal ? Number(ordinal[1] || wordNums[ordinal[2]]) - 1 : -1;
      const normalizedText = normalizeMovieTitle(text);
      const named = options.find(movie => normalizeMovieTitle(movie.title) === normalizedText || (normalizedText.length > 2 && normalizeMovieTitle(movie.title).includes(normalizedText)));
      const selectedMovie = named || (index >= 0 ? options[index] : null);
      if (selectedMovie) {
        await setConversationState(conversationId, { ...(bookingState.pausedBooking ? { pausedBooking: bookingState.pausedBooking } : {}), stage: 'awaiting_genre_showtime', genrePreference: bookingState.genrePreference, selectedMovie: selectedMovie.title });
        return await finishDirect(`Great choice — **${selectedMovie.title}**. What time would you like to watch it? I'll look for showtimes of this movie only.`);
      }
      if (/\b(showtimes?|skip|any movie|all movies|doesn't matter|doesnt matter)\b/i.test(text) || extractRequestedTime(text)) {
        await setConversationState(conversationId, { ...(bookingState.pausedBooking ? { pausedBooking: bookingState.pausedBooking } : {}), stage: 'awaiting_genre_showtime', genrePreference: bookingState.genrePreference, selectedMovie: null });
        bookingState = { stage: 'awaiting_genre_showtime', genrePreference: bookingState.genrePreference, selectedMovie: null };
        stateStage = 'awaiting_genre_showtime';
        if (!extractRequestedTime(text)) return await finishDirect(`No problem. I'll search all **${bookingState.genrePreference.label}** movies instead. What time would you like to watch?`);
        // A time without a title choice means search all titles in the genre.
      } else {
        return await finishDirect('Choose a movie by its number or title, or reply **showtimes** to search all movies in this genre.');
      }
    }


    if (stateStage === 'picking_show') {
      if (stageIntent?.intent !== 'select_show') return await finishDirect('Please choose a movie and showtime from the screenings I listed. You can type the movie title, an option number, or the exact time.');
      const selection = resolveShowSelection(text, bookingState.candidates || []);
      if (selection.status === 'selected') {
        const seatLookup = (bookingState.seatLookups || []).find(item => item.showId === selection.show.showId);
        if (bookingState.ticketCount) {
          try {
            const fresh = await loadSeatOptions(selection.show.showId, bookingState.ticketCount, location);
            if (!fresh.options.length) return await finishDirect(`You selected **${selection.show.movieTitle}**, but that screening does not have ${bookingState.ticketCount} available seats together in one category. Choose another screening or change the ticket quantity.`);
            bookingState = { ...bookingState, stage: 'awaiting_seat_choice', selectedShow: selection.show, selectedSeatLookup: fresh.lookup, seatOptions: fresh.options };
            await setConversationState(conversationId, bookingState);
            return await finishDirect(`You selected **${selection.show.movieTitle}** at **${selection.show.theatre}, ${selection.show.mall}**, ${displayTime(selection.show.time)} on ${selection.show.date}. For ${bookingState.ticketCount} ticket(s), choose seats:\n\n${formatSeatOptions(fresh.options, bookingState.ticketCount)}\n\nEnter your seat numbers or say **use the suggested seats**.`);
          } catch (error) { return await finishDirect(`I couldn't retrieve seats for that screening: ${error.message}`); }
        }
        bookingState = { ...bookingState, stage: 'awaiting_ticket_count', selectedShow: selection.show, selectedSeatLookup: seatLookup || null };
        await setConversationState(conversationId, bookingState);
        return await finishDirect(`You selected **${selection.show.movieTitle}** at **${selection.show.theatre}, ${selection.show.mall}**, ${displayTime(selection.show.time)} on ${selection.show.date}.\n\n**How many tickets would you like?**`);
      }
      if (selection.status === 'ambiguous') {
        const options = selection.shows.map(show => `- ${show.movieTitle} — ${show.theatre}, ${show.mall}, ${displayTime(show.time)} (${show.date})`).join('\n');
        return await finishDirect(`I found more than one matching screening. Which exact show would you like?\n\n${options}`);
      }
      return await finishDirect(`Please choose one of the screenings I listed by movie title and, if needed, its showtime. I won't select or book one automatically.`);
    }

    if (stateStage === 'awaiting_ticket_count') {
      if (stageIntent?.intent === 'modify_showtime') {
        const requestedTime = extractRequestedTime(text);
        const alternatives = (bookingState.candidates || []).filter(show => normalizeMovieTitle(show.movieTitle) === normalizeMovieTitle(bookingState.selectedShow.movieTitle));
        const nextShow = alternatives.find(show => show.time === requestedTime);
        if (!nextShow) return await finishDirect(`I couldn't find that exact time for ${bookingState.selectedShow.movieTitle}. Available alternatives: ${alternatives.map(show => displayTime(show.time)).join(', ') || 'Please run a new showtime search.'}`);
        try {
          const { lookup } = await loadSeatOptions(nextShow.showId, 1, location);
          bookingState = { ...bookingState, selectedShow: nextShow, selectedSeatLookup: lookup };
          await setConversationState(conversationId, bookingState);
          return await finishDirect(`Changed the screening to ${displayTime(nextShow.time)} at ${nextShow.theatre}, ${nextShow.mall}. How many tickets would you like?`);
        } catch (error) { return await finishDirect(`I couldn't check that screening: ${error.message}`); }
      }
      if (!['select_seats', 'modify_ticket_count'].includes(stageIntent?.intent)) return await finishDirect('How many tickets would you like? Please enter a number from 1 to 10.');
      const count = parseTicketCount(text);
      if (!count) return await finishDirect('How many tickets would you like? Please enter a number from 1 to 10.');
      let seatLookup = bookingState.selectedSeatLookup;
      if (!seatLookup || seatLookup.error) {
        try {
          const result = await executeTool('get_show_seats', { showId: bookingState.selectedShow.showId }, { location, intent: 'cinema' });
          const categories = (result.categories || []).map(category => ({ category: category.label, price: category.price, availableSeats: (category.seats || []).filter(seat => seat.status === 'AVAILABLE').map(seat => seat.seat) }));
          seatLookup = { showId: result.showId, categories };
        } catch (error) {
          return await finishDirect(`I couldn't retrieve the seat map for that show: ${error.message}. Please choose another screening.`);
        }
      }
      const options = getSeatOptions(seatLookup, count);
      if (!options.length) return await finishDirect(`That screening doesn't currently have ${count} available seats together in one category. Please choose a different show or ticket count.`);
      bookingState = { ...bookingState, stage: 'awaiting_seat_choice', ticketCount: count, seatOptions: options };
      await setConversationState(conversationId, bookingState);
      const optionText = options.map(option => `- **${option.category}** — ₹${option.price} each; available: ${option.seats.slice(0, 12).join(', ')}${option.seats.length > 12 ? ', …' : ''}; suggested: ${option.recommended.join(', ')}`).join('\n');
      return await finishDirect(`For **${bookingState.selectedShow.movieTitle}** at ${displayTime(bookingState.selectedShow.time)}, here are the available seat options for ${count} ticket(s):\n\n${optionText}\n\nPlease enter the exact seat numbers you want, or say **use the suggested seats**.`);
    }

    if (stateStage === 'awaiting_seat_choice') {
      if (stageIntent?.intent === 'modify_showtime') {
        const requestedTime = extractRequestedTime(text);
        const alternatives = (bookingState.candidates || []).filter(show => normalizeMovieTitle(show.movieTitle) === normalizeMovieTitle(bookingState.selectedShow.movieTitle));
        const nextShow = alternatives.find(show => show.time === requestedTime);
        if (!nextShow) return await finishDirect(`I couldn't find that exact time for ${bookingState.selectedShow.movieTitle}. Available alternatives: ${alternatives.map(show => displayTime(show.time)).join(', ') || 'Please run a new showtime search.'}`);
        try {
          const { lookup, options } = await loadSeatOptions(nextShow.showId, bookingState.ticketCount, location);
          if (!options.length) return await finishDirect('That screening does not have enough available seats. Choose another showtime.');
          bookingState = { ...bookingState, selectedShow: nextShow, selectedSeatLookup: lookup, seatOptions: options, selectedSeats: [], selectedCategory: null, totalAmount: null };
          await setConversationState(conversationId, bookingState);
          return await finishDirect(`Changed the screening to ${displayTime(nextShow.time)} at ${nextShow.theatre}, ${nextShow.mall}. Please choose ${bookingState.ticketCount} seats again:\n\n${formatSeatOptions(options, bookingState.ticketCount)}`);
        } catch (error) { return await finishDirect(`I couldn't check that screening: ${error.message}`); }
      }
      if (stageIntent?.intent === 'modify_ticket_count') {
        const newCount = parseTicketCount(text);
        if (!newCount) return await finishDirect('Please specify a new ticket quantity from 1 to 10.');
        try {
          const { lookup, options } = await loadSeatOptions(bookingState.selectedShow.showId, newCount, location);
          if (!options.length) return await finishDirect(`This screening does not have ${newCount} available seats together in one category. Choose another quantity or screening.`);
          bookingState = { ...bookingState, stage: 'awaiting_seat_choice', ticketCount: newCount, selectedSeatLookup: lookup, seatOptions: options, selectedSeats: [], selectedCategory: null, totalAmount: null };
          await setConversationState(conversationId, bookingState);
          return await finishDirect(`Updated your ticket quantity to **${newCount}**. Please choose ${newCount} seats:\n\n${formatSeatOptions(options, newCount)}\n\nYou can also change the quantity again before confirming.`);
        } catch (error) { return await finishDirect(`I couldn't refresh seat availability: ${error.message}`); }
      }
      if (stageIntent?.intent !== 'select_seats') return await finishDirect(`Please choose ${bookingState.ticketCount} available seat numbers, or say use the suggested seats.`);
      let seats = parseSeatLabels(text);
      let category = null;
      if (!seats.length && /\b(yes|use (the )?(suggested|recommended) seats|recommended|those|these)\b/i.test(text)) {
        const option = bookingState.seatOptions[0];
        seats = option?.recommended || [];
        category = option?.category || null;
      } else if (!seats.length) {
        const option = bookingState.seatOptions.find(item => new RegExp(item.category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text));
        if (option) { seats = option.recommended; category = option.category; }
      }
      if (seats.length !== bookingState.ticketCount) {
        return await finishDirect(`Please select exactly ${bookingState.ticketCount} seat numbers from the available seats I listed. For example: ${bookingState.seatOptions[0]?.recommended.join(', ') || 'P5, P6'}.`);
      }
      const chosen = bookingState.seatOptions.find(option => seats.every(seat => option.seats.includes(seat)));
      if (!chosen) return await finishDirect('One or more selected seats are unavailable or belong to different categories. Please choose available seats from a single category.');
      const nextState = { ...bookingState, stage: 'awaiting_confirm', selectedSeats: seats, selectedCategory: category || chosen.category, totalAmount: seats.length * chosen.price };
      await setConversationState(conversationId, nextState);
      return await finishDirect(bookingSummaryText(nextState));
    }

    if (stateStage === 'awaiting_confirm') {
      if (stageIntent?.intent === 'modify_ticket_count') {
        const newCount = parseTicketCount(text);
        if (!newCount) return await finishDirect('Please specify a new ticket quantity from 1 to 10.');
        try {
          const { lookup, options } = await loadSeatOptions(bookingState.selectedShow.showId, newCount, location);
          if (!options.length) return await finishDirect(`This screening does not have ${newCount} available seats together in one category. Choose another quantity or screening.`);
          bookingState = { ...bookingState, stage: 'awaiting_seat_choice', ticketCount: newCount, selectedSeatLookup: lookup, seatOptions: options, selectedSeats: [], selectedCategory: null, totalAmount: null };
          await setConversationState(conversationId, bookingState);
          return await finishDirect(`Updated your ticket quantity to **${newCount}**. Your previous seat selection has been cleared because the ticket count changed. Choose ${newCount} seats:\n\n${formatSeatOptions(options, newCount)}`);
        } catch (error) { return await finishDirect(`I couldn't refresh seat availability: ${error.message}`); }
      }
      const revisedSeats = parseSeatLabels(text);
      if (revisedSeats.length) {
        const chosen = (bookingState.seatOptions || []).find(option => revisedSeats.length === bookingState.ticketCount && revisedSeats.every(seat => option.seats.includes(seat)));
        if (!chosen) return await finishDirect(`Those seats are not a valid available set for ${bookingState.ticketCount} tickets. Choose ${bookingState.ticketCount} available seats from one category.`);
        const nextState = { ...bookingState, selectedSeats: revisedSeats, selectedCategory: chosen.category, totalAmount: revisedSeats.length * chosen.price };
        await setConversationState(conversationId, nextState);
        return await finishDirect(`Updated your seat selection.\n\n${bookingSummaryText(nextState)}`);
      }
      if (stageIntent?.intent === 'modify_showtime' || /\b(change|switch|move)\b.{0,25}\b(showtime|screening|time)\b/i.test(text)) {
        let selection = resolveShowSelection(text, bookingState.candidates || []);
        if (selection.status !== 'selected') {
          const requestedTime = extractRequestedTime(text);
          const sameMovieShows = (bookingState.candidates || []).filter(show => normalizeMovieTitle(show.movieTitle) === normalizeMovieTitle(bookingState.selectedShow.movieTitle));
          const timeMatch = requestedTime ? sameMovieShows.find(show => show.time === requestedTime) : null;
          if (timeMatch) selection = { status: 'selected', show: timeMatch };
        }
        if (selection.status !== 'selected') {
          const options = (bookingState.candidates || []).filter(show => normalizeMovieTitle(show.movieTitle) === normalizeMovieTitle(bookingState.selectedShow.movieTitle)).map(show => `- ${displayTime(show.time)} at ${show.theatre}, ${show.mall} (${show.date})`).join('\n');
          return await finishDirect(`I couldn't identify a different screening from that request. Available alternatives for ${bookingState.selectedShow.movieTitle}:\n${options || 'No other screening was retained. Please start a new showtime search.'}`);
        }
        try {
          const { lookup, options } = await loadSeatOptions(selection.show.showId, bookingState.ticketCount || 2, location);
          if (!options.length) return await finishDirect('That screening does not have enough available seats. Choose another showtime.');
          bookingState = { ...bookingState, stage: 'awaiting_seat_choice', selectedShow: selection.show, selectedSeatLookup: lookup, seatOptions: options, selectedSeats: [], selectedCategory: null, totalAmount: null };
          await setConversationState(conversationId, bookingState);
          return await finishDirect(`Changed your screening to **${selection.show.movieTitle}** at ${selection.show.theatre}, ${selection.show.mall}, ${displayTime(selection.show.time)}. Please choose ${bookingState.ticketCount} seats again:\n\n${formatSeatOptions(options, bookingState.ticketCount)}.`);
        } catch (error) { return await finishDirect(`I couldn't check that screening: ${error.message}`); }
      }
      if (/^(no|nope|cancel|stop|don't|do not)\b/i.test(text)) {
        await clearConversationState(conversationId);
        return await finishDirect('Okay, I have not booked anything. Your pending booking selection has been cancelled.');
      }
      if (isExplicitBookingConfirmation(text) && assistantRequestedBookingConfirmation(history)) {
        const bookingTools = new Set(toolsForIntent('cinema').map(item => item.function.name));
        const result = await executeTool('book_demo_seats', { showId: bookingState.selectedShow.showId, seats: bookingState.selectedSeats }, { location, allowedTools: bookingTools, intent: 'cinema' });
        await clearConversationState(conversationId);
        return await finishDirect(result?.status === 'CONFIRMED'
          ? `Your demo booking is confirmed!\n\n- **Movie:** ${result.movie_title}\n- **Cinema:** ${result.theatre}, ${result.mall}\n- **Date:** ${result.date}\n- **Time:** ${displayTime(result.time)}\n- **Seats:** ${(result.seats || []).join(', ')}\n- **Amount:** ₹${result.amount}\n- **Status:** CONFIRMED\n- **Payment:** SIMULATED\n\nNo real ticket or payment was issued.`
          : 'The booking was not confirmed by the booking service. No ticket was issued.');
      }
      return await finishDirect('Your booking summary is ready. Please reply **Confirm booking** to complete this simulated booking, or **Cancel** to stop.');
    }

    // Deterministic preflight: resolve GPS, local date and requested showtime before the model plans.
    const pendingCinemaFlow = isLikelyPendingCinemaReply(history, userMessage);
    const requestIntents = detectRequestIntents(userMessage);
    const workflowIntent = (isCinemaTimeWorkflowRequest(userMessage) || freshIntents.booking || pendingCinemaFlow || stateStage === 'awaiting_genre_showtime' || stateStage === 'awaiting_booking_details' || freshIntents.ticketPrice) ? 'cinema' : 'movie';
    const bookingAuthorized = isExplicitBookingConfirmation(userMessage) && assistantRequestedBookingConfirmation(history);
    const allowedTools = new Set(toolsForIntent(workflowIntent).map(item => item.function.name).filter(name => name !== 'book_demo_seats' || bookingAuthorized));

    // Deterministic TMDB preflight for plain-language movie recommendations.
    // This keeps basic discovery independent from Qwen's tool-call reliability,
    // without routing cinema/showtime requests through TMDB.
    const hasAdditionalMovieIntent = requestIntents.trailer || requestIntents.streaming || requestIntents.ticketPrice ||
      requestIntents.movieDetails || requestIntents.watchlistAdd || requestIntents.watchlistView;
    if (workflowIntent === 'movie' && requestIntents.movieRecommendation) {
      const { count, args } = buildMovieRecommendationSearch(userMessage);
      const startedAt = Date.now();
      onEvent({ type: 'tool_start', tool: 'search_movies', args, step: 0, deterministic: true });
      const movies = await executeTool('search_movies', args, { location, allowedTools, intent: workflowIntent });
      toolResults.push({ tool: 'search_movies', args, result: movies, status: 'success' });
      await saveToolLog({ executionId: execution.id, conversationId, toolName: 'search_movies', args, result: movies, status: 'success', durationMs: Date.now() - startedAt });
      onEvent({ type: 'tool_result', tool: 'search_movies', success: true, result: { resultCount: movies.length }, step: 0, deterministic: true });

      if (!hasAdditionalMovieIntent) {
        const selected = movies.slice(0, count);
        const answer = selected.length
          ? `Here are ${selected.length} ${args.genre ? 'matching' : ''} movie suggestions:\n\n${selected.map((movie, index) => `${index + 1}. **${movie.title}** (${movie.year || 'Year unavailable'})\n   - Rating: ${Number.isFinite(Number(movie.rating)) ? `${Number(movie.rating).toFixed(1)}/10` : 'Not available'}\n   - ${movie.overview || 'No synopsis available.'}`).join('\n\n')}\n\nWould you like details, trailers, streaming availability, or showtimes for any of these?`
          : 'I could not find matching movies in TMDB for those filters. Try a different genre or broader criteria.';
        const genreLabel = args.genre ? String(args.genre).split(',').map(id => ({ '14': 'Fantasy', '35': 'Comedy', '27': 'Horror', '28': 'Action', '53': 'Thriller', '12': 'Adventure', '878': 'Science Fiction' }[id] || 'selected genre')).join(' + ') : null;
        const recommendationAnswerBase = selected.length && args.genre
          ? `${answer.split('\n\nWould you like details, trailers, streaming availability, or showtimes for any of these?')[0]}\n\nReply with a movie number or title to see showtimes for that movie only, or say **showtimes** to search all ${genreLabel} movies.`
          : answer;
        const recommendationAnswer = pausedBookingState ? `${recommendationAnswerBase}\n\nYour previous booking is saved. Say **resume booking** when you want to continue.` : recommendationAnswerBase;
        if (selected.length && args.genre) {
          const genreLabels = { '14': 'Fantasy', '35': 'Comedy', '27': 'Horror', '28': 'Action', '53': 'Thriller', '12': 'Adventure', '878': 'Science Fiction' };
          await setConversationState(conversationId, { ...(pausedBookingState ? { pausedBooking: pausedBookingState } : {}), stage: 'choosing_genre_movie', genrePreference: { type: 'genre', genreIds: String(args.genre).split(','), label: String(args.genre).split(',').map(id => genreLabels[id] || 'selected genre').join(' + ') }, recommendedMovies: selected.map(movie => ({ title: movie.title, year: movie.year || null })) });
        }
        await saveConversation(conversationId, 'assistant', recommendationAnswer);
        await finishExecution(execution.id, 'completed', 0);
        onEvent({ type: 'complete', answer: recommendationAnswer, steps: 0, conversationId, executionId: execution.id });
        return { answer: recommendationAnswer, steps: 0, conversationId, executionId: execution.id };
      }
      messages.push({ role: 'system', content: `TMDB movie discovery has already been completed for this request. Use only these verified movie results for the other requested actions; do not repeat search_movies unless more candidates are necessary. Results: ${safeSerialize(movies.slice(0, 10), 16000)}` });
    }

    if (workflowIntent === 'cinema') {
      const priorUserText = [...history].filter(message => message.role === 'user').map(message => message.content).join(' ');
      const requestedTime = extractRequestedTime(userMessage) || bookingState?.requestedTime || extractRequestedTime(priorUserText);
      let initialBookingPreference = buildCinemaMoviePreference(userMessage);
      if (!initialBookingPreference && bookingState?.selectedMovie) {
        initialBookingPreference = { type: 'title', title: bookingState.selectedMovie, label: bookingState.selectedMovie, count: 1 };
      }
      const requestedTicketCount = (stateStage === 'awaiting_booking_details' ? bookingState?.ticketCount : null) || parseTicketCount(userMessage) || bookingState?.ticketCount || parseTicketCount(priorUserText);
      if (!requestedTime) {
        if (requestIntents.booking || isDirectBookingRequest(userMessage) || stateStage === 'awaiting_booking_details') {
          const selectedMovie = initialBookingPreference?.type === 'title' ? initialBookingPreference.title : bookingState?.selectedMovie || null;
          await setConversationState(conversationId, { ...(bookingState || {}), stage: 'awaiting_booking_details', selectedMovie, moviePreference: initialBookingPreference?.type === 'title' ? initialBookingPreference : bookingState?.moviePreference || null, ticketCount: requestedTicketCount || null });
          const answer = `I can help book ${requestedTicketCount || 'your'} ticket(s)${selectedMovie ? ` for **${selectedMovie}**` : ''}. What time would you like to watch? I will also need your city or shared device location to find the demo screenings.`;
          await saveConversation(conversationId, 'assistant', answer);
          await finishExecution(execution.id, 'completed', 0);
          onEvent({ type: 'complete', answer, steps: 0, conversationId, executionId: execution.id });
          return { answer, steps: 0, conversationId, executionId: execution.id };
        }
        const answer = 'What time would you like to watch the movie? I will check demo cinema screenings within 2 hours before and after that time.';
        await saveConversation(conversationId, 'assistant', answer);
        await finishExecution(execution.id, 'completed', 0);
        onEvent({ type: 'complete', answer, steps: 0, conversationId, executionId: execution.id });
        return { answer, steps: 0, conversationId, executionId: execution.id };
      }
      if (requestedTime) {
        let resolved;
        const explicitCity = extractSupportedCity([userMessage, ...history.filter(message => message.role === 'user').map(message => message.content)].join(' '));
        if (location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lon))) {
          onEvent({ type: 'status', message: 'Resolving your location and nearby cinema screenings…', model: 'system' });
          try { resolved = await reverseGeocodeSupportedCity(location); }
          catch (error) {
            if (!explicitCity) {
              const answer = 'I could not resolve your device location right now. Please enter your city/locality and I will search its demo cinema schedule.';
              await saveConversation(conversationId, 'assistant', answer);
              await finishExecution(execution.id, 'completed', 0, error.message);
              onEvent({ type: 'complete', answer, steps: 0, conversationId, executionId: execution.id });
              return { answer, steps: 0, conversationId, executionId: execution.id };
            }
            resolved = { supported: true, city: explicitCity, locality: null, label: explicitCity };
          }
          if (!resolved.supported && explicitCity) {
            resolved = { supported: true, city: explicitCity, locality: null, label: explicitCity };
          }
          if (resolved.supported) {
            // Reverse geocoding already supplies the locality. Do not geocode every
            // seeded theatre here: the sequential public-geocoder calls can stall
            // this request for tens of seconds and are not needed to search shows.
            resolved.locality = resolved.locality || null;
          }
        } else if (explicitCity) {
          resolved = { supported: true, city: explicitCity, locality: null, label: explicitCity };
        } else if (pausedBookingState?.city) {
          // Reuse only the previously resolved location for a fresh 'near me'
          // search; do not carry forward its movie, genre, time or price filters.
          resolved = { supported: true, city: pausedBookingState.city, locality: pausedBookingState.locality || null, label: pausedBookingState.locationLabel || pausedBookingState.city };
        } else {
          const answer = 'Please share your device location or tell me your city/locality so I can find nearby cinema screenings.';
          await saveConversation(conversationId, 'assistant', answer);
          await finishExecution(execution.id, 'completed', 0);
          onEvent({ type: 'complete', answer, steps: 0, conversationId, executionId: execution.id });
          return { answer, steps: 0, conversationId, executionId: execution.id };
        }
        if (!resolved?.supported) {
          const answer = 'I could not match your location to one of my six supported demo metro areas. Please enter Bengaluru, Mumbai, Delhi NCR, Hyderabad, Chennai or Pune.';
          await saveConversation(conversationId, 'assistant', answer);
          await finishExecution(execution.id, 'completed', 0);
          onEvent({ type: 'complete', answer, steps: 0, conversationId, executionId: execution.id });
          return { answer, steps: 0, conversationId, executionId: execution.id };
        }
        const date = indiaLocalDate();
        const locality = resolved.locality || undefined;
        let moviePreference = buildCinemaMoviePreference(userMessage);
        if (!moviePreference && bookingState?.moviePreference?.type === 'title') {
          moviePreference = bookingState.moviePreference;
        }
        if (!moviePreference && bookingState?.selectedMovie) {
          moviePreference = { type: 'title', title: bookingState.selectedMovie, label: bookingState.selectedMovie, count: 1 };
        }
        if (!moviePreference && stateStage === 'awaiting_booking_details') {
          moviePreference = recoverBookingMoviePreference(history);
        }
        if (!moviePreference && stateStage === 'awaiting_genre_showtime' && bookingState?.genrePreference) {
          moviePreference = bookingState.selectedMovie
            ? { type: 'title', title: bookingState.selectedMovie, label: bookingState.selectedMovie, count: 6 }
            : bookingState.genrePreference;
        }
        // Carry the last explicit movie preference into short follow-ups such as
        // "showtimes" and "7 pm". Do not apply it after an intervening new
        // movie/genre request; only inspect the recent conversation window.
        if (!moviePreference) {
          moviePreference = recoverBookingMoviePreference(history);
        }
        const bookingContext = Boolean(requestIntents.booking || isDirectBookingRequest(userMessage) || stateStage === 'awaiting_booking_details' || bookingState?.ticketCount || recoverBookingMoviePreference(history));
        if (!moviePreference) {
          for (const prior of [...history].reverse()) {
            if (prior.role !== 'user') continue;
            const priorPreference = buildCinemaMoviePreference(prior.content);
            if (priorPreference) { moviePreference = priorPreference; break; }
          }
        }
        let includeMovieTitles = null;

        // Genre matching uses the explicit primary genre stored on each seeded
        // cinema screening. This avoids an unrelated TMDB title list overriding
        // the user's genre choice. Title requests still verify against TMDB.
        if (moviePreference?.type === 'title') {
          onEvent({ type: 'status', message: `Matching ${moviePreference.title} against the demo cinema catalogue…`, model: 'system' });
          try {
            const localTitle = await resolveLocalMovieTitle(moviePreference.title);
            if (localTitle) {
              includeMovieTitles = [localTitle];
              moviePreference = { ...moviePreference, title: localTitle, label: localTitle };
            } else {
              const matches = await searchMovies({ query: moviePreference.title });
              const exactMatch = matches.find(movie => normalizeMovieTitle(movie.title) === normalizeMovieTitle(moviePreference.title));
              includeMovieTitles = exactMatch ? [exactMatch.title] : [];
            }
          } catch (error) {
            const answer = `I couldn't verify "${moviePreference.title}" with TMDB, so I haven't substituted another movie. TMDB error: ${error.message}`;
            await saveConversation(conversationId, 'assistant', answer);
            await finishExecution(execution.id, 'failed', 0, error.message);
            onEvent({ type: 'complete', answer, steps: 0, conversationId, executionId: execution.id });
            return { answer, steps: 0, conversationId, executionId: execution.id };
          }
        }

        const priorUserMessage = [...history].reverse().find(message => message.role === 'user')?.content || '';
        const priceFilter = extractTicketPriceFilter(userMessage) || (!freshIntents.movieRecommendation ? extractTicketPriceFilter(priorUserMessage) : null);
        const afterRequestedTime = /\bafter\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(userMessage);
        // Language wording such as 'preferably in English' is informational only.
        // Do not filter or rank screenings by language unless the user explicitly
        // asks for a language-only search in a separately supported workflow.
        const args = {
          city: resolved.city, locality, date, requestedTime, windowHours: 2, afterRequestedTime,
          ...(priceFilter || {}),
          ...(moviePreference ? { preference: moviePreference } : {}),
          ...(includeMovieTitles ? { includeMovieTitles } : {})
        };
        const startedAt = Date.now();
        onEvent({ type: 'tool_start', tool: 'find_recommendable_shows', args, step: 0, deterministic: true });
        let result = await findRecommendableShows(args);
        // If a user selected one recommended title but it has no demo screening
        // in the requested window, fall back to all seeded screenings in genre.
        if (moviePreference?.type === 'title' && (!result.shows || result.shows.length === 0) && bookingState?.genrePreference) {
          const fallbackArgs = { ...args, preference: bookingState.genrePreference, includeMovieTitles: undefined };
          delete fallbackArgs.includeMovieTitles;
          const fallback = await findRecommendableShows(fallbackArgs);
          if (fallback.shows?.length) {
            result = fallback;
            moviePreference = bookingState.genrePreference;
            includeMovieTitles = null;
          }
        }
        toolResults.push({ tool: 'find_recommendable_shows', args, result, status: 'success' });
        await saveToolLog({ executionId: execution.id, conversationId, toolName: 'find_recommendable_shows', args, result, status: 'success', durationMs: Date.now() - startedAt });
        onEvent({ type: 'tool_result', tool: 'find_recommendable_shows', success: true, result: { city: resolved.city, locality: locality || null, date, requestedTime, showCount: result.showCount, nearestCinema: null }, step: 0, deterministic: true });

        // Fulfil explicit multi-intent show + seat requests in the same turn.
        // This is a read-only lookup; booking remains a separate confirmed action.
        const seatLookups = [];
        const maxDisplayedShows = moviePreference?.count
          ? Math.min(6, moviePreference.count)
          : 6;
        if (requestIntents.seatAvailability && Array.isArray(result.shows) && result.shows.length) {
          // Show seat availability for each candidate, not just the first show.
          // A cap protects latency while still giving the user meaningful choices.
          for (const candidate of result.shows.slice(0, maxDisplayedShows)) {
            const seatArgs = { showId: candidate.showId };
            const seatStartedAt = Date.now();
            onEvent({ type: 'tool_start', tool: 'get_show_seats', args: seatArgs, step: 0, deterministic: true });
            try {
              const seatMap = await executeTool('get_show_seats', seatArgs, { location, allowedTools, intent: workflowIntent });
              const categories = (seatMap.categories || []).map(category => ({
                category: category.label, price: category.price,
                availableSeats: (category.seats || []).filter(seat => seat.status === 'AVAILABLE').map(seat => seat.seat)
              }));
              const priority = ['picture perfect', 'recliner', 'standard'];
              const bestCategory = [...categories].sort((a, b) => {
                const ai = priority.indexOf(String(a.category).toLowerCase());
                const bi = priority.indexOf(String(b.category).toLowerCase());
                return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
              }).find(category => category.availableSeats.length);
              const summary = {
                showId: seatMap.showId, movieTitle: seatMap.movieTitle, city: seatMap.city,
                mall: seatMap.mall, theatre: seatMap.theatre, auditorium: seatMap.auditorium,
                date: seatMap.date, time: seatMap.time, format: seatMap.format,
                categories, bestAvailableCategory: bestCategory?.category || null,
                bestAvailableSeats: bestCategory?.availableSeats.slice(0, 8) || []
              };
              seatLookups.push(summary);
              toolResults.push({ tool: 'get_show_seats', args: seatArgs, result: seatMap, status: 'success' });
              onEvent({ type: 'tool_result', tool: 'get_show_seats', success: true, result: { showId: seatMap.showId, availableSeatCount: categories.reduce((n, c) => n + c.availableSeats.length, 0) }, step: 0, deterministic: true });
              // Logging is non-critical. A transient JSON-store rename error must
              // never turn a successful seat-map read into a failed seat lookup.
              try {
                await saveToolLog({ executionId: execution.id, conversationId, toolName: 'get_show_seats', args: seatArgs, result: seatMap, status: 'success', durationMs: Date.now() - seatStartedAt });
              } catch (logError) {
                console.warn('[cinema] Seat map succeeded but tool logging failed:', logError.message);
              }
            } catch (error) {
              const message = error.message || 'Seat lookup failed';
              seatLookups.push({ showId: candidate.showId, movieTitle: candidate.movieTitle, time: candidate.time, error: message });
              toolResults.push({ tool: 'get_show_seats', args: seatArgs, result: { error: message }, status: 'error' });
              try { await saveToolLog({ executionId: execution.id, conversationId, toolName: 'get_show_seats', args: seatArgs, result: { error: message }, status: 'error', durationMs: Date.now() - seatStartedAt, error: message }); }
              catch (logError) { console.warn('[cinema] Failed to log seat lookup error:', logError.message); }
              onEvent({ type: 'tool_result', tool: 'get_show_seats', success: false, error: message, step: 0, deterministic: true });
            }
          }
        }
        messages.push({ role: 'system', content: `DETERMINISTIC CINEMA LOCATION AND SHOWTIME LOOKUP COMPLETED. Resolved user location: ${resolved.label || resolved.city}. Local date in India (Asia/Kolkata): ${date}. Requested time: ${requestedTime}. The tool find_recommendable_shows has ALREADY been executed; do not call it again. Use ONLY verified screenings. Show all matching screenings (up to six) ordered by proximity to the requested time. If the user named a movie, show only that movie's screenings; do not substitute another title. The requested time window is +/- 2 hours. If no matching screenings exist, say so; never invent alternatives. ${requestIntents.seatAvailability ? `Seat availability was requested. Display the real seat availability for each candidate below, including best available category and sample seat labels. Seat lookup is read-only.` : ''} ${requestIntents.booking ? 'The user has booking intent. Present matching choices and guide them through selection, seats, summary and explicit final confirmation. Do not book in this turn.' : 'This is a discovery-only request. Ask the user to choose a movie and exact showtime. Do not book, reserve or select on their behalf.'} Never automatically choose a movie/show or call book_demo_seats unless the user explicitly confirms the exact booking summary in a later turn. Verified showtime results: ${safeSerialize(compactToolResult(result), MAX_LOCAL_TOOL_CHARS)}. Verified seat results: ${safeSerialize(seatLookups, 24000)}. Complete all requested read-only actions and ask the user to choose.` });
        // Do not hand a completed read-only cinema discovery back to the LLM.
        // The model was previously continuing its old booking dialogue instead of
        // rendering these verified results, leaving the user with a blocked-booking
        // message and no screenings. Return a grounded result directly.
        const seatByShowId = new Map(seatLookups.map(item => [item.showId, item]));
        const candidates = (result.shows || []).slice(0, maxDisplayedShows);
        const formatTime = value => {
          const [hourText, minuteText] = String(value || '').split(':');
          const hour = Number(hourText);
          if (!Number.isFinite(hour)) return value || 'Time unavailable';
          const suffix = hour >= 12 ? 'PM' : 'AM';
          return `${hour % 12 || 12}:${String(minuteText || '00').padStart(2, '0')} ${suffix}`;
        };
        const showLines = candidates.map((show, index) => {
          const seatInfo = seatByShowId.get(show.showId);
          const details = [
            `${index + 1}. **${show.movieTitle}**`,
            `   - **Showtime:** ${formatTime(show.time)} | ${show.date}`,
            `   - **Cinema:** ${show.theatre}, ${show.mall}`,
            `   - **Location:** ${show.locality || show.city}${Number.isFinite(Number(show.distanceKm)) ? ` (${show.distanceKm} km)` : ''}`,
            `   - **Genre:** ${show.genre || 'Not specified'}\n   - **Screen:** ${show.auditorium || 'Not specified'} | ${show.format || 'Format unavailable'} | ${show.language || 'Language unavailable'}`
          ];
          if (requestIntents.seatAvailability) {
            if (!seatInfo) details.push('   - **Seats:** Seat availability could not be retrieved for this screening.');
            else if (seatInfo.error) details.push(`   - **Seats:** Lookup failed: ${seatInfo.error}`);
            else if (!seatInfo.bestAvailableSeats?.length) details.push('   - **Seats:** No available seats found.');
            else details.push(`   - **Best available:** ${seatInfo.bestAvailableCategory} — ${seatInfo.bestAvailableSeats.join(', ')}${seatInfo.categories?.find(c => c.category === seatInfo.bestAvailableCategory)?.price != null ? ` (₹${seatInfo.categories.find(c => c.category === seatInfo.bestAvailableCategory).price} per seat)` : ''}`);
          }
          return details.join('\n');
        });
        const preferenceLead = moviePreference
          ? ` matching ${moviePreference.label} preference`
          : '';
        const priceLead = priceFilter ? ` within the ₹${priceFilter.minPrice ?? 0}${priceFilter.maxPrice != null ? `–₹${priceFilter.maxPrice}` : '+'} per-ticket price filter` : '';
        const nextStepPrompt = bookingContext
          ? `**Choose the ${moviePreference?.label || 'requested movie'} screening and exact showtime you'd like for your ${requestedTicketCount || bookingState?.ticketCount || 2} tickets.** I'll then show available seats. Nothing has been booked yet.`
          : '**Which movie and exact showtime would you like?** I will continue with that screening. I have not booked anything.';
        const timeDescription = afterRequestedTime ? `after ${formatTime(requestedTime)}` : `within 2 hours of ${formatTime(requestedTime)}`;
        const answer = candidates.length
          ? `I found ${result.showCount ?? candidates.length} matching demo screening(s)${preferenceLead}${priceLead} near ${resolved.label || resolved.city}, ${timeDescription}. Here are the closest matches${candidates.length < (result.shows || []).length ? ' (showing the first six)' : ''}:\n\n${showLines.join('\n\n')}\n\n${nextStepPrompt}`
          : moviePreference
            ? `I couldn't find any demo screenings for **${moviePreference.label}** near ${resolved.label || resolved.city} within 2 hours of ${formatTime(requestedTime)} on ${date}. I haven't substituted unrelated movies. Try a different time or locality.`
            : `I couldn't find any demo cinema screenings near ${resolved.label || resolved.city} within 2 hours of ${formatTime(requestedTime)} on ${date}. No movie or show has been selected or booked.`;
        if (candidates.length) {
          await setConversationState(conversationId, {
            stage: 'picking_show',
            ...(pausedBookingState ? { pausedBooking: pausedBookingState } : {}),
            ...(moviePreference?.type === 'title' ? { selectedMovie: moviePreference.title, moviePreference } : {}),
            candidates,
            seatLookups,
            requestedTime,
            ticketCount: bookingContext ? (requestedTicketCount || bookingState?.ticketCount || null) : (bookingState?.ticketCount || null),
            date,
            city: resolved.city,
            locality: resolved.locality || null,
            locationLabel: resolved.label || resolved.city
          });
        }
        await saveConversation(conversationId, 'assistant', answer);
        await finishExecution(execution.id, 'completed', 0);
        onEvent({ type: 'complete', answer, steps: 0, conversationId, executionId: execution.id });
        return { answer, steps: 0, conversationId, executionId: execution.id };
      }
    }
    for (let step = 1; step <= MAX_STEPS; step++) {
      completedSteps = step;
      onEvent({ type: 'thinking', step, message: `Local planning step ${step}`, model: 'ollama' });
      const assistantMessage = await planNextAction(messages, workflowIntent);
      messages.push(assistantMessage);

      const calls = assistantMessage.tool_calls || [];
      if (calls.length === 0) {
        let answer = assistantMessage.content || 'I could not generate a response. Please try again.';
        answer = await maybeUseGroq({ userMessage, draft: answer, toolResults, onEvent });
        await saveConversation(conversationId, 'assistant', answer);
        await finishExecution(execution.id, 'completed', step);
        onEvent({ type: 'complete', answer, steps: step, conversationId, executionId: execution.id });
        return { answer, steps: step, conversationId, executionId: execution.id };
      }

      for (const call of calls) {
        const name = call.function?.name;
        let args = call.function?.arguments || {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        onEvent({ type: 'tool_start', tool: name, args, step, model: 'ollama' });
        const stableArgs = stableStringify(args || {});
        const callKey = `${name}:${stableArgs}`;
        if (executedToolCalls.has(callKey)) {
          const cached = executedToolCalls.get(callKey);
          messages.push({ role: 'tool', tool_name: name, content: safeSerialize(cached, MAX_LOCAL_TOOL_CHARS) });
          messages.push({ role: 'system', content: `The tool ${name} with these exact arguments has already succeeded in this turn. Do not call it again. Use its existing result and complete the user's request or call a different required tool.` });
          onEvent({ type: 'tool_result', tool: name, success: true, cached: true, step });
          continue;
        }
        const startedAt = Date.now();
        try {
          if (name === 'book_demo_seats' && !bookingAuthorized) {
            throw new Error('Booking blocked: the user has not explicitly confirmed a specific booking summary.');
          }
          const result = await executeTool(name, args, { location, allowedTools, intent: workflowIntent });
          toolResults.push({ tool: name, args, result, status: 'success' });
          executedToolCalls.set(callKey, result);
          const serialized = safeSerialize(result, MAX_LOCAL_TOOL_CHARS);
          await saveToolLog({
            executionId: execution.id, conversationId, toolName: name, args,
            result, status: 'success', durationMs: Date.now() - startedAt
          });
          messages.push({ role: 'tool', tool_name: name, content: serialized });
          onEvent({ type: 'tool_result', tool: name, success: true, preview: serialized.slice(0, 900), step });
        } catch (error) {
          const message = error.response?.data?.status_message || error.message || 'Tool execution failed';
          toolResults.push({ tool: name, args, result: { error: message }, status: 'error' });
          await saveToolLog({
            executionId: execution.id, conversationId, toolName: name, args,
            result: { error: message }, status: 'error',
            durationMs: Date.now() - startedAt, error: message
          });
          messages.push({ role: 'tool', tool_name: name, content: JSON.stringify({ error: message }) });
          onEvent({ type: 'tool_result', tool: name, success: false, error: message, step });
        }
      }

      const lastResult = toolResults[toolResults.length - 1];
      if (lastResult && lastResult.status === 'success' && isSingleActionRequest(userMessage)) {
        const terminalAnswer = terminalToolAnswer(lastResult.tool, lastResult.result);
        if (terminalAnswer) {
          await saveConversation(conversationId, 'assistant', terminalAnswer);
          await finishExecution(execution.id, 'completed', step);
          onEvent({ type: 'complete', answer: terminalAnswer, steps: step, conversationId, executionId: execution.id });
          return { answer: terminalAnswer, steps: step, conversationId, executionId: execution.id };
        }
      }
    }

    messages.push({ role: 'user', content: 'Summarise the verified results gathered so far. Clearly state anything incomplete.' });
    const finalMessage = await planNextAction(messages, workflowIntent);
    let answer = finalMessage.content || 'I reached the maximum number of execution steps. Please narrow the request or ask me to continue.';
    answer = await maybeUseGroq({ userMessage, draft: answer, toolResults, onEvent });
    await saveConversation(conversationId, 'assistant', answer);
    await finishExecution(execution.id, 'limit_reached', MAX_STEPS);
    onEvent({ type: 'complete', answer, steps: MAX_STEPS, limitReached: true, conversationId, executionId: execution.id });
    return { answer, steps: MAX_STEPS, limitReached: true, conversationId, executionId: execution.id };
  } catch (error) {
    await finishExecution(execution.id, 'failed', completedSteps, error.message);
    throw error;
  }
}
