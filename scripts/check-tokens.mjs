// Sweep-completeness guard (S-09 / app-design-system phase 9).
//
// This repo has no test suite, so this grep-shaped scan is the only mechanical proof that the
// design-system sweep (phases 1-8) stays regression-free for EXACTLY the three utility-class
// syntaxes below: a named Tailwind palette utility, a `white`/`black` utility, or an arbitrary hex
// value in class position — each restricted to the `UTILITY_PREFIXES` families. It does not — and by
// its grep-shaped design cannot — prove every colour in the tree is tokenized: raw CSS/inline style
// declarations, non-hex arbitrary colours (`bg-[rgb(...)]`, `bg-[oklch(...)]`), and Tailwind colour
// families outside `UTILITY_PREFIXES` (`divide-*`, `outline-*`, `accent-*`, …) all pass through
// undetected. Widen `UTILITY_PREFIXES`/`PATTERNS` deliberately if one of those becomes a real risk;
// don't read a clean run here as proof of the broader claim.
//
// `src/styles/global.css` is the sole exemption — it is where the 3b palette is SUPPOSED to live,
// as CSS custom properties. Wired into `npm run lint:tokens` and into CI, after `npm run lint`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = join(ROOT, "src");
const EXTENSIONS = new Set([".ts", ".tsx", ".astro", ".css"]);
const EXEMPT_FILE = join(SRC_DIR, "styles", "global.css");

// Tailwind's default named palette (v4). Deliberately excludes `white`/`black`/`transparent`/
// `current`, which take no numeric step and are covered by the second pattern instead.
const TAILWIND_HUES = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];

// The utility families a colour can be hardcoded through. `ring`/`fill`/`stroke` are included even
// though this app uses them sparingly, because the guard's job is to catch a REGRESSION, not just
// the shapes already known to exist.
const UTILITY_PREFIXES = ["bg", "text", "border", "from", "via", "to", "ring", "fill", "stroke"];

const PATTERNS = [
  {
    name: "named Tailwind palette utility",
    regex: new RegExp(
      `\\b(?:${UTILITY_PREFIXES.join("|")})-(?:${TAILWIND_HUES.join("|")})-\\d{2,3}(?:\\/\\d{1,3})?\\b`,
      "g",
    ),
  },
  {
    name: "white/black colour utility",
    regex: new RegExp(`\\b(?:${UTILITY_PREFIXES.join("|")})-(?:white|black)(?:\\/\\d{1,3})?\\b`, "g"),
  },
  {
    name: "arbitrary hex value in class position",
    regex: new RegExp(`\\b(?:${UTILITY_PREFIXES.join("|")})-\\[#[0-9a-fA-F]{3,8}\\]`, "g"),
  },
];

// Fixtures locking down what the three families above actually catch and, just as importantly,
// what they deliberately do not (the header comment's scope note). `hit: true` lines must match
// exactly one pattern; `hit: false` lines are the boundary cases a looser regex would wrongly flag,
// or the out-of-scope syntaxes a future reader might assume are covered.
const FIXTURES = [
  { line: "bg-purple-600", hit: true },
  { line: "text-red-500/50", hit: true },
  { line: "border-white", hit: true },
  { line: "ring-black/20", hit: true },
  { line: "bg-[#fff]", hit: true },
  { line: "bg-[#a1b2c3ff]", hit: true },
  // In scope, but not a violation on its own — a real file line is checked as-is, and `bg-primary`
  // must never match a hue/family it merely starts with.
  { line: "bg-primary", hit: false },
  { line: "text-foreground", hit: false },
  // Out of scope by design: non-hex arbitrary colours and Tailwind families outside
  // `UTILITY_PREFIXES` pass through undetected, per the header comment's scope note.
  { line: "bg-[rgb(0,0,0)]", hit: false },
  { line: "bg-[oklch(0.5_0_0)]", hit: false },
  { line: "divide-red-500", hit: false },
  { line: "outline-white", hit: false },
  { line: "accent-blue-500", hit: false },
  // Out of scope: a raw CSS/inline declaration, not a Tailwind utility class.
  { line: "color: #ffffff;", hit: false },
];

function selfCheck() {
  const failures = [];
  for (const { line, hit } of FIXTURES) {
    const matched = PATTERNS.some(({ regex }) => {
      regex.lastIndex = 0;
      return regex.test(line);
    });
    if (matched !== hit) {
      failures.push(`"${line}": expected hit=${hit}, got hit=${matched}`);
    }
  }
  if (failures.length > 0) {
    console.error("✖ check-tokens.mjs fixture self-check failed — the patterns drifted from their documented scope:");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
}

selfCheck();

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
    } else if (EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) {
      files.push(full);
    }
  }
  return files;
}

const files = walk(SRC_DIR).filter((file) => file !== EXEMPT_FILE);

let hits = 0;
for (const file of files) {
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    for (const { name, regex } of PATTERNS) {
      regex.lastIndex = 0;
      let match = regex.exec(line);
      while (match !== null) {
        hits += 1;
        const path = relative(ROOT, file).split(sep).join("/");
        console.error(`${path}:${index + 1}: ${match[0]} (${name})`);
        match = regex.exec(line);
      }
    }
  });
}

if (hits > 0) {
  console.error(`\n✖ ${hits} hardcoded palette utilit${hits === 1 ? "y" : "ies"} found outside src/styles/global.css.`);
  process.exit(1);
}

console.log("✔ No hardcoded palette utilities found outside src/styles/global.css.");
