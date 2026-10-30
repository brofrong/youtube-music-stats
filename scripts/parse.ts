#!/usr/bin/env bun
/**
 * Parse Google Takeout -> site/data.json
 * Supports: watch-history.html and watch-history.json
 * Keeps only YouTube Music entries, cleans artist (" - Topic"), dedupes incrementally.
 * All timestamps are stored in UTC (`ts` without "Z", `date` = UTC date).
 *
 * Usage:
 *   bun run scripts/parse.ts                          # auto-detect takeout/ or Takeout.zip
 *   bun run scripts/parse.ts --input ./Takeout.zip
 *   bun run scripts/parse.ts --input ./takeout --no-incremental
 *   bun run scripts/parse.ts --force                  # skip the overlap sanity check
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractHistory } from "./unzip.ts";

export type Entry = {
  title: string;
  artist: string;
  date: string; // YYYY-MM-DD (UTC)
  ts: string; // YYYY-MM-DDTHH:MM:SS (UTC)
  video: string;
};

const MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

// Timezone abbreviations Takeout prints in watch-history.html -> UTC offset in minutes
const TZ_ABBR: Record<string, number> = {
  UTC: 0, GMT: 0, WET: 0, WEST: 60, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180,
  MSK: 180, SAMT: 240, YEKT: 300, OMST: 360, KRAT: 420, IRKT: 480, YAKT: 540, VLAT: 600,
  MAGT: 660, PETT: 720, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360,
  PST: -480, PDT: -420,
};

const OUT = "site/data.json";

// Below this share of matching listens in the overlapping period we assume the timestamps
// are shifted (timezone bug) and refuse to write, otherwise the whole history would double.
const MIN_OVERLAP_MATCH = 0.2;
const MIN_OVERLAP_SAMPLE = 100;

function unescapeHtml(s: string): string {
  return s
    .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, "\xa0")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function cleanArtist(channel: string): string {
  const c = unescapeHtml(channel).trim();
  return c.replace(/\s+-\s+Topic$/, "").trim();
}

function videoIdFromUrl(url: string): string {
  const m = url.match(/[?&]v=([\w-]{6,})/);
  return m?.[1] ?? "";
}

function toUtcTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

export function tokenFor(e: Entry): string {
  if (e.video && e.ts) return `${e.video}|${e.ts}`;
  return `${e.title}|${e.artist}|${e.ts}`;
}

/** "MSK" -> 180, "GMT+03:00" -> 180, "UTC-5" -> -300; null if unknown */
export function tzOffsetMinutes(tz: string): number | null {
  const m = tz.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (m) return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  return TZ_ABBR[tz] ?? null;
}

/** "Aug 24, 2026, 2:48:07 PM MSK" -> "2026-08-24T11:48:07" */
export function parseHtmlTime(s: string): string | null {
  const m = s.match(
    /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}),[\s ]+(\d{1,2}):(\d{2}):(\d{2})(?:[\s ]*([AP]M))?[\s ]+([A-Za-z]+(?:[+-]\d{1,2}(?::?\d{2})?)?)/,
  );
  if (!m) return null;
  const month = MONTHS[m[1]!];
  if (!month) return null;
  const offset = tzOffsetMinutes(m[8]!);
  if (offset === null) throw new Error(`Unknown timezone "${m[8]}" in "${s.trim()}" — add it to TZ_ABBR in scripts/parse.ts`);
  let hour = Number(m[4]) % 12;
  if (!m[7]) hour = Number(m[4]); // 24h clock
  else if (m[7] === "PM") hour += 12;
  const local = Date.UTC(Number(m[3]), month - 1, Number(m[2]), hour, Number(m[5]), Number(m[6]));
  return toUtcTs(local - offset * 60_000);
}

