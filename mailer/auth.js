// auth.js — one-time Gmail authorization. Run with: npm run auth
// Opens your browser, you approve, and it saves secrets/token.json so the app can send mail.

import { google } from "googleapis";
import http from "http";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { exec } from "child_process";
import { getOAuthClient, SCOPES } from "./mailer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN = join(__dirname, "..", "secrets", "token.json");
const REDIRECT_PORT = 4100;

const client = getOAuthClient();
const authUrl = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

console.log("\n1) Your browser should open. If not, paste this URL:\n");
console.log(authUrl + "\n");
exec(`open "${authUrl}"`); // macOS

// Catch the redirect with the auth code.
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) return res.end("ok");
  const code = new URL(req.url, `http://localhost:${REDIRECT_PORT}`).searchParams.get("code");
  if (!code) {
    res.end("No code received.");
    return;
  }
  try {
    const { tokens } = await client.getToken(code);
    writeFileSync(TOKEN, JSON.stringify(tokens, null, 2));
    res.end("✅ Gmail authorized! You can close this tab and return to the terminal.");
    console.log("✅ Saved secrets/token.json — you can now send email.\n");
  } catch (e) {
    res.end("Error: " + e.message);
    console.error(e.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(REDIRECT_PORT, () => console.log(`Waiting for Google redirect on http://localhost:${REDIRECT_PORT} …`));
