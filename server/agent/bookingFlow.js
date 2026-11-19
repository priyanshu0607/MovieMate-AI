const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function parseTicketCount(message) {
  // Strip clock expressions first: without this, a reply such as '7 pm' was
  // incorrectly parsed as seven tickets during an in-progress booking.
  const text = String(message || '').toLowerCase()
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi, ' ')
    .replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g, ' ');
  const digit = text.match(/\b(\d{1,2})\s*(?:tickets?|seats?|tkts?)?\b/);
  if (digit && Number(digit[1]) >= 1 && Number(digit[1]) <= 10) return Number(digit[1]);
  for (const [word, count] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return count;
  }
  return null;
}

export function resolveShowSelection(message, candidates = []) {
  const text = normalize(message);
  if (!text || !Array.isArray(candidates)) return { status: 'none' };
  const ordinal = String(message).toLowerCase().match(/\b(?:option\s*)?(\d{1,2})(?:st|nd|rd|th)?\b|\b(first|second|third|fourth|fifth|sixth)\b/);
  if (ordinal) {
    const words = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
    const index = ordinal[2] ? words[ordinal[2]] : Number(ordinal[1]);
    if (index >= 1 && index <= candidates.length) return { status: 'selected', show: candidates[index - 1] };
  }
  const matches = candidates.filter(show => {
    const title = normalize(show.movieTitle);
    const theatre = normalize(show.theatre);
    const mall = normalize(show.mall);
    const time = normalize(show.time);
    const date = normalize(show.date);
    const titleMatch = title && (text.includes(title) || title.includes(text));
    const extraTerms = [theatre, mall, time, date].filter(Boolean);
    return titleMatch && (extraTerms.every(term => !text.includes(term) || term.length < 4) || text.includes(title));
  });
  if (!matches.length) return { status: 'none' };
  const unique = [...new Map(matches.map(show => [show.showId, show])).values()];
  if (unique.length === 1) return { status: 'selected', show: unique[0] };
  const explicitTime = candidates.filter(show => {
    const t = String(show.time || '');
    if (!t) return false;
    const [h, m] = t.split(':').map(Number);
    const hour12 = h % 12 || 12;
    const ampm = h >= 12 ? 'pm' : 'am';
    return new RegExp(`\\b${hour12}(?::${String(m).padStart(2,'0')})?\\s*${ampm}\\b`, 'i').test(String(message));
  }).filter(show => normalize(show.movieTitle) === normalize(matches[0].movieTitle));
  if (explicitTime.length === 1) return { status: 'selected', show: explicitTime[0] };
  return { status: 'ambiguous', shows: unique };
}

export function getSeatOptions(seatLookup, count = 2) {
  if (!seatLookup || seatLookup.error) return [];
  const categories = seatLookup.categories || [];
  const priority = ['picture perfect', 'standard', 'recliner'];
  const ordered = [...categories].sort((a, b) => {
    const ai = priority.indexOf(String(a.category).toLowerCase());
    const bi = priority.indexOf(String(b.category).toLowerCase());
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  return ordered.map(category => ({
    category: category.category,
    price: Number(category.price) || 0,
    seats: (category.availableSeats || []).slice(0, 30),
    recommended: (category.availableSeats || []).slice(0, count)
  })).filter(category => category.seats.length >= count);
}

export function parseSeatLabels(message) {
  return [...new Set((String(message || '').toUpperCase().match(/\b[A-Z]\s?-?\d{1,2}\b/g) || []).map(x => x.replace(/\s+/g, '').replace('-', '')))];
}
