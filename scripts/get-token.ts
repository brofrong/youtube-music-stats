#!/usr/bin/env bun
/**
 * Helper to obtain GOOGLE_REFRESH_TOKEN for Drive read-only access.
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... bun run scripts/get-token.ts
 * Then open printed URL, authorize, and refresh_token will be printed.
 */

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = Number(process.env.PORT ?? 3000);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env first.");
  console.error("Create OAuth client at https://console.cloud.google.com/apis/credentials -> Create Credentials -> OAuth client ID -> Web application");
  console.error("Add Authorized redirect URI: http://localhost:3000/callback");
  process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPE);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log("\n1) Open this URL in browser:\n");
console.log(authUrl.toString());
console.log(`\n2) Waiting for callback on ${REDIRECT_URI} ...\n`);

let server: ReturnType<typeof Bun.serve> | null = null;

server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        return new Response(`Error: ${error}. Check console.`, { status: 400 });
      }
      if (!code) {
        return new Response("Missing code", { status: 400 });
      }

      // Exchange code for tokens
      try {
        const res = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: "authorization_code",
          }),
        });
        const data = (await res.json()) as any;
        if (!res.ok) {
          console.error("Token exchange failed:", data);
          return new Response(`<pre>${JSON.stringify(data, null, 2)}</pre>`, {
            headers: { "Content-Type": "text/html" },
          });
        }

        console.log("\n=== SUCCESS ===\n");
        console.log("Add to GitHub Secrets and local .env:");
        console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`);
        console.log(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}`);
        console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}`);
        if (!data.refresh_token) {
          console.log("\n⚠️  No refresh_token! Revoke access at https://myaccount.google.com/permissions and try again with prompt=consent");
        }
        console.log("\nAccess token (short-lived):", data.access_token);
        console.log("\nYou can now close this window.");

        setTimeout(() => {
          server?.stop();
          process.exit(0);
        }, 1000);

        return new Response(
          `<h1>Success!</h1><p>Refresh token printed in terminal. You can close this.</p><pre>GOOGLE_REFRESH_TOKEN=${data.refresh_token ?? "(missing - see terminal)"}</pre>`,
          { headers: { "Content-Type": "text/html" } },
        );
      } catch (e) {
        console.error(e);
        return new Response(String(e), { status: 500 });
      }
    }
    return new Response(`<a href="${authUrl.toString()}">Authorize with Google</a>`, {
      headers: { "Content-Type": "text/html" },
    });
  },
});
