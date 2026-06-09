//  agent.js  —  The "brain" of GitPulse
//
//  WHAT THIS FILE DOES:
//  1. Takes PR info (owner, repo, PR number) as input.
//  2. Sets up Groq with a system prompt defining its role.
//  3. Runs an "agentic loop": Groq thinks → calls a tool →
//     we execute the tool → Groq sees the result → repeats
//     until Groq decides it's done.
//  4. Groq posts review comments directly to GitHub via
//     the MCP tool calls.
//
//  CONCEPTS TO KNOW:
//
//  Agentic loop (also called a "ReAct loop"):
//    Instead of one-shot Q&A, we let the model:
//      1. Think about what information it needs
//      2. Call a tool to get that information
//      3. See the result and think again
//      4. Repeat until it has enough to act
//
//  HOW GROQ TOOL CALLING WORKS:
//    - Groq is OpenAI-compatible — same message format, same tool format
//    - You maintain a messages[] array manually and append each turn
//    - Model replies with finish_reason: "tool_calls" (wants a tool)
//      or finish_reason: "stop" (done, gives final answer)
//    - Tool results go back as role: "tool" messages with a tool_call_id
//
//  WHY WE FILTER TOOLS:
//    Groq's free tier has a 6,000 token-per-minute limit.
//    The MCP server exposes ~30 tools, but sending all their schemas
//    to Groq on every request blows past that limit immediately.
//    We whitelist only the 5 tools GitPulse actually needs, which
//    keeps the token usage well within the free tier limits.
//
// ============================================================

import dotenv from "dotenv";
dotenv.config(); // MUST be first — loads .env before anything reads process.env

import Groq from "groq-sdk";
import { createMcpClient } from "./mcpClient.js";

// Initialise the Groq client using the API key from .env
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── TOOL WHITELIST ─────────────────────────────────────────────
//
// These are the only GitHub MCP tools GitPulse needs:
//   1. get_pull_request          — fetch PR metadata (title, author, etc.)
//   2. get_pull_request_files    — fetch the actual code diffs
//   3. create_pull_request_review_comment — post a comment on a specific line
//   4. list_pull_request_files   — alternative way to list changed files
//   5. get_file_contents         — read a full file if needed for context
//
// Keeping this list small solves two problems:
//   a) Stays within Groq's free tier token limits
//   b) Reduces confusion — Groq only sees tools relevant to code review
//
const TOOLS_WE_NEED = [
  "get_pull_request",
  "get_pull_request_files",
  "create_pull_request_review_comment",
  "list_pull_request_files",
  "get_file_contents",
];

