// ============================================================
//  agent.js  —  The "brain" of GitPulse
//
//  WHAT THIS FILE DOES:
//  1. Takes PR info (owner, repo, PR number) as input.
//  2. Sets up Gemini with a system prompt defining its role.
//  3. Runs an "agentic loop": Gemini thinks → calls a tool →
//     we execute the tool → Gemini sees the result → repeats
//     until Gemini decides it's done.
//  4. Gemini posts review comments directly to GitHub via
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
//    This is how modern AI agents work — they're not magic,
//    they're just models in a loop with access to tools.
//
//  HOW GEMINI'S TOOL CALLING WORKS (different from Anthropic!):
//
//  Anthropic (Claude) API flow:
//    - You send messages[]
//    - Model replies with stop_reason: "tool_use" or "end_turn"
//    - Tool results go back as role: "user" messages
//
//  Google Gemini API flow:
//    - You use a "chat session" object that tracks history internally
//    - Model replies with response.functionCalls() array (if it wants tools)
//    - If functionCalls() is empty → model is done
//    - Tool results are sent back via chat.sendMessage() with
//      special "functionResponse" parts — NOT as plain text
//    - The chat object handles appending history for you
//
//  Key Gemini concepts:
//    - GoogleGenerativeAI: the main SDK class
//    - genAI.getGenerativeModel(): creates a model instance with tools baked in
//    - model.startChat(): creates a stateful chat session
//    - chat.sendMessage(): sends a message, returns a response
//    - response.functionCalls(): returns array of tool calls Gemini wants to make
//    - functionResponse part: how you return tool results to Gemini
//
//  Tool format differences:
//    Anthropic: { name, description, input_schema: { type, properties, required } }
//    Gemini:    { functionDeclarations: [{ name, description, parameters: { type, properties, required } }] }
//    (Gemini wraps everything in a "functionDeclarations" array inside a "tools" object)
//
// ============================================================
import dotenv from "dotenv";
dotenv.config();

import Groq from "groq-sdk";
import { createMcpClient } from "./mcpClient.js";

// Initialise the Gemini SDK.
// GoogleGenerativeAI reads your API key from the argument you pass.
// We read it from the GEMINI_API_KEY environment variable (set in .env).

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
  // list of available tools (like get_pull_request, create_review_comment, etc.)
  //
  let mcpTools, callTool, disconnect;
  try {
    ({ tools: mcpTools, callTool, disconnect } = await createMcpClient());
  } catch (err) {
    console.error("❌ Failed to start MCP client:", err.message);
    throw err;
  }

  // ── Convert MCP tools → Gemini tool format ─────────────────
  //
  // MCP gives us tools shaped like:
  //   {
  //     name: "get_pull_request",
  //     description: "Fetch a pull request by number",
  //     inputSchema: { type: "object", properties: { owner: {...}, ... }, required: [...] }
  //   }
  //
  // Gemini expects tools wrapped in a "functionDeclarations" array,
  // with the schema under "parameters" instead of "inputSchema":
  //   {
  //     functionDeclarations: [
  //       {
  //         name: "get_pull_request",
  //         description: "Fetch a pull request by number",
  //         parameters: { type: "object", properties: { owner: {...}, ... }, required: [...] }
  //       }
  //     ]
  //   }
  //
  // Gemini also requires that "parameters" uses uppercase type strings
  // like "STRING", "NUMBER", "OBJECT", "ARRAY" (not lowercase like JSON Schema).
  // The helper below handles that conversion.
  //
  // ── Convert MCP tools → Groq/OpenAI tool format ────────────
  //
  // Groq uses the exact same tool format as OpenAI:
  //   { type: "function", function: { name, description, parameters } }
  // This is simpler than Gemini — no uppercase types, no unsupported fields.
  //
  const groqTools = mcpTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));

  // ── System prompt ───────────────────────────────────────────
  const systemPrompt = `You are GitPulse, an expert AI code reviewer embedded in GitHub.

Your job is to review pull requests and post constructive, specific comments
directly on the lines of code that need attention.

## Review Checklist

1. **Security vulnerabilities**
   - SQL injection, hardcoded secrets, missing input validation

2. **Error handling**
   - Unhandled promise rejections, silent catch blocks

3. **Dependency issues**
   - Conflicting or unpinned versions in package.json

4. **Code quality**
   - Logic bugs, unreachable code, missing null checks

## How to work
1. Fetch the pull request details first.
2. Fetch the file diffs to read the actual code changes.
3. Post a review comment on each specific line that has an issue.
4. Keep comments concise, friendly, and actionable.
5. If code looks good, post one positive summary comment.
6. When done, stop.

Repository: ${owner}/${repo} | PR: #${prNumber} | Author: @${author}`;

  // ── Message history ─────────────────────────────────────────
  //
  // Groq (like OpenAI) uses a messages[] array that we maintain manually.
  // Each turn appends the assistant reply + tool results before calling again.
  //
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Please review PR #${prNumber} in ${owner}/${repo} and post findings as inline GitHub review comments.`,
    },
  ];

  // ── Agentic loop ────────────────────────────────────────────
  const MAX_ITERATIONS = 20;
  let iteration = 0;

  try {
    while (iteration < MAX_ITERATIONS) {
      iteration++;
      console.log(`\n── Agent iteration ${iteration} ──────────────────────`);

      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile", // best free model on Groq for tool use
        messages: messages,
        tools: groqTools,
        tool_choice: "auto", // let the model decide when to call tools
        max_tokens: 4096,
      });

      const message = response.choices[0].message;
      console.log(
        `📨 Groq responded (finish_reason: "${response.choices[0].finish_reason}")`,
      );

      // Add assistant's response to history
      messages.push(message);

      // ── Check if done ───────────────────────────────────────
      if (response.choices[0].finish_reason === "stop") {
        console.log(
          `\n✅ Agent finished:\n${message.content || "(no final text)"}`,
        );
        break;
      }

      // ── Handle tool calls ───────────────────────────────────
      //
      // Groq signals tool calls with finish_reason: "tool_calls"
      // and populates message.tool_calls[] with the requests.
      //
      if (
        response.choices[0].finish_reason === "tool_calls" &&
        message.tool_calls
      ) {
        for (const toolCall of message.tool_calls) {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments);

          console.log(`\n🔨 Calling tool: "${toolName}"`);

          let toolResult;
          try {
            toolResult = await callTool(toolName, toolArgs);
          } catch (err) {
            console.error(`   ❌ Tool call failed: ${err.message}`);
            toolResult = `Error: ${err.message}`;
          }

          // Tool results go back as role: "tool" messages
          // The tool_call_id links the result to the specific request
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }
        continue; // loop back so Groq can read the results
      }

      console.warn(`⚠️  Unexpected finish_reason — stopping.`);
      break;
    }

    if (iteration >= MAX_ITERATIONS) {
      console.warn(`⚠️  Hit max iterations (${MAX_ITERATIONS}) — stopping.`);
    }
  } finally {
    // ── Always clean up the MCP server process ─────────────
    //
    // The finally block runs whether the loop succeeded or threw
    // an error. This ensures we never leave a zombie process running.
    //
    await disconnect();
    console.log(`\n🏁 Agent completed review of PR #${prNumber}.`);
  }
}

