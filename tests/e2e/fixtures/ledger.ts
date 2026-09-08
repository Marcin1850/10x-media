import { getDbOwnerConnection } from "@/test/db-owner";

/**
 * The other half of every spec's oracle.
 *
 * Risk #6 is *"a UI refactor silently misreports paid work"* — a card that does not match what was
 * actually charged. Asserting only what the card says proves the card is self-consistent, which is
 * exactly the property a UI refactor keeps true while breaking the truth. So every spec also reads
 * what the request really did, here, straight out of Postgres.
 *
 * Read through the table-owner connection (`db-owner.ts`), and never through the app's own
 * `getBalance`/`listSummaries`: those carry their own `.eq("user_id", …)`, so a read through them
 * would agree with the card for the same reason the card is wrong (CLAUDE.md §Testing). This is a
 * claim about the database, made without the application in the loop.
 */

/** The user's credit balance. `null` when the account has no `user_credits` row at all. */
export async function readBalance(userId: string): Promise<number | null> {
  const sql = getDbOwnerConnection();
  const rows = await sql<{ balance: number }[]>`select balance from user_credits where user_id = ${userId}`;
  return rows.length === 0 ? null : rows[0].balance;
}

export interface ReservationRow {
  id: string;
  amount: number;
  status: string;
  /**
   * Why this row is a REFUSAL charge rather than a generation debit — `'unavailable'`, `'empty'` or
   * `'whitespace'`, and `null` on every row `begin_generation` writes
   * (`20260731110000_charge_failed_transcript.sql`).
   *
   * It is the ledger-side partner of the card's cause-specific Polish copy. A refusal card names ONE
   * cause, and the client resolves that name from the server's `code`; without this column a card
   * announcing "no caption track" for a row the database charged as `empty` would satisfy every other
   * assertion here — the card self-consistent, the balance right, the cause wrong. That is risk #6 in
   * the shape only the refusal specs can reach.
   */
  refusalReason: string | null;
}

/**
 * Every credit reservation this user has, oldest first. A generation's full paper trail is one row:
 * `reserved` while the paid work runs, then `settled` (the credit was spent) or `refunded` (it was
 * not). A spec asserts the row's `status` AND its `amount` — a settled 1 and a settled 2 are the
 * difference between the documented cost of a short video and of a long one — and, on a refusal, its
 * `refusalReason`, which is the only place the CAUSE the app charged for is recorded.
 */
export async function readReservations(userId: string): Promise<ReservationRow[]> {
  const sql = getDbOwnerConnection();
  return await sql<ReservationRow[]>`
    select id, amount, status, refusal_reason as "refusalReason"
    from credit_reservations where user_id = ${userId} order by created_at
  `;
}

/**
 * Rows in `supadata_calls` for the given ids — the evidence that a paid transcript/metadata fetch
 * happened. A green e2e run leaves this empty: both Supadata checkpoints are cache hits by
 * construction (`seed-cache.ts`), so a row here means a vendor was really contacted.
 */
export async function readSupadataCalls(youtubeIds: readonly string[]): Promise<{ youtube_id: string }[]> {
  const sql = getDbOwnerConnection();
  const ids = [...youtubeIds];
  return await sql<{ youtube_id: string }[]>`select youtube_id from supadata_calls where youtube_id in ${sql(ids)}`;
}

export interface StoredSummary {
  id: string;
  youtubeId: string;
  character: string;
  content: string;
  model: string | null;
  reservationId: string | null;
}

/**
 * Every summary this user has, oldest first, joined to the video it belongs to.
 *
 * This is the "or saved" half of risk #6: `content` is what the database actually holds, so a card
 * showing something else — another video's summary, a stale body, a truncated one — is a mismatch this
 * read catches and a UI-only assertion cannot.
 */
export async function readSummaries(userId: string): Promise<StoredSummary[]> {
  const sql = getDbOwnerConnection();
  return await sql<StoredSummary[]>`
    select s.id, v.youtube_id as "youtubeId", s.character, s.content, s.model, s.reservation_id as "reservationId"
    from summaries s
    join videos v on v.id = s.video_id
    where s.user_id = ${userId}
    order by s.created_at
  `;
}