// ── runAgent ──────────────────────────────────────────────────
//
// The main exported function. Called by server.js when a PR event
// is received.
//
// prInfo: { owner, repo, prNumber, prTitle, author }
//
export async function runAgent(prInfo) {
  const { owner, repo, prNumber, prTitle, author } = prInfo;

  console.log(`\n🤖 Agent starting review for PR #${prNumber}...`);

  // ── Set up MCP client ──────────────────────────────────────
  //
  // Creates a connection to the GitHub MCP server and gets the
  // list of available tools.
  //
  let mcpTools, callTool, disconnect;
  try {
    ({ tools: mcpTools, callTool, disconnect } = await createMcpClient());
  } catch (err) {
    console.error("❌ Failed to start MCP client:", err.message);
    throw err;
  }

  // ── Filter to only the tools we need ──────────────────────
  //
  // mcpTools contains ALL tools the MCP server exposes (~30).
  // We filter down to just our whitelist before sending to Groq.
  // This keeps the request small enough for the free tier.
  //
  const filteredTools = mcpTools.filter((tool) =>
    TOOLS_WE_NEED.includes(tool.name),
  );
  console.log(
    `🔧 Using ${filteredTools.length} of ${mcpTools.length} available tools:`,
    filteredTools.map((t) => t.name),
  );

  // ── Convert MCP tools → Groq/OpenAI tool format ────────────
  //
  // MCP tools look like:
  //   { name, description, inputSchema: { type, properties, required } }
  //
  // Groq (OpenAI-compatible) expects:
  //   { type: "function", function: { name, description, parameters } }
  //
  // This is the simplest format of all the AI providers —
  // no uppercase types, no unsupported fields to strip.
  //
  const groqTools = filteredTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));

  // ── System prompt ──────────────────────────────────────────
  //
  // Kept concise deliberately — every token in the system prompt
  // counts against Groq's free tier limit on each request.
  //
  const systemPrompt = `You are GitPulse, an expert AI code reviewer embedded in GitHub.

Your job is to review pull requests and post constructive inline comments on lines that need attention.

## What to look for
1. Security vulnerabilities — SQL injection, hardcoded secrets, missing input validation
2. Error handling — unhandled promise rejections, silent catch blocks
3. Dependency issues — conflicting or unpinned versions in package.json
4. Code quality — logic bugs, unreachable code, missing null checks

## How to work
1. Call get_pull_request to fetch PR metadata.
2. Call get_pull_request_files to get the code diffs.
3. For each issue found, call create_pull_request_review_comment on the specific line.
4. Keep comments short, friendly, and actionable — explain WHY it's a problem and HOW to fix it.
5. If code looks good, post one positive summary comment.
6. Stop when done — do not repeat yourself.

Current PR: ${owner}/${repo} #${prNumber} "${prTitle}" by @${author}`;

  // ── Message history ────────────────────────────────────────
  //
  // Groq uses the OpenAI messages[] format.
  // We maintain this array manually, appending each turn:
  //   system → user → assistant (tool_call) → tool (result) → assistant → ...
  //
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Please review PR #${prNumber} in ${owner}/${repo} and post your findings as inline GitHub review comments.`,
    },
  ];

  // ── Agentic loop ───────────────────────────────────────────
  //
  // Keep calling Groq until finish_reason is "stop" (done)
  // or we hit the safety limit.
  //
  const MAX_ITERATIONS = 20;
  let iteration = 0;

  try {
    while (iteration < MAX_ITERATIONS) {
      iteration++;
      console.log(`\n── Agent iteration ${iteration} ──────────────────────`);

      // ── Call Groq ──────────────────────────────────────────
      //
      // Model: llama3-groq-70b-8192-tool-use-preview
      //   This model is specifically fine-tuned for tool/function calling.
      //   It's much more reliable at generating correct tool call JSON
      //   than general-purpose models like llama-3.3-70b-versatile.
      //
      // max_tokens: 1024 — keeps each response small to avoid
      //   hitting Groq's tokens-per-minute limit on the free tier.
      //
      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: messages,
        tools: groqTools,
        tool_choice: "auto", // model decides when to call tools vs when to stop
        max_tokens: 1024,
      });

      const message = response.choices[0].message;
      const finishReason = response.choices[0].finish_reason;
      console.log(`📨 Groq responded (finish_reason: "${finishReason}")`);

      // ── Append assistant message to history ────────────────
      //
      // IMPORTANT: always append before processing tool calls.
      // The API requires the assistant's tool_call request to appear
      // in history before the corresponding tool result.
      //
      messages.push(message);

      // ── Done — no more tool calls ──────────────────────────
      if (finishReason === "stop") {
        console.log(
          `\n✅ Agent finished:\n${message.content || "(no final text)"}`,
        );
        break;
      }

      // ── Handle tool calls ──────────────────────────────────
      //
      // finish_reason: "tool_calls" means Groq wants to call one or
      // more tools. message.tool_calls is an array of requests.
      //
      if (finishReason === "tool_calls" && message.tool_calls?.length > 0) {
        console.log(
          `🔧 Groq requested ${message.tool_calls.length} tool call(s)`,
        );

        for (const toolCall of message.tool_calls) {
          const toolName = toolCall.function.name;

          // Groq returns arguments as a JSON string — parse it
          let toolArgs;
          try {
            toolArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            toolArgs = {};
          }

          console.log(`\n🔨 Calling tool: "${toolName}"`);
          console.log("   Args:", JSON.stringify(toolArgs, null, 2));

          // ── Execute via MCP ────────────────────────────────
          let toolResult;
          try {
            toolResult = await callTool(toolName, toolArgs);
          } catch (err) {
            console.error(`   ❌ Tool failed: ${err.message}`);
            toolResult = `Error: ${err.message}`;
          }

          // ── Append tool result to history ──────────────────
          //
          // Tool results use role: "tool" and must include the
          // tool_call_id so Groq knows which request this answers.
          //
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }

        continue; // loop back — Groq reads the results and decides next step
      }

      // Unexpected finish_reason — stop safely
      console.warn(
        `⚠️  Unexpected finish_reason: "${finishReason}" — stopping.`,
      );
      break;
    }

    if (iteration >= MAX_ITERATIONS) {
      console.warn(`⚠️  Hit max iterations (${MAX_ITERATIONS}) — stopping.`);
    }
  } finally {
    // ── Always clean up the MCP server process ─────────────
    //
    // Runs whether the loop succeeded or threw an error.
    // Prevents leaving a zombie background process running.
    //
    await disconnect();
    console.log(`\n🏁 Agent completed review of PR #${prNumber}.`);
  }
}
