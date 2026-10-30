#!/usr/bin/env bun
/**
 * Fetch watch-history from the latest Google Takeout export on Drive (or a direct URL)
 * and extract it into takeout/. Multi-part exports (takeout-...-001.zip, -002.zip) are
 * downloaded one part at a time until watch-history is found.
 *
 * Requires env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 * Optionally: TAKEOUT_URL (direct link), DRIVE_FOLDER_ID, FORCE=1 (re-process last export)
 * In GitHub Actions writes `skip=true|false` to $GITHUB_OUTPUT.
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... bun run scripts/fetch.ts
 *   TAKEOUT_URL=https://storage.googleapis.com/... bun run scripts/fetch.ts
 */

import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { extractHistory } from "./unzip.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const OUT_DIR = "takeout";
const DOWNLOAD_DIR = "takeout-dl";
const MARKER = "site/.last-takeout-id";

type DriveFile = { id: string; name: string; mimeType: string; createdTime: string; size?: string; parents?: string[] };
type TakeoutExport = { key: string; createdTime: string; parts: DriveFile[] };

async function setOutput(name: string, value: string): Promise<void> {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function refreshAccessToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN env (or pass TAKEOUT_URL)");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token refresh failed ${res.status}: ${txt}`);
  }
  const data = (await res.json()) as { access_token: string };
  if (!data.access_token) throw new Error("No access_token in response");
  return data.access_token;
}

// No mimeType filter: Drive labels Takeout zips inconsistently (application/zip, application/x-zip-compressed, ...)
async function listTakeoutFiles(accessToken: string, folderId?: string): Promise<DriveFile[]> {
  let q = "name contains 'takeout' and trashed = false";
  if (folderId) q += ` and '${folderId}' in parents`;
  const params = new URLSearchParams({
    q,
    orderBy: "createdTime desc",
    pageSize: "100",
    fields: "files(id,name,mimeType,createdTime,size,parents)",
    spaces: "drive",
  });

  const res = await fetch(`${DRIVE_FILES_URL}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive list failed ${res.status}: ${txt}`);
  }
  const data = (await res.json()) as { files?: DriveFile[] };
  return data.files ?? [];
}

/** Group files by export ("takeout-20261027T154352Z-001.zip", "takeout-20261027T154352Z-1-001.zip" -> "takeout-20261027T154352Z"), newest first. */
export function groupExports(files: DriveFile[]): TakeoutExport[] {
  const byKey = new Map<string, TakeoutExport>();
  for (const f of files) {
    if (!/\.zip$/i.test(f.name)) continue;
    const key = f.name.replace(/(-\d+)*\.zip$/i, "");
    const exp = byKey.get(key) ?? { key, createdTime: f.createdTime, parts: [] };
    exp.parts.push(f);
    if (f.createdTime > exp.createdTime) exp.createdTime = f.createdTime;
    byKey.set(key, exp);
  }
  const exports = [...byKey.values()];
  for (const e of exports) e.parts.sort((a, b) => a.name.localeCompare(b.name));
  return exports.sort((a, b) => b.createdTime.localeCompare(a.createdTime));
}

async function download(url: string, dest: string, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Download failed ${res.status}: ${txt.slice(0, 500)}`);
  }
  const bytes = await Bun.write(dest, res); // streams to disk, parts can be up to 50 GB
  console.error(`Downloaded ${(bytes / 1024 / 1024).toFixed(1)} MB to ${dest}`);
}

/** Download a zip, keep only watch-history from it, delete the zip. */
async function fetchHistory(url: string, name: string, headers?: Record<string, string>): Promise<boolean> {
  const zip = join(DOWNLOAD_DIR, name);
  await download(url, zip, headers);
  try {
    if (await extractHistory(zip, OUT_DIR)) return true;
    console.error(`No watch-history in ${name}, it contains:`);
    console.error((await Bun.$`unzip -l ${zip}`.nothrow().text()).split("\n").slice(0, 40).join("\n"));
    return false;
  } finally {
    await rm(zip, { force: true });
  }
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(DOWNLOAD_DIR, { recursive: true });

  const directUrl = process.env.TAKEOUT_URL;
  if (directUrl) {
    console.error(`Downloading direct URL: ${directUrl.slice(0, 80)}...`);
    if (!(await fetchHistory(directUrl, "takeout.zip"))) throw new Error("No watch-history in the downloaded zip");
    await setOutput("skip", "false");
    return;
  }

  console.error("Refreshing access token...");
  const token = await refreshAccessToken();
  const folderId = process.env.DRIVE_FOLDER_ID || undefined;

  console.error(`Searching Drive for takeout zips${folderId ? " in DRIVE_FOLDER_ID" : ""}...`);
  let files = await listTakeoutFiles(token, folderId);
  if (folderId && !groupExports(files).length) {
    console.error("::warning::No takeout zips in DRIVE_FOLDER_ID — check the secret. Searching the whole Drive instead.");
    files = await listTakeoutFiles(token);
  }

  const exports = groupExports(files);
  console.error("Exports on Drive:");
  for (const e of exports.slice(0, 10)) {
    const mb = e.parts.reduce((s, p) => s + Number(p.size ?? 0), 0) / 1024 / 1024;
    console.error(`  ${e.key}  ${e.parts.length} part(s)  ${mb.toFixed(1)} MB  created ${e.createdTime}`);
  }
  const latest = exports[0];
  if (!latest) {
    console.error("No takeout zip found in Drive. Files with 'takeout' in the name:");
    for (const f of files.slice(0, 20)) console.error(`  ${f.name}  [${f.mimeType}]  parents=${f.parents?.join(",")}`);
    if (!files.length) console.error("  (none) — is Takeout set to 'Add to Drive'?");
    process.exit(1);
  }
  const totalMb = latest.parts.reduce((s, p) => s + Number(p.size ?? 0), 0) / 1024 / 1024;
  console.error(`Latest export: ${latest.key} (${latest.parts.length} part(s), ${totalMb.toFixed(0)} MB, created ${latest.createdTime})`);

  const lastKey = (await Bun.file(MARKER).exists()) ? (await Bun.file(MARKER).text()).trim() : "";
  if (lastKey === latest.key && !process.env.FORCE) {
    console.error("Already ingested this export, nothing to do.");
    await setOutput("skip", "true");
    return;
  }

  // watch-history lives in exactly one part; stop as soon as it shows up
  for (const part of latest.parts) {
    console.error(`Fetching ${part.name}...`);
    const found = await fetchHistory(`${DRIVE_FILES_URL}/${part.id}?alt=media`, part.name, {
      Authorization: `Bearer ${token}`,
    });
    if (found) {
      await Bun.write(MARKER, latest.key + "\n");
      await setOutput("skip", "false");
      return;
    }
  }
  throw new Error(
    `watch-history not found in ${latest.parts.length} part(s) of ${latest.key}. ` +
      "In Takeout make sure 'YouTube and YouTube Music' -> 'history' is included.",
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
