export function timeToMinutes(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error('Time must use 24-hour HH:MM format, e.g. 20:00.');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error('Time is not valid.');
  return hours * 60 + minutes;
}
