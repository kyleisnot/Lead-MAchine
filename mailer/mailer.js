// mailer.js — sends email from your Gmail via the Gmail API.
// Requires a one-time setup: run `npm run auth` after placing your OAuth credentials
// at secrets/credentials.json (see SETUP.md). That produces secrets/token.json.

import { google } from "googleapis";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDENTIALS = join(__dirname, "..", "secrets", "credentials.json");
const TOKEN = join(__dirname, "..", "secrets", "token.json");

export const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

export function getOAuthClient() {
  if (!existsSync(CREDENTIALS)) {
    throw new Error(
      "Missing secrets/credentials.json — download your OAuth client from Google Cloud (see SETUP.md)."
    );
  }
  const creds = JSON.parse(readFileSync(CREDENTIALS, "utf8"));
  const c = creds.installed || creds.web;
  const client = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris?.[0] || "http://localhost:4100/oauth2callback");
  if (existsSync(TOKEN)) client.setCredentials(JSON.parse(readFileSync(TOKEN, "utf8")));
  return client;
}

// RFC 2822 message, base64url-encoded as the Gmail API wants.
function buildRaw({ to, from, subject, text }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  const msg = headers.join("\r\n") + "\r\n\r\n" + text;
  return Buffer.from(msg).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendEmail({ to, subject, text }) {
  if (!existsSync(TOKEN)) {
    throw new Error("Gmail not authorized yet — run: npm run auth");
  }
  const auth = getOAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  const from = process.env.SENDER_EMAIL || "me";
  const raw = buildRaw({ to, from, subject, text });
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  return res.data;
}
