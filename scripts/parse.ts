#!/usr/bin/env bun
/**
 * Parse Google Takeout -> site/data.json
 * Supports: watch-history.html and watch-history.json
 * Keeps only YouTube Music entries, cleans artist (" - Topic"), dedupes incrementally.
 *
 * Usage:
 *   bun run scripts/parse.ts                          # auto-detect takeout/ or Takeout.zip
 *   bun run scripts/parse.ts --input ./Takeout.zip
 *   bun run scripts/parse.ts --input ./takeout --no-incremental
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type RawEntry = {
  title: string;
  artist: string;
  date: string; // YYYY-MM-DD
  ts: string; // ISO 8601
  video: string;
};

type StoredEntry = RawEntry & { token: string };

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

const OUT = "site/data.json";

function unescapeHtml(s: string): string {
  return s
    .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function cleanArtist(channel: string): string {
  const c = unescapeHtml(channel).trim();
  return c.replace(/\s+-\s+Topic$/, "").trim();
}

function videoIdFromUrl(url: string): string {
  const m = url.match(/[?&]v=([\w-]{6,})/);
  return m?.[1] ?? "";
}

function tokenFor(e: RawEntry): string {
  if (e.video && e.ts) return `${e.video}|${e.ts}`;
  return `${e.title}|${e.artist}|${e.ts}`;
}

// --- HTML parser (regex, no deps) ---
function parseHtml(raw: string): RawEntry[] {
  const blocks = raw.split('<div class="outer-cell').slice(1);
  const entries: RawEntry[] = [];
  let skipped = { notMusic: 0, noWatch: 0, noChannelOrDate: 0, badDate: 0 };

  for (const b of blocks) {
    if (!b.includes('mdl-typography--title">YouTube Music<')) {
      skipped.notMusic++;
      continue;
    }
    // Watched <a href="...">Title</a><br><a href="...">Channel</a><br>Aug 24, 2026, 2:48:07 PM MSK
    const tm = b.match(/body-1">\s*Watched[\s\xa0]+<a href="([^"]+)">([^<]*)<\/a><br>([\s\S]*)/);
    if (!tm) { skipped.noWatch++; continue; }
    const url = tm[1]!, titleRaw = tm[2]!, rest = tm[3]!;
    // Channel + date line
    const cm = rest.match(/\s*<a href="[^"]*">([^<]*)<\/a><br>\s*([A-Z][a-z]{2} \d{1,2}, \d{4}), ([^<]*)</);
    if (!cm) { skipped.noChannelOrDate++; continue; }
    const channelRaw = cm[1]!, dstr = cm[2]!;
    const dm = dstr.match(/([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/);
    if (!dm) { skipped.badDate++; continue; }
    const mon = dm[1]!, day = dm[2]!, year = dm[3]!;
    const month = MONTHS[mon];
    if (!month) { skipped.badDate++; continue; }

    const title = unescapeHtml(titleRaw).trim();
    const artist = cleanArtist(channelRaw);
    const video = videoIdFromUrl(url);
    // Try to parse full timestamp from rest (e.g. "Aug 24, 2026, 2:48:07 PM MSK")
    let ts = `${year}-${month}-${String(day).padStart(2, "0")}T00:00:00`;
    const timeMatch = rest.match(/([A-Z][a-z]{2} \d{1,2}, \d{4}), (\d{1,2}:\d{2}:\d{2} [AP]M)/);
    if (timeMatch) {
      const parsed = new Date(`${timeMatch[1]} ${timeMatch[2]} UTC`);
      if (!isNaN(parsed.getTime())) ts = parsed.toISOString().replace(/\.\d+Z$/, "");
      else ts = `${year}-${month}-${String(day).padStart(2, "0")}T00:00:00`;
    }
    const date = `${year}-${month}-${String(day).padStart(2, "0")}`;

    if (!title || !artist) continue;
    entries.push({ title, artist, date, ts, video });
  }
  console.error(`HTML: parsed ${entries.length} music, skipped`, skipped);
  return entries;
}

// --- JSON parser (watch-history.json) ---
function parseJson(raw: string): RawEntry[] {
  const data = JSON.parse(raw);
  const arr: any[] = Array.isArray(data) ? data : [];
  const entries: RawEntry[] = [];
  let skipped = { notMusic: 0, noTitle: 0 };

  for (const item of arr) {
    const header: string = item.header ?? item.title ?? "";
    // In JSON format header is "YouTube Music" for music
    if (header !== "YouTube Music" && !String(header).includes("YouTube Music")) {
      skipped.notMusic++;
      continue;
    }
    const titleRaw: string = item.title ?? "";
    // title is like "Watched Yes Future!" or just "Yes Future!"
    let title = titleRaw.replace(/^Watched\s+/, "").trim();
    title = unescapeHtml(title);
    const sub = item.subtitles?.[0]?.name ?? item.subtitles?.[0] ?? "";
    const artist = cleanArtist(String(sub));
    const url: string = item.titleUrl ?? item.url ?? "";
    const video = videoIdFromUrl(url);
    const timeStr: string = item.time ?? "";
    let ts = timeStr;
    let date = "";
    if (timeStr) {
      const d = new Date(timeStr);
      if (!isNaN(d.getTime())) {
        ts = d.toISOString().replace(/\.\d+Z$/, "");
        date = ts.slice(0, 10);
      }
    }
    if (!date) {
      // fallback: try to parse from ts
      date = ts.slice(0, 10);
    }
    if (!title) { skipped.noTitle++; continue; }
    if (!artist) continue; // some entries have no artist -> skip or keep?
    entries.push({ title, artist, date, ts, video });
  }
  console.error(`JSON: parsed ${entries.length} music, skipped`, skipped);
  return entries;
}

async function findTakeoutRoot(input?: string): Promise<string | null> {
  if (input) {
    if (!existsSync(input)) {
      console.error(`Input not found: ${input}`);
      return null;
    }
    const st = statSync(input);
    if (st.isFile() && input.endsWith(".zip")) return input;
    if (st.isDirectory()) return input;
  }
  // auto-detect
  const candidates = ["takeout", "Takeout", "takeout/Takeout", "Takeout/Takeout"];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // search for Takeout.zip in cwd
  for (const f of readdirSync(".")) {
    if (f.toLowerCase().endsWith(".zip") && f.toLowerCase().includes("takeout")) return f;
  }
  return null;
}

async function extractZip(zipPath: string, dest: string): Promise<string> {
  // Use Bun's unzip via shell (unzip command exists on mac/linux runners)
  const proc = Bun.spawn(["unzip", "-o", "-q", zipPath, "-d", dest], { stdout: "inherit", stderr: "inherit" });
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`unzip failed for ${zipPath}`);
  return dest;
}

async function collectEntries(root: string): Promise<RawEntry[]> {
  // root can be zip file or directory
  let dir = root;
  let tmpDir: string | null = null;

  if (root.endsWith(".zip")) {
    tmpDir = `/tmp/ytm-takeout-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    dir = await extractZip(root, tmpDir);
  }

  // Find history files - may be nested Takeout/...
  const searchDirs = [dir, join(dir, "Takeout"), join(dir, "Takeout/YouTube and YouTube Music"), join(dir, "YouTube and YouTube Music")];
  let htmlPath: string | null = null;
  let jsonPath: string | null = null;

  for (const d of searchDirs) {
    if (!existsSync(d)) continue;
    // recursive search for watch-history.* within 3 levels
    const walk = (base: string, depth = 0): void => {
      if (depth > 4) return;
      if (!existsSync(base)) return;
      for (const ent of readdirSync(base)) {
        const p = join(base, ent);
        try {
          const s = statSync(p);
          if (s.isDirectory()) walk(p, depth + 1);
          else if (ent === "watch-history.html" && !htmlPath) htmlPath = p;
          else if (ent === "watch-history.json" && !jsonPath) jsonPath = p;
        } catch {}
      }
    };
    walk(d);
  }

  let entries: RawEntry[] = [];
  if (jsonPath && existsSync(jsonPath)) {
    console.error(`Found JSON: ${jsonPath}`);
    const raw = await Bun.file(jsonPath).text();
    entries = parseJson(raw);
  } else if (htmlPath && existsSync(htmlPath)) {
    console.error(`Found HTML: ${htmlPath}`);
    const raw = await Bun.file(htmlPath).text();
    entries = parseHtml(raw);
  } else {
    console.error(`No watch-history.html/json found under ${dir}`);
    if (tmpDir) console.error(`Searched in tmp ${tmpDir}`);
    throw new Error("watch-history not found");
  }

  if (tmpDir) {
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  }
  return entries;
}

async function main() {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf("--input");
  const input = inputIdx !== -1 ? args[inputIdx + 1] : undefined;
  const noIncremental = args.includes("--no-incremental");

  const root = await findTakeoutRoot(input);
  if (!root) {
    console.error("No takeout found. Provide --input <path to Takeout.zip or takeout dir>");
    console.error("Expected: takeout/Takeout/YouTube and YouTube Music/history/watch-history.*");
    process.exit(1);
  }
  console.error(`Using source: ${root}`);

  const newEntries = await collectEntries(root);
  if (!newEntries.length) {
    console.error("Nothing parsed!");
    process.exit(1);
  }

  // Load existing
  let existing: StoredEntry[] = [];
  if (!noIncremental && existsSync(OUT)) {
    try {
      const raw = await Bun.file(OUT).text();
      const parsed = JSON.parse(raw);
      // migrate old format: {channel, m} -> {artist}
      existing = parsed.map((e: any) => {
        if (e.artist) return e as StoredEntry;
        // old format with channel/m
        const artist = e.artist ?? cleanArtist(e.channel ?? "");
        return {
          title: e.title,
          artist,
          date: e.date,
          ts: e.ts ?? `${e.date}T00:00:00`,
          video: e.video ?? "",
          token: e.token ?? `${e.video ?? ""}|${e.ts ?? e.date}`,
        } as StoredEntry;
      }).filter((e: StoredEntry) => e.artist && e.title);
      // filter out non-music if old had m field
      const before = existing.length;
      const hasM = parsed.some((e: any) => "m" in e);
      if (hasM) {
        existing = existing.filter((_, i) => parsed[i].m === 1 || parsed[i].m === true);
        console.error(`Migrated ${before} -> ${existing.length} (filtered m==1)`);
      }
    } catch (e) {
      console.warn(`Failed to load existing ${OUT}:`, e);
      existing = [];
    }
  }

  // Dedup by normalized token (video|ts)
  const seen = new Set(existing.map(e => tokenFor(e)));
  // also add raw tokens for safety
  for (const e of existing) if (e.token) seen.add(e.token);
  let added = 0;
  for (const e of newEntries) {
    const token = tokenFor(e);
    if (seen.has(token)) continue;
    // also check if exact title+artist+ts already exists (old token format compat)
    const altKey = `${e.title}|${e.artist}|${e.ts}`;
    if (seen.has(altKey)) continue;
    // check existing entries by same video+ts alternative (old token was video|millis)
    const existsSame = existing.some(ex => ex.video === e.video && ex.ts === e.ts);
    if (existsSame) continue;
    seen.add(token);
    seen.add(altKey);
    existing.push({ ...e, token });
    added++;
  }

  // Also dedup by token duplicates within newEntries already handled via seen
  existing.sort((a, b) => a.ts.localeCompare(b.ts));

  // Ensure token field for all
  for (const e of existing) {
    if (!e.token) (e as any).token = tokenFor(e);
  }

  await Bun.write(OUT, JSON.stringify(existing, null, 2));
  console.error(`\nDone: ${newEntries.length} parsed, ${added} new, total ${existing.length}`);
  console.error(`Wrote ${OUT} (${(Bun.file(OUT).size / 1024).toFixed(0)} KB)`);

  const byYear: Record<string, number> = {};
  for (const e of existing) {
    const y = e.date.slice(0, 4);
    byYear[y] = (byYear[y] ?? 0) + 1;
  }
  console.error("by year:", byYear);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
