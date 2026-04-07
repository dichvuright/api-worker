"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const MCP_TEMP_DIR = path.join(os.tmpdir(), "pool-mcp");
const STATUS_FILE = path.join(MCP_TEMP_DIR, "status.json");
const INPUT_FILE = path.join(MCP_TEMP_DIR, "input.txt");
const POLL_INTERVAL_MS = 500;

function ensureTempDir() {
  if (!fs.existsSync(MCP_TEMP_DIR)) {
    fs.mkdirSync(MCP_TEMP_DIR, { recursive: true });
  }
}

function writeStatus(status) {
  ensureTempDir();
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

function clearInputFile() {
  if (fs.existsSync(INPUT_FILE)) {
    fs.unlinkSync(INPUT_FILE);
  }
}

function readStatus() {
  if (!fs.existsSync(STATUS_FILE)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function readInput() {
  if (!fs.existsSync(INPUT_FILE)) {
    return null;
  }

  const text = fs.readFileSync(INPUT_FILE, "utf-8").trim();
  return text || null;
}

function getPoolToolDefinition() {
  return {
    name: "pool",
    description:
      "Pause execution and wait for user input from the Pool MCP panel. This is used to continue a multi-turn interaction inside one API flow.",
    inputSchema: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description:
            "Summary of the current conversation state so the user knows what has already been done.",
        },
        question: {
          type: "string",
          description: "Optional question asking the user what to do next.",
        },
      },
      required: ["context"],
      additionalProperties: false,
    },
  };
}

class PoolMcpServerReadable {
  constructor({
    Server,
    StdioServerTransport,
    ListToolsRequestSchema,
    CallToolRequestSchema,
  }) {
    this.Server = Server;
    this.StdioServerTransport = StdioServerTransport;
    this.ListToolsRequestSchema = ListToolsRequestSchema;
    this.CallToolRequestSchema = CallToolRequestSchema;

    this.server = new Server(
      { name: "pool-mcp", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    ensureTempDir();
    this.setupHandlers();
  }

  setupHandlers() {
    this.server.setRequestHandler(this.ListToolsRequestSchema, async () => {
      return { tools: [getPoolToolDefinition()] };
    });

    this.server.setRequestHandler(this.CallToolRequestSchema, async (request) => {
      if (request.params.name !== "pool") {
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${request.params.name}`,
            },
          ],
          isError: true,
        };
      }

      const args = request.params.arguments;

      writeStatus({
        waiting: true,
        context: args.context,
        question: args.question,
        timestamp: Date.now(),
      });

      clearInputFile();

      console.error("[Pool MCP] Waiting for user input...");
      console.error(`Context: ${args.context}`);
      if (args.question) {
        console.error(`Question: ${args.question}`);
      }

      const userInput = await this.waitForInput();

      writeStatus({
        waiting: false,
        context: "",
        timestamp: Date.now(),
      });

      console.error(
        `[Pool MCP] Received user input: ${userInput.substring(0, 100)}...`
      );

      return {
        content: [
          {
            type: "text",
            text: userInput,
          },
        ],
      };
    });
  }

  async waitForInput() {
    return new Promise((resolve) => {
      let ticks = 0;

      const timer = setInterval(() => {
        const status = readStatus();

        if (status?.canceled) {
          clearInterval(timer);
          clearInputFile();
          resolve("[canceled]");
          return;
        }

        const input = readInput();
        if (input) {
          clearInterval(timer);
          clearInputFile();
          resolve(input);
          return;
        }

        ticks += 1;
        if (ticks % 20 === 0) {
          console.error(
            `[Pool MCP] Still waiting for user input... (${ticks / 2}s)`
          );
        }
      }, POLL_INTERVAL_MS);
    });
  }

  async start() {
    const transport = new this.StdioServerTransport();
    await this.server.connect(transport);
    console.error("[Pool MCP] Server started");
  }
}

module.exports = {
  MCP_TEMP_DIR,
  STATUS_FILE,
  INPUT_FILE,
  POLL_INTERVAL_MS,
  ensureTempDir,
  writeStatus,
  clearInputFile,
  readStatus,
  readInput,
  getPoolToolDefinition,
  PoolMcpServerReadable,
};
