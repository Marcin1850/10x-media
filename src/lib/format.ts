/**
 * Display formatting for the summary list's numeric and temporal fields.
 *
 * Everything here is deterministic and locale-free, and both date helpers build their output from
 * **UTC** parts. That is a hard requirement, not a preference: these cards are rendered once on the
 * Worker during SSR and again in the browser during hydration, and `Intl.DateTimeFormat` with an
 * implicit locale resolves differently on each side, producing a hydration mismatch. UTC also
 * protects `publishedAt` specifically — the vendor supplies date precision only, so every stored
 * value is midnight UTC and reading it in any timezone west of Greenwich shifts the displayed date
 * back a full day.
 *
 * Accepted cost: a creation timestamp IS a real instant, so a summary generated at 01:00 in Warsaw
 * displays as the previous day. This is the price of one deterministic render, and it is the smaller
 * error — a date-only field silently off by one is worse than a timestamped one shown in UTC.
 * Revisit if S-06 introduces locale-aware formatting; a client-only `useEffect` swap to local time is
 * the escape hatch, deliberately not taken here.
 */

/**
 * `m:ss` under an hour, `h:mm:ss` at or above it. Local data spans 51 s to 4523 s, so both shapes
 * occur. Returns `null` for a missing duration so the caller can omit the field rather than render a
 * dash; a negative or non-finite value is treated the same way, since it cannot be a duration.
 */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` from UTC parts, or `null` when the input is missing or unparseable. */
function toUtcDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * The video's upload date. Date precision only — the vendor stores midnight UTC, so rendering a time
 * would fabricate one. Nullable: pre-S-08 rows carry no `published_at`.
 */
export function formatPublishedDate(iso: string | null): string | null {
  return iso === null ? null : toUtcDate(iso);
}

/**
 * The date a summary was generated. Non-nullable input: `summaries.created_at` is `NOT NULL`. Falls
 * back to the raw string only if it somehow fails to parse, so a card never renders "null".
 */
export function formatCreatedDate(iso: string): string {
  return toUtcDate(iso) ?? iso;
}
