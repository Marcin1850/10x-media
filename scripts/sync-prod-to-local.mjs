// Sync production data (including auth users) into the local Supabase stack.
//
// The schema is owned by the local migrations, so this pulls DATA ONLY:
//   - auth.users (accounts + hashed passwords -> real prod logins work locally)
//   - public.videos / public.summaries (and any future data tables)
//
// Usage:
//   npm run db:sync-from-prod            # assumes you already ran `supabase db reset`
//   npm run db:sync-from-prod -- --reset # run `supabase db reset` first
//   npm run db:sync-from-prod -- --yes   # skip the PII confirmation prompt
//
// Prod source (pick one):
//   - default: the linked project (`npx supabase link` beforehand)
//   - PROD_DB_URL=<session-pooler-connection-string>  (non-interactive / CI)
//
// Safety: the restore target is the local `supabase_db_*` Docker container only.
// The dump is written to the OS temp dir and deleted on exit (it contains PII).

import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);

const dumpFile = join(tmpdir(), `10xmedia_prod_data_${Date.now()}.sql`);

// Windows can't spawn `.cmd` shims (e.g. npx.cmd) without a shell (Node EINVAL),
// so route those through the shell and quote any args that contain spaces.
const quoteArg = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function run(cmd, cmdArgs, opts = {}) {
  const useShell = process.platform === "win32" && cmd.toLowerCase().endsWith(".cmd");
  const finalArgs = useShell ? cmdArgs.map(quoteArg) : cmdArgs;
  const res = spawnSync(cmd, finalArgs, { stdio: "inherit", shell: useShell, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`\`${cmd} ${cmdArgs.join(" ")}\` exited with code ${res.status}`);
  }
  return res;
}

// Find the running local Supabase Postgres container (project-agnostic).
function findLocalDbContainer() {
  const res = spawnSync("docker", ["ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  if (res.error) {
    throw new Error("Could not run `docker` — is Docker Desktop running?");
  }
  const name = (res.stdout || "").trim().split(/\r?\n/).filter(Boolean)[0];
  if (!name) {
    throw new Error("No running `supabase_db_*` container found. Start the local stack first: `npx supabase start`");
  }
  return name;
}

async function confirmPii() {
  if (flag("--yes") || !stdin.isTTY) return;
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    "This copies REAL user data (emails + password hashes) from prod to your local DB.\nContinue? [y/N] ",
  );
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("Aborted.");
    process.exit(1);
  }
}

// Stream the dump file into `docker exec -i <container> psql` over stdin.
function restore(container) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "--single-transaction",
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`psql restore exited with code ${code}`))));
    createReadStream(dumpFile).pipe(child.stdin);
  });
}

async function main() {
  const container = findLocalDbContainer();
  await confirmPii();

  if (flag("--reset")) {
    console.log("\n> Resetting local DB (replaying migrations)...");
    run(npx, ["supabase", "db", "reset"]);
  }

  console.log("\n> Dumping data from prod...");
  // Scope to auth + public only. We keep just auth.users + auth.identities
  // (enough for password logins) and exclude every other, version-drifting
  // internal auth table so the restore doesn't break across CLI/prod versions.
  const AUTH_INTERNAL_EXCLUDES = [
    "auth.audit_log_entries",
    "auth.flow_state",
    "auth.instances",
    "auth.mfa_amr_claims",
    "auth.mfa_challenges",
    "auth.mfa_factors",
    "auth.one_time_tokens",
    "auth.refresh_tokens",
    "auth.saml_providers",
    "auth.saml_relay_states",
    "auth.schema_migrations",
    "auth.sessions",
    "auth.sso_domains",
    "auth.sso_providers",
    "auth.custom_oauth_providers",
    "auth.oauth_clients",
    "auth.oauth_authorizations",
  ];
  const dumpArgs = [
    "supabase",
    "db",
    "dump",
    "--data-only",
    "--use-copy",
    "--schema",
    "auth,public",
    "-f",
    dumpFile,
    ...AUTH_INTERNAL_EXCLUDES.flatMap((t) => ["-x", t]),
  ];
  if (process.env.PROD_DB_URL) {
    dumpArgs.push("--db-url", process.env.PROD_DB_URL);
  } else {
    dumpArgs.push("--linked");
  }
  run(npx, dumpArgs);

  console.log(`\n> Restoring into local container "${container}"...`);
  await restore(container);

  console.log("\n✔ Done. Verifying row counts:");
  run("docker", [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-c",
    "select 'auth.users' as tbl, count(*) from auth.users " +
      "union all select 'public.videos', count(*) from public.videos " +
      "union all select 'public.summaries', count(*) from public.summaries;",
  ]);
}

main()
  .catch((err) => {
    console.error(`\n✖ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await rm(dumpFile, { force: true });
  });
