// ============================================================
//  server.js  —  The "front door" of GitPulse
//
//  WHAT THIS FILE DOES:
//  1. Starts a web server that GitHub can send events to.
//  2. When GitHub sends a "pull_request" event, it verifies
//     the request is genuine (using a shared secret).
//  3. Hands the event data off to the AI agent to review.
//
//  CONCEPTS TO KNOW:
//  - Express: a popular Node.js library for building web servers.
//  - Webhook: GitHub's way of saying "hey, something happened!"
//    by sending an HTTP POST request to a URL you specify.
//  - HMAC signature: a cryptographic "stamp" GitHub puts on every
//    webhook so you can verify it actually came from GitHub.
// ============================================================

import express from "express";
import crypto from "crypto"; // Node's built-in crypto library
import dotenv from "dotenv";
import { runAgent } from "./agent.js";

// Load variables from your .env file into process.env
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// ── Middleware ───────────────────────────────────────────────
//
// express.raw() reads the request body as raw bytes (a Buffer),
// NOT as parsed JSON. This is important because we need the
// exact original bytes to verify GitHub's HMAC signature.
// If we parsed it to JSON first, tiny differences (whitespace,
// key order) could break the signature check.
//
app.use(express.raw({ type: "application/json" }));

// ── Webhook endpoint ─────────────────────────────────────────
//
// GitHub will POST to whatever URL you set in repo Settings →
// Webhooks. We register the path "/webhook" here.
//
app.post("/webhook", async (req, res) => {
  console.log("\n📬 Received a webhook from GitHub...");

  // ── Step 1: Verify the signature ──────────────────────────
  //
  // GitHub signs each webhook payload using your GITHUB_WEBHOOK_SECRET
  // and puts the result in the "x-hub-signature-256" header.
  // We re-compute the same signature on our side; if they match,
  // the request is genuine. If not, we reject it immediately.
  //
  const githubSignature = req.headers["x-hub-signature-256"];

  if (!githubSignature) {
    console.error("❌ No signature header found — rejecting request.");
    return res.status(401).send("Missing signature");
  }

  // HMAC = Hash-based Message Authentication Code
  // We use the same secret + the same payload bytes → same hash
  const hmac = crypto.createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET);
  hmac.update(req.body); // req.body is raw bytes here
  const ourSignature = `sha256=${hmac.digest("hex")}`;

  // timingSafeEqual prevents "timing attacks" where an attacker
  // could guess the secret one character at a time by measuring
  // how long the comparison takes.
  const signaturesMatch = crypto.timingSafeEqual(
    Buffer.from(githubSignature),
    Buffer.from(ourSignature),
  );

  if (!signaturesMatch) {
    console.error("❌ Signature mismatch — request is not from GitHub.");
    return res.status(401).send("Invalid signature");
  }

  console.log("✅ Signature verified — request is genuinely from GitHub.");

  // ── Step 2: Parse the payload ──────────────────────────────
  //
  // Now that we trust the source, parse the raw bytes into JSON.
  // The payload contains everything about the event:
  // which repo, which PR, who opened it, what changed, etc.
  //
  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch (err) {
    console.error("❌ Failed to parse JSON payload:", err.message);
    return res.status(400).send("Invalid JSON");
  }

  // ── Step 3: Filter to only the events we care about ────────
  //
  // GitHub sends many event types (pushes, comments, stars, etc.).
  // The event type is in the "x-github-event" header.
  // We only want to act on pull_request events.
  //
  const eventType = req.headers["x-github-event"];
  console.log(`📋 Event type: "${eventType}", action: "${payload.action}"`);

  if (eventType !== "pull_request") {
    console.log("⏭️  Not a pull_request event — ignoring.");
    return res.status(200).send("Event ignored");
  }

  // Further filter: only review when a PR is first opened
  // or when new commits are pushed to an existing PR ("synchronize").
  const actionsWeHandle = ["opened", "synchronize"];
  if (!actionsWeHandle.includes(payload.action)) {
    console.log(
      `⏭️  Action "${payload.action}" — ignoring (we only handle 'opened' and 'synchronize').`,
    );
    return res.status(200).send("Action ignored");
  }

  // ── Step 4: Extract key info from the payload ──────────────
  //
  // The payload is a big nested object. We pull out just the
  // fields the agent will need.
  //
  const prInfo = {
    owner: payload.repository.owner.login, // e.g. "kavya-gupta"
    repo: payload.repository.name, // e.g. "DocEditor"
    prNumber: payload.pull_request.number, // e.g. 14
    prTitle: payload.pull_request.title,
    author: payload.pull_request.user.login,
  };

  console.log(
    `\n🔍 PR #${prInfo.prNumber}: "${prInfo.prTitle}" by @${prInfo.author}`,
  );
  console.log(`   Repo: ${prInfo.owner}/${prInfo.repo}`);

  // ── Step 5: Respond to GitHub immediately ──────────────────
  //
  // Webhooks have a 10-second timeout. If we don't respond quickly,
  // GitHub will consider the delivery failed and retry.
  // We send "202 Accepted" right away, then do the AI work in the
  // background (the async IIFE below).
  //
  res.status(202).send("Accepted — AI review in progress");

  // Run the agent in the background (don't await it here)
  (async () => {
    try {
      await runAgent(prInfo);
    } catch (err) {
      console.error("💥 Agent crashed:", err.message);
    }
  })();
});

// ── Health check endpoint ────────────────────────────────────
//
// A simple GET route so you can confirm the server is running.
// Visit http://localhost:8080/ in your browser to check.
//
app.get("/", (req, res) => {
  res.send(
    "🤖 GitPulse is running! Waiting for GitHub webhooks on POST /webhook",
  );
});

// ── Start listening ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 GitPulse server started on http://localhost:${PORT}`);
  console.log(`   Webhook endpoint: POST http://localhost:${PORT}/webhook`);
  console.log(
    `   (Use ngrok to expose this to the internet for GitHub webhooks)\n`,
  );
});
