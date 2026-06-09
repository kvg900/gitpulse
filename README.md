# GitPulse 🤖

> An AI agent that automatically reviews your GitHub pull requests using Gemini + the Model Context Protocol (MCP).

When you open a pull request, GitPulse wakes up, reads your code changes, and has Gemini post inline review comments on any bugs, security issues, or missing error handling it finds — just like a senior developer would.

---

## How it works (the short version)

```
You open a PR
    ↓
GitHub sends a webhook (a POST request) to GitPulse
    ↓
GitPulse verifies the request is genuine
    ↓
GitPulse starts an AI agent loop:
    Gemini thinks → calls a GitHub tool → sees result → repeats
    ↓
Gemini posts review comments directly on your PR
```

---

## Project structure

```
gitpulse-agent/
│
├── config/
│   └── mcp_config.json     # Tells the MCP SDK how to start the GitHub server
│
├── src/
│   ├── server.js           # Express web server — receives GitHub webhooks
│   ├── mcpClient.js        # Connects to the GitHub MCP server, exposes tools
│   └── agent.js            # The AI brain — runs the Gemini reasoning loop
│
├── .env.example            # Template for your secret keys (copy to .env)
├── .gitignore              # Keeps .env and node_modules out of git
├── package.json            # Project dependencies and npm scripts
└── README.md               # You are here
```

Read the files in this order to understand the codebase:

1. `server.js` — the entry point, simple to follow
2. `mcpClient.js` — how we talk to GitHub through MCP
3. `agent.js` — the core AI loop, the most interesting part

---

## Prerequisites

Before you start, make sure you have:

- **Node.js 18+** — [download here](https://nodejs.org/)
  Check your version: `node --version`
- A **GitHub account** with a repository you can test with
- A **Google account** to access Google AI Studio

---

## Setup (step by step)

### Step 1 — Clone and install

```bash
git clone https://github.com/yourusername/gitpulse-agent.git
cd gitpulse-agent
npm install
```

### Step 2 — Get your API keys

**Gemini API key:**

1. Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Click "Create API key"
3. Copy the key (starts with `AIza...`)

> The Gemini API has a free tier — great for experimenting!

**GitHub Personal Access Token:**

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click "Generate new token (classic)"
3. Give it a name like "gitpulse"
4. Check these scopes: `repo` (everything under it)
5. Click "Generate token" and copy it (starts with `ghp_...`)

**Webhook secret:**
Generate a random secret string by running:

```bash
openssl rand -hex 32
```

Copy the output — you'll use this in both your `.env` file and the GitHub webhook settings.

### Step 3 — Create your .env file

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```env
PORT=8080
NODE_ENV=development
GEMINI_API_KEY=AIza-your-key-here
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your-token-here
GITHUB_WEBHOOK_SECRET=your-random-secret-here
```

### Step 4 — Start the server

```bash
npm start
```

You should see:

```
🚀 GitPulse server started on http://localhost:8080
   Webhook endpoint: POST http://localhost:8080/webhook
```

### Step 5 — Expose your server to the internet

GitHub needs to reach your local server. We use **ngrok** to create a temporary public URL that tunnels to your machine.

In a **new terminal tab**:

```bash
npx ngrok http 8080
```

You'll see something like:

```
Forwarding  https://abc123.ngrok-free.app → http://localhost:8080
```

Copy that `https://` URL — you'll need it next.

### Step 6 — Register the webhook on GitHub

1. Go to your test repository on GitHub
2. Click **Settings** → **Webhooks** → **Add webhook**
3. Fill in:
   - **Payload URL:** `https://abc123.ngrok-free.app/webhook` (your ngrok URL + `/webhook`)
   - **Content type:** `application/json`
   - **Secret:** the same secret you put in `.env`
   - **Which events:** select "Let me select individual events" → check **Pull requests**
4. Click **Add webhook**

GitHub will send a test ping — you should see it arrive in your server logs.

### Step 7 — Test it!

Open a pull request in your test repository. Watch your terminal — you should see GitPulse spring into action:

```
📬 Received a webhook from GitHub...
✅ Signature verified
🔍 PR #1: "Add new feature" by @yourusername
⚙️  Starting GitHub MCP server process...
✅ Connected to GitHub MCP server.
🔧 Discovered 30 tools from MCP server
── Agent iteration 1 ──────────────────────
📨 Gemini responded
🔨 Calling tool: "get_pull_request"
── Agent iteration 2 ──────────────────────
🔨 Calling tool: "get_pull_request_files"
── Agent iteration 3 ──────────────────────
🔨 Calling tool: "create_pull_request_review_comment"
✅ Agent finished
```

Check your PR on GitHub — Gemini's comments should appear! 🎉

---

## Understanding the agentic loop (Gemini edition)

The Gemini agentic loop in `agent.js` works slightly differently from the Anthropic version. Here's what happens:

```
┌──────────────────────────────────────────────────────────────┐
│  chat = model.startChat()   ← Gemini manages history for us  │
│                                                              │
│  Iteration 1:                                                │
│    → chat.sendMessage("review PR #14")                       │
│    ← Gemini: response.functionCalls() = [get_pull_request]  │
│    → Execute: get_pull_request(owner, repo, 14) via MCP      │
│    → Build functionResponse part with the result             │
│                                                              │
│  Iteration 2:                                                │
│    → chat.sendMessage([functionResponse parts])              │
│    ← Gemini: response.functionCalls() = [get_files]         │
│    → Execute: get_pull_request_files(...) via MCP            │
│    → Build functionResponse part                             │
│                                                              │
│  Iteration 3:                                                │
│    → chat.sendMessage([functionResponse parts])              │
│    ← Gemini: response.functionCalls() = [create_comment]    │
│    → Execute: create_pull_request_review_comment(…) via MCP  │
│    → Build functionResponse part                             │
│                                                              │
│  Iteration 4:                                                │
│    → chat.sendMessage([functionResponse parts])              │
│    ← Gemini: response.functionCalls() = []  ← empty! done  │
│    → response.text() = "All done, found 2 issues"           │
│    → Break loop ✅                                           │
└──────────────────────────────────────────────────────────────┘
```

Gemini (like Claude) never directly touches GitHub — it just requests tool calls. We execute them and feed the results back.

---

## Customising the review

The review behaviour is entirely controlled by the **system instruction** in `agent.js`. To change what Gemini looks for, edit the `systemInstruction` string.

For example, to also check for TypeScript type errors, add:

```
4. **TypeScript issues**
   - Missing type annotations on function parameters
   - Use of `any` type where a specific type would be better
```

```

---

## Troubleshooting

**"Missing signature" error**
→ Make sure the Content-Type on your GitHub webhook is set to `application/json`

**"Signature mismatch" error**
→ Your `GITHUB_WEBHOOK_SECRET` in `.env` doesn't match what you entered in GitHub webhook settings

**"No tools discovered"**
→ The MCP server didn't start properly. Check that `GITHUB_PERSONAL_ACCESS_TOKEN` is set correctly in `.env`

**PR comments not appearing**
→ Your GitHub token might not have the right scopes. It needs `repo` access (read + write on pull requests)

**"API key not valid" from Gemini**
→ Double-check your `GEMINI_API_KEY` in `.env`. Get a fresh key from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)

**"Schema type must be uppercase" error**
→ This is handled automatically by `convertSchemaForGemini()` in `agent.js`. If you see this, check that function is being called correctly.

**ngrok session expired**
→ Free ngrok sessions expire after a few hours. Run `npx ngrok http 8080` again and update the webhook URL in GitHub settings.

---
```
