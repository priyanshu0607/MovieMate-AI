/** Keep a screening when at least one seat category falls inside the user's
 * per-ticket INR budget. Do not compare a total booking amount here. */
export function filterShowsByTicketPrice(shows = [], { minPrice = null, maxPrice = null } = {}) {
  const hasMin = minPrice != null && Number.isFinite(Number(minPrice));
  const hasMax = maxPrice != null && Number.isFinite(Number(maxPrice));
  if (!hasMin && !hasMax) return [...shows];
  return shows.filter(show => Object.values(show.seat_categories || {}).some(category => {
    const price = Number(category.price);
    return Number.isFinite(price) && (!hasMin || price >= Number(minPrice)) && (!hasMax || price <= Number(maxPrice));
  }));
}

export function filterSeatCategoriesByTicketPrice(categories = [], { minPrice = null, maxPrice = null } = {}) {
  const hasMin = minPrice != null && Number.isFinite(Number(minPrice));
  const hasMax = maxPrice != null && Number.isFinite(Number(maxPrice));
  if (!hasMin && !hasMax) return [...categories];
  return categories.filter(category => {
    const price = Number(category.price);
    return Number.isFinite(price) && (!hasMin || price >= Number(minPrice)) && (!hasMax || price <= Number(maxPrice));
  });
}
