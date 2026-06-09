// ============================================================
//  mcpClient.js  —  The "translator" between Gemini and GitHub
//
//  WHAT THIS FILE DOES:
//  1. Starts the GitHub MCP server as a background process.
//  2. Connects to it using the MCP SDK over stdio (standard I/O pipes).
//  3. Discovers which "tools" the server exposes (e.g. get_pull_request,
//     create_pull_request_review_comment, etc.).
//  4. Provides a function to call those tools by name.
//  5. Cleans up the background process when we're done.
//
//  CONCEPTS TO KNOW:
//
//  MCP (Model Context Protocol):
//    An open standard that lets AI models interact with external
//    services through a common "tools" interface. Instead of writing
//    custom GitHub API code, we run a pre-built MCP server that
//    already knows the GitHub API — and expose its capabilities
//    to Gemini as a list of callable tools.
//
//  stdio transport:
//    The MCP server runs as a separate process. We communicate with
//    it by writing JSON-RPC messages to its stdin (standard input)
//    and reading responses from its stdout (standard output).
//    Think of it like two programs talking through a pipe.
//
//  JSON-RPC:
//    A simple protocol where you send:
//      { "method": "tools/call", "params": { "name": "...", "arguments": {...} } }
//    and get back a result. The MCP SDK handles this for us.
//
// ============================================================

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ── createMcpClient ───────────────────────────────────────────
//
// This is the main exported function. Call it to get a connected
// MCP client ready to use.
//
// Returns an object with:
//   - tools:       array of tool definitions (name, description, inputSchema)
//   - callTool:    function(toolName, args) → result
//   - disconnect:  function() → cleans up the background process
//
export async function createMcpClient() {
  console.log("⚙️  Starting GitHub MCP server process...");

  // ── Launch the MCP server as a child process ───────────────
  //
  // StdioClientTransport spawns the command below as a subprocess.
  // The MCP SDK then pipes JSON-RPC messages through stdin/stdout.
  //
  // "npx -y @modelcontextprotocol/server-github" downloads and runs
  // the official open-source GitHub MCP server. The "-y" flag means
  // "auto-install without asking". The server needs the GitHub token
  // in its environment to authenticate with the GitHub API.
  //
  const transport = new StdioClientTransport({
    command: "npx",
    // @modelcontextprotocol/server-github still works despite the deprecation warning.
    // The new official server (github/github-mcp-server) is binary-only and cannot
    // be used with npx, so we stay on this npm package.
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: {
      ...process.env, // pass through our env variables (PATH etc.)
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
    },
  });

  // ── Create and connect the MCP client ─────────────────────
  //
  // The Client object from the MCP SDK manages the protocol
  // handshake and message framing for us.
  //
  const client = new Client(
    {
      name: "gitpulse-agent", // identifies our client to the server
      version: "1.0.0",
    },
    {
      capabilities: {}, // we don't advertise any special capabilities
    },
  );

  // connect() performs the MCP "initialize" handshake:
  // our client → server: "hello, I'm gitpulse-agent"
  // server → our client: "hello, here's what I can do"
  await client.connect(transport);
  console.log("✅ Connected to GitHub MCP server.");

  // ── Discover available tools ───────────────────────────────
  //
  // The MCP server advertises which GitHub actions it can perform.
  // tools/list returns an array of tool objects, each with:
  //   - name:        e.g. "create_pull_request_review_comment"
  //   - description: human-readable explanation of what it does
  //   - inputSchema: JSON Schema describing the required arguments
  //
  // We pass this list to Gemini so it knows what it can do.
  //
  const { tools } = await client.listTools();
  console.log(`🔧 Discovered ${tools.length} tools from MCP server:`);
  tools.forEach((t) => console.log(`   • ${t.name}`));

  // ── callTool helper ────────────────────────────────────────
  //
  // Wraps client.callTool() with logging so you can see exactly
  // what's happening during the agent loop.
  //
  async function callTool(toolName, toolArgs) {
    console.log(`\n🔨 Calling tool: "${toolName}"`);
    console.log("   Args:", JSON.stringify(toolArgs, null, 2));

    const result = await client.callTool({
      name: toolName,
      arguments: toolArgs,
    });

    // The result content is an array of content blocks.
    // For GitHub API calls, it's usually a single text block
    // containing JSON.
    const rawText = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    console.log(`   ✅ Tool result received (${rawText.length} chars)`);
    return rawText;
  }

  // ── disconnect helper ──────────────────────────────────────
  //
  // Always call this when you're done! It sends the MCP "shutdown"
  // message and kills the child process cleanly.
  //
  async function disconnect() {
    await client.close();
    console.log("🔌 Disconnected from MCP server.");
  }

  return { tools, callTool, disconnect };
}
