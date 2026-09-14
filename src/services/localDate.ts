/**
 * What "today" means at a location (D§1).
 *
 * Someone in Sydney asking at 09:00 their time means Sydney's today, not the server's,
 * and at that moment UTC is still on yesterday. Everything downstream works in local
 * calendar dates, so this is where the instant becomes one.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * `en-CA` formats as YYYY-MM-DD, which is the format the payloads and the database
 * already use, so no reassembly is needed.
 */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch (error) {
    // A zone we cannot resolve would silently fall back to the server's, which is the
    // one mistake this whole module exists to prevent.
    throw new RangeError(`unknown time zone: ${timeZone}`, { cause: error });
  }

  formatters.set(timeZone, formatter);
  return formatter;
}

/** The calendar date at `timeZone` when it is `now`, as YYYY-MM-DD. */
export function todayIn(now: Date, timeZone: string): string {
  if (Number.isNaN(now.getTime())) throw new RangeError('not an instant');
  return formatterFor(timeZone).format(now);
}
