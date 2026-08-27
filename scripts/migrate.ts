#!/usr/bin/env bun
/** One-off migration for old site/data.json with {channel, m} -> {artist, token} and filter music only */
import { existsSync } from "node:fs";

const IN = "site/data.json";

function cleanArtist(s: string): string {
  return s.replace(/\s+-\s+Topic$/, "").trim();
}

const raw = await Bun.file(IN).text();
const data: any[] = JSON.parse(raw);
console.error(`Before: ${data.length}`);

let migrated = data
  .filter((e) => {
    // keep only music if m field exists
    if ("m" in e) return e.m === 1 || e.m === true;
    return true;
  })
  .map((e) => {
    const artist = e.artist ?? cleanArtist(e.channel ?? "");
    const ts: string = e.ts ?? `${e.date}T00:00:00`;
    const video: string = e.video ?? "";
    const token: string = video ? `${video}|${ts}` : `${e.title}|${artist}|${ts}`;
    return { title: e.title, artist, date: e.date, ts, video, token };
  })
  .filter((e) => e.artist && e.title);

console.error(`After filter: ${migrated.length}`);

// dedup by token
const seen = new Set<string>();
const deduped: typeof migrated = [];
for (const e of migrated) {
  if (seen.has(e.token)) continue;
  seen.add(e.token);
  deduped.push(e);
}
console.error(`After dedup: ${deduped.length}`);
deduped.sort((a, b) => a.ts.localeCompare(b.ts));

await Bun.write(IN, JSON.stringify(deduped, null, 2));
console.error(`Wrote ${IN}`);
