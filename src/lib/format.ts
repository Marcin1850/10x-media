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

/** The video's watch page. `youtubeId` is always present on a list item (`NOT NULL` column). */
export function youtubeWatchUrl(youtubeId: string): string {
  return `https://www.youtube.com/watch?v=${youtubeId}`;
}

/**
 * The channel's canonical page, built from its stable id (`channelId`) rather than `channelName` —
 * the display name is not a valid link target. `/channel/<id>` rather than a vanity `/@handle`: the
 * vendor does not report a handle for YouTube (see `VideoMetadata.channelId`), and the id form always
 * resolves regardless of whether the channel has claimed a handle.
 */
export function youtubeChannelUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
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
 * Whole UTC calendar days between `iso` and `now`. Built from `Date.UTC` day-parts rather than a raw
 * millisecond subtraction, so it agrees with `toUtcDate`'s calendar day rather than a rolling 24h
 * window — "published yesterday" should not flip to "2 days ago" purely because the exact
 * time-of-day-of-fetch happens to be earlier than the time-of-day-of-upload.
 *
 * `now` defaults to the real clock, unlike every other helper in this file: a relative age is
 * SUPPOSED to change from one render to the next as real time passes, so freezing it would defeat the
 * point. The one cost is the risk `formatCreatedDate` et al. exist to avoid — SSR and hydration call
 * this microseconds apart, and if that gap straddles a UTC midnight the two renders disagree by one
 * day, which React reconciles as a harmless single-frame correction. Accepted: the window this can
 * happen in is a few milliseconds wide out of 86,400,000 in a day.
 *
 * A negative result (an `iso` after `now` — clock skew, not a real case in this app's data) clamps to
 * 0 rather than reading as "in the future". Returns `null` when the input doesn't parse, matching the
 * other helpers.
 */
export function daysSince(iso: string | null, now: Date = new Date()): number | null {
  if (iso === null) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;

  const thenUtcDay = Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate());
  const nowUtcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diffDays = Math.round((nowUtcDay - thenUtcDay) / 86_400_000);
  return diffDays > 0 ? diffDays : 0;
}

/** The unit a relative-time UI should render — `"today"`/`"yesterday"` are their own units rather than `{ unit: "days", value: 0 | 1 }` so a copy module can give them their own word instead of a generic "0 days ago" / "1 day ago". */
export type RelativeTimeUnit = "today" | "yesterday" | "days" | "weeks" | "months" | "years";

/**
 * Buckets a day count (from `daysSince`) into the unit + magnitude a relative-time UI should render —
 * the language-independent half of "3 weeks ago"-style formatting. Every locale would pick the exact
 * same bucket for the same input, so it lives here rather than being re-decided per copy module; only
 * turning `{ unit, value }` into words is locale-specific (see `relativeTime` in `copy/pl.ts`).
 *
 * Day/week/month/year granularity, trading exactness for readability the way most relative-time UIs
 * do — a 47-day-old video buckets to `{ unit: "months", value: 1 }`, not an exact day or calendar-month
 * count.
 */
export function relativeTimeBucket(days: number): { unit: RelativeTimeUnit; value: number } {
  if (days === 0) return { unit: "today", value: 0 };
  if (days === 1) return { unit: "yesterday", value: 1 };
  if (days < 7) return { unit: "days", value: days };
  if (days < 30) return { unit: "weeks", value: Math.floor(days / 7) };
  if (days < 365) return { unit: "months", value: Math.floor(days / 30) };
  return { unit: "years", value: Math.floor(days / 365) };
}

/**
 * The date a summary was generated. Non-nullable input: `summaries.created_at` is `NOT NULL`. Falls
 * back to the raw string only if it somehow fails to parse, so a card never renders "null".
 */
export function formatCreatedDate(iso: string): string {
  return toUtcDate(iso) ?? iso;
}
