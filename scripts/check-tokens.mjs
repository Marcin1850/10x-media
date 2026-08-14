// Sweep-completeness guard (S-09 / app-design-system phase 9).
//
// This repo has no test suite, so this grep-shaped scan is the only mechanical proof that the
// design-system sweep (phases 1-8) is complete and stays that way: every colour must come from a
// token in `src/styles/global.css`, never from a hardcoded Tailwind palette utility, a `white`/
// `black` utility, or an arbitrary hex value in class position.
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
