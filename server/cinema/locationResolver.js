const CITY_ALIASES = new Map([
  ['bengaluru', 'Bengaluru'], ['bangalore', 'Bengaluru'],
  ['mumbai', 'Mumbai'], ['bombay', 'Mumbai'],
  ['delhi', 'Delhi NCR'], ['new delhi', 'Delhi NCR'], ['gurugram', 'Delhi NCR'], ['gurgaon', 'Delhi NCR'], ['noida', 'Delhi NCR'], ['ghaziabad', 'Delhi NCR'],
  ['hyderabad', 'Hyderabad'], ['secunderabad', 'Hyderabad'],
  ['chennai', 'Chennai'], ['madras', 'Chennai'],
  ['pune', 'Pune']
]);


export function extractSupportedCity(text) {
  const value = String(text || '').toLowerCase();
  const aliases = [...CITY_ALIASES.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [alias, city] of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(value)) return city;
  }
  return null;
}

export function indiaLocalDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function extractRequestedTime(message) {
  const text = String(message || '');
  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (match) {
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (match[3].toLowerCase() === 'am') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const twentyFour = text.match(/\b(?:at|around)\s+(\d{1,2}):(\d{2})\b/i);
  if (twentyFour) {
    const h = Number(twentyFour[1]), m = Number(twentyFour[2]);
    if (h <= 23 && m <= 59) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  if (/\btonight\b/i.test(text) && /\b(theatres?|theaters?|cinemas?|playing|showing|screenings?|showtimes?|near me)\b/i.test(text)) return '20:00';
  return null;
}

export function isCinemaTimeWorkflowRequest(message) {
  const text = String(message || '').toLowerCase();
  const explicitCinema = /\b(theatres?|theaters?|cinemas?|showtimes?|screenings?)\b/.test(text);
  const asksForSeats = /\b(available\s+seats?|seat\s+availability|show\s+me\s+(?:the\s+)?(?:available\s+)?seats?|seat\s+map|which seats are free|free seats?)\b/.test(text);
  const asksForTimedShow = /\b(?:find|show|look\s+for|get)\b.{0,60}\bshow\b/.test(text) &&
    /\b(?:near\s+me|nearby|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/.test(text);
  const bookingIntent = (/\b(book|booking|reserve)\b/.test(text) &&
    /\b(movie|film|ticket|tickets)\b/.test(text)) || /\bget\s+(?:me\s+)?(?:a\s+)?tickets?\b/.test(text);
  const cinemaRecommendation = /\b(recommend|suggest|pick|choose)\b/.test(text) &&
    /\b(movie|film)\b/.test(text) && explicitCinema;
  const hasLocationAndTime = /\b(?:near\s+me|nearby)\b/.test(text) &&
    /\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|tonight|today|tomorrow)\b/.test(text);
  const preferenceLedTimedCinema = hasLocationAndTime &&
    (/\b(movie|film|comedy|comedies|action|horror|thriller|thrillers|sci[ -]?fi|science fiction|drama|romance|superhero)\b/.test(text) ||
     /\b(find|show|get|look\s+for)\b/.test(text));
  const titleLedTimedCinema = /\b(find|show|get|look\s+for)\b.{0,60}\b(?:near\s+me|nearby)\b/.test(text) &&
    /\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|tonight|today|tomorrow)\b/.test(text);
  const afterTimeNearMe = /\bafter\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(text) && /\bnear\s+me\b/.test(text);
  const showtimeIntent = /\b(showtimes?|screenings?)\b/.test(text);
  return afterTimeNearMe || bookingIntent || cinemaRecommendation || preferenceLedTimedCinema || titleLedTimedCinema || showtimeIntent || asksForSeats || asksForTimedShow;
}

export function isTheatreRecommendationRequest(message) {
  return isCinemaTimeWorkflowRequest(message);
}

export async function reverseGeocodeSupportedCity(location, fetchImpl = fetch) {
  const lat = Number(location?.lat), lon = Number(location?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { supported: false, reason: 'missing_coordinates' };
  }
  const url = new URL('https://photon.komoot.io/reverse');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('lang', 'en');
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'MovieMate-Demo/1.0 (location resolution)' },
    signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) throw new Error(`Reverse geocoding unavailable (${response.status}).`);
  const feature = (await response.json()).features?.[0];
  const props = feature?.properties || {};
  const candidates = [props.city, props.town, props.village, props.county, props.district, props.name, props.state].filter(Boolean).map(v => String(v).toLowerCase());
  let city = null;
  for (const candidate of candidates) {
    for (const [alias, supportedCity] of CITY_ALIASES) {
      if (candidate === alias || candidate.includes(alias)) { city = supportedCity; break; }
    }
    if (city) break;
  }
  const locality = [props.suburb, props.neighbourhood, props.locality, props.district, props.name]
    .find(v => v && !CITY_ALIASES.has(String(v).toLowerCase())) || null;
  return city ? { supported: true, city, locality: locality ? String(locality) : null, label: [locality, city].filter(Boolean).join(', ') }
    : { supported: false, reason: 'unsupported_location', detected: candidates.slice(0, 5) };
}
