// Manual-only credit refill for the summary-credits feature.
//
// This is the ONLY mechanism that raises a user's balance (besides the new-user seed of 5).
// There is deliberately no client-reachable increment — refills happen offline, here, using the
// Supabase service-role key (which bypasses RLS). Never wire this key into the Worker runtime.
//
// Usage:
//   npm run grant-credits -- <email> <amount>
//   e.g. npm run grant-credits -- user@example.com 5
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (loaded via `node --env-file=.env`).
// Get the service_role key from `npx supabase status` (local) or the dashboard -> Settings -> API.

import { createClient } from "@supabase/supabase-js";

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  fail("SUPABASE_URL is not set. Add it to your .env.");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  fail(
    "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to your .env " +
      "(the service_role key from `npx supabase status` locally, or dashboard -> Settings -> API).",
  );
}

const [email, amountArg] = process.argv.slice(2);

if (!email || amountArg === undefined) {
  fail("Usage: npm run grant-credits -- <email> <amount>");
}

const amount = Number(amountArg);
if (!Number.isInteger(amount) || amount <= 0) {
  fail(`Amount must be a positive integer, got: ${amountArg}`);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Resolve the user_id from the email. auth.admin.listUsers is paginated, so walk the pages.
async function findUserIdByEmail(targetEmail) {
  const needle = targetEmail.toLowerCase();
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      fail(`Failed to list users: ${error.message}`);
    }
    const match = data.users.find((u) => u.email?.toLowerCase() === needle);
    if (match) {
      return match.id;
    }
    if (data.users.length < perPage) {
      return null;
    }
  }
}

const userId = await findUserIdByEmail(email);
if (!userId) {
  fail(`No user found with email: ${email}`);
}

// Read the current balance first so we can report the delta and detect a missing credits row.
const { data: current, error: readError } = await supabase
  .from("user_credits")
  .select("balance")
  .eq("user_id", userId)
  .maybeSingle();

if (readError) {
  fail(`Failed to read current balance: ${readError.message}`);
}
if (!current) {
  fail(`User ${email} has no user_credits row. It should have been seeded — check the migration/trigger.`);
}

const newBalance = current.balance + amount;

const { data: updated, error: updateError } = await supabase
  .from("user_credits")
  .update({ balance: newBalance, updated_at: new Date().toISOString() })
  .eq("user_id", userId)
  .select("balance")
  .single();

if (updateError) {
  fail(`Failed to update balance: ${updateError.message}`);
}

console.log(`\n✔ Granted ${amount} credit(s) to ${email}: ${current.balance} -> ${updated.balance}`);
