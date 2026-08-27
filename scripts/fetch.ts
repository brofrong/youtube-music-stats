#!/usr/bin/env bun
/**
 * Fetch latest Takeout zip from Google Drive (variant A)
 * Requires env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 * Optionally: TAKEOUT_URL (direct link) or DRIVE_FOLDER_ID
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... bun run scripts/fetch.ts
 *   TAKEOUT_URL=https://storage.googleapis.com/... bun run scripts/fetch.ts
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_DOWNLOAD_URL = "https://www.googleapis.com/drive/v3/files";

async function refreshAccessToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN env");
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

async function findLatestTakeout(accessToken: string): Promise<{ id: string; name: string; createdTime: string } | null> {
  const folderId = process.env.DRIVE_FOLDER_ID;
  // Search for zip files with takeout in name. Takeout creates files like "takeout-20250827T...zip"
  let q = "mimeType='application/zip' and name contains 'takeout'";
  if (folderId) q += ` and '${folderId}' in parents`;
  // Also consider "application/x-zip-compressed"
  const params = new URLSearchParams({
    q,
    orderBy: "createdTime desc",
    pageSize: "10",
    fields: "files(id,name,createdTime,modifiedTime,size)",
    spaces: "drive",
  });

  const res = await fetch(`${DRIVE_FILES_URL}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive list failed ${res.status}: ${txt}`);
  }
  const data = (await res.json()) as { files: Array<{ id: string; name: string; createdTime: string }> };
  if (!data.files?.length) return null;
  return data.files[0] ?? null;
}

async function downloadFromDrive(accessToken: string, fileId: string, dest: string): Promise<void> {
  const res = await fetch(`${DRIVE_DOWNLOAD_URL}/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive download failed ${res.status}: ${txt.slice(0, 500)}`);
  }
  const buf = await res.arrayBuffer();
  await Bun.write(dest, buf);
  console.error(`Downloaded ${buf.byteLength} bytes to ${dest}`);
}

async function downloadFromUrl(url: string, dest: string): Promise<void> {
  console.error(`Downloading direct URL: ${url.slice(0, 80)}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`URL download failed ${res.status}`);
  const buf = await res.arrayBuffer();
  await Bun.write(dest, buf);
  console.error(`Downloaded ${buf.byteLength} bytes to ${dest}`);
}

async function main() {
  const directUrl = process.env.TAKEOUT_URL;

  const dest = process.env.TAKEOUT_ZIP ?? "Takeout.zip";

  if (directUrl) {
    await downloadFromUrl(directUrl, dest);
    console.log(dest);
    return;
  }

  console.error("Refreshing access token...");
  const token = await refreshAccessToken();
  console.error("Searching Drive for takeout zip...");
  const file = await findLatestTakeout(token);
  if (!file) {
    console.error("No takeout zip found in Drive. Check:");
    console.error(" - Takeout export is set to 'Add to Drive' (takeout.google.com)");
    console.error(" - File name contains 'takeout' and mime is application/zip");
    console.error(" - DRIVE_FOLDER_ID if using custom folder (current:", process.env.DRIVE_FOLDER_ID ?? "(none)", ")");
    process.exit(1);
  }
  console.error(`Found: ${file.name} (${file.id}) created ${file.createdTime}`);

  // Check if we already have this file (avoid re-download)
  const marker = "site/.last-takeout-id";
  try {
    const lastId = (await Bun.file(marker).text()).trim();
    if (lastId === file.id) {
      console.error("Same file as last run, skipping download.");
      process.exit(0);
    }
  } catch {}

  await downloadFromDrive(token, file.id, dest);
  await Bun.write(marker, file.id);
  console.log(dest);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