// ── convertSchemaForGemini ────────────────────────────────────
//
// WHAT THIS DOES:
// Converts a standard JSON Schema object (what MCP gives us) into
// the format Gemini's API expects.
//
// The key difference: JSON Schema uses lowercase type names ("string",
// "number", "object", "array", "boolean") but Gemini requires uppercase
// ("STRING", "NUMBER", "OBJECT", "ARRAY", "BOOLEAN").
//
// This function recursively walks the schema tree and uppercases all
// "type" fields, so nested schemas (objects containing arrays
// containing objects, etc.) are all correctly converted.
//
// EXAMPLE:
//   Input (JSON Schema from MCP):
//     { type: "object", properties: { owner: { type: "string" } }, required: ["owner"] }
//
//   Output (Gemini format):
//     { type: "OBJECT", properties: { owner: { type: "STRING" } }, required: ["owner"] }
//
function convertSchemaForGemini(schema) {
  if (!schema || typeof schema !== "object") return schema;

  // Handle arrays (e.g. anyOf/oneOf/allOf contain arrays of schemas)
  if (Array.isArray(schema)) {
    return schema.map((item) => convertSchemaForGemini(item));
  }

  const converted = { ...schema };

  // ── Strip every field Gemini does not support ──────────────
  // Gemini throws a hard 400 if ANY of these appear anywhere in
  // the schema tree, including deeply nested inside anyOf/items/etc.
  delete converted.additionalProperties;
  delete converted.$schema;
  delete converted.default;
  delete converted.examples;
  delete converted.$defs;
  delete converted.definitions;

  // Uppercase the "type" field — Gemini requires "STRING" not "string"
  if (converted.type && typeof converted.type === "string") {
    converted.type = converted.type.toUpperCase();
  }

  // Recursively clean nested property schemas
  // (each key in "properties" is itself a schema object)
  if (converted.properties) {
    const convertedProps = {};
    for (const [key, value] of Object.entries(converted.properties)) {
      convertedProps[key] = convertSchemaForGemini(value);
    }
    converted.properties = convertedProps;
  }

  // Recursively clean array item schemas
  if (converted.items) {
    converted.items = convertSchemaForGemini(converted.items);
  }

  // Recursively clean anyOf arrays
  // (e.g. a field that can be a string OR an object)
  if (converted.anyOf) {
    converted.anyOf = converted.anyOf.map((s) => convertSchemaForGemini(s));
  }

  // Recursively clean oneOf arrays
  if (converted.oneOf) {
    converted.oneOf = converted.oneOf.map((s) => convertSchemaForGemini(s));
  }

  // Recursively clean allOf arrays
  if (converted.allOf) {
    converted.allOf = converted.allOf.map((s) => convertSchemaForGemini(s));
  }

  return converted;
}