// --- HTML parser (regex, no deps) ---
export function parseHtml(raw: string): Entry[] {
  const blocks = raw.split('<div class="outer-cell').slice(1);
  const entries: Entry[] = [];
  const skipped = { notMusic: 0, noWatch: 0, noChannelOrDate: 0, badDate: 0 };

  for (const b of blocks) {
    if (!b.includes('mdl-typography--title">YouTube Music<')) {
      skipped.notMusic++;
      continue;
    }
    // Watched <a href="...">Title</a><br><a href="...">Channel</a><br>Aug 24, 2026, 2:48:07 PM MSK
    const tm = b.match(/body-1">\s*Watched(?:[\s\xa0]|&nbsp;)+<a href="([^"]+)">([^<]*)<\/a><br>([\s\S]*)/);
    if (!tm) { skipped.noWatch++; continue; }
    const url = tm[1]!, titleRaw = tm[2]!, rest = tm[3]!;
    const cm = rest.match(/^\s*<a href="[^"]*">([^<]*)<\/a><br>([^<]*)</);
    if (!cm) { skipped.noChannelOrDate++; continue; }
    const ts = parseHtmlTime(cm[2]!);
    if (!ts) { skipped.badDate++; continue; }

    const title = unescapeHtml(titleRaw).trim();
    const artist = cleanArtist(cm[1]!);
    if (!title || !artist) continue;
    entries.push({ title, artist, date: ts.slice(0, 10), ts, video: videoIdFromUrl(unescapeHtml(url)) });
  }
  console.error(`HTML: parsed ${entries.length} music, skipped`, skipped);
  return entries;
}

// --- JSON parser (watch-history.json) ---
export function parseJson(raw: string): Entry[] {
  const data = JSON.parse(raw);
  const arr: any[] = Array.isArray(data) ? data : [];
  const entries: Entry[] = [];
  const skipped = { notMusic: 0, noTitle: 0, badDate: 0 };

  for (const item of arr) {
    if (item.header !== "YouTube Music") {
      skipped.notMusic++;
      continue;
    }
    // title is like "Watched Yes Future!"
    const title = unescapeHtml(String(item.title ?? "").replace(/^Watched\s+/, "")).trim();
    if (!title) { skipped.noTitle++; continue; }
    const sub = item.subtitles?.[0];
    const artist = cleanArtist(String(sub?.name ?? sub ?? ""));
    if (!artist) continue;
    const ms = Date.parse(item.time ?? "");
    if (isNaN(ms)) { skipped.badDate++; continue; }
    const ts = toUtcTs(ms);
    entries.push({ title, artist, date: ts.slice(0, 10), ts, video: videoIdFromUrl(item.titleUrl ?? "") });
  }
  console.error(`JSON: parsed ${entries.length} music, skipped`, skipped);
  return entries;
}

/** Share of incoming listens inside the existing period that are already known. */
export function overlap(existing: Entry[], incoming: Entry[]): { inRange: number; matched: number } {
  if (!existing.length) return { inRange: 0, matched: 0 };
  let min = existing[0]!.ts, max = min;
  for (const e of existing) {
    if (e.ts < min) min = e.ts;
    if (e.ts > max) max = e.ts;
  }
  const known = new Set(existing.map(tokenFor));
  let inRange = 0, matched = 0;
  for (const e of incoming) {
    if (e.ts < min || e.ts > max) continue;
    inRange++;
    if (known.has(tokenFor(e))) matched++;
  }
  return { inRange, matched };
}

export function merge(existing: Entry[], incoming: Entry[]): { entries: Entry[]; added: number } {
  const seen = new Set(existing.map(tokenFor));
  const entries = [...existing];
  let added = 0;
  for (const e of incoming) {
    const token = tokenFor(e);
    if (seen.has(token)) continue;
    seen.add(token);
    entries.push(e);
    added++;
  }
  entries.sort((a, b) => a.ts.localeCompare(b.ts));
  return { entries, added };
}

function findTakeoutRoot(input?: string): string | null {
  if (input) {
    if (!existsSync(input)) {
      console.error(`Input not found: ${input}`);
      return null;
    }
    return input;
  }
  for (const c of ["takeout", "Takeout"]) {
    if (existsSync(c)) return c;
  }
  for (const f of readdirSync(".")) {
    if (f.toLowerCase().endsWith(".zip") && f.toLowerCase().includes("takeout")) return f;
  }
  return null;
}

function findHistoryFile(dir: string, name: string, depth = 0): string | null {
  if (depth > 6) return null;
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    if (ent === name) return p;
    if (statSync(p).isDirectory()) {
      const found = findHistoryFile(p, name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function collectEntries(root: string): Promise<Entry[]> {
  let dir = root;
  let tmpDir: string | null = null;

  if (statSync(root).isFile()) {
    tmpDir = `/tmp/ytm-takeout-${Date.now()}`;
    if (!(await extractHistory(root, tmpDir))) throw new Error(`No watch-history in ${root}`);
    dir = tmpDir;
  }

  try {
    const jsonPath = findHistoryFile(dir, "watch-history.json");
    if (jsonPath) {
      console.error(`Found JSON: ${jsonPath}`);
      return parseJson(await Bun.file(jsonPath).text());
    }
    const htmlPath = findHistoryFile(dir, "watch-history.html");
    if (htmlPath) {
      console.error(`Found HTML: ${htmlPath}`);
      return parseHtml(await Bun.file(htmlPath).text());
    }
    throw new Error(`No watch-history.html/json found under ${dir}`);
  } finally {
    if (tmpDir) await Bun.$`rm -rf ${tmpDir}`.quiet();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf("--input");
  const input = inputIdx !== -1 ? args[inputIdx + 1] : undefined;
  const noIncremental = args.includes("--no-incremental");
  const force = args.includes("--force");

  const root = findTakeoutRoot(input);
  if (!root) {
    console.error("No takeout found. Provide --input <path to Takeout.zip or takeout dir>");
    console.error("Expected: takeout/Takeout/YouTube and YouTube Music/history/watch-history.*");
    process.exit(1);
  }
  console.error(`Using source: ${root}`);

  const incoming = await collectEntries(root);
  if (!incoming.length) {
    console.error("Nothing parsed!");
    process.exit(1);
  }

  let existing: Entry[] = [];
  if (!noIncremental && existsSync(OUT)) {
    const stored: Entry[] = await Bun.file(OUT).json();
    existing = stored.map(({ title, artist, date, ts, video }) => ({ title, artist, date, ts, video }));
  }

  const { inRange, matched } = overlap(existing, incoming);
  console.error(`Overlap with existing data: ${matched}/${inRange} listens match`);
  if (inRange >= MIN_OVERLAP_SAMPLE && matched / inRange < MIN_OVERLAP_MATCH && !force) {
    console.error(
      `Only ${((matched / inRange) * 100).toFixed(1)}% of listens in the already known period match existing data. ` +
        "Timestamps are probably shifted (timezone?) — refusing to write to avoid duplicating history. Use --force to override.",
    );
    process.exit(1);
  }

  const { entries, added } = merge(existing, incoming);
  await Bun.write(OUT, JSON.stringify(entries));
  console.error(`\nDone: ${incoming.length} parsed, ${added} new, total ${entries.length}`);
  console.error(`Wrote ${OUT} (${(Bun.file(OUT).size / 1024).toFixed(0)} KB)`);

  const byYear: Record<string, number> = {};
  for (const e of entries) {
    const y = e.date.slice(0, 4);
    byYear[y] = (byYear[y] ?? 0) + 1;
  }
  console.error("by year:", byYear);
}

if (import.meta.main) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
