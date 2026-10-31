import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sanitizeGeminiSchema,
  convertMessagesToGeminiContents,
  executeGeminiNativeStream,
} from "../source/host/extensions/inference/gemini-native-adapter.js";

test("sanitizeGeminiSchema strips unsupported properties and unwraps jsonSchema", () => {
  const input = {
    jsonSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {
        message: {
          type: "string",
          description: "A message",
          default: "hi",
        },
      },
      required: ["message"],
    },
  };

  const output = sanitizeGeminiSchema(input);
  assert.equal(output.type, "OBJECT");
  assert.deepEqual(output.required, ["message"]);
  assert.equal(output.properties.message.type, "STRING");
  assert.equal(output.properties.message.description, "A message");
  assert.equal(output.properties.message.default, undefined);
  assert.equal(output.additionalProperties, undefined);
  assert.equal(output.$schema, undefined);
});

test("convertMessagesToGeminiContents merges consecutive roles and handles tool results", () => {
  const messages = [
    { role: "system", content: "System rule 1" },
    { role: "user", content: "User question" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_123", toolName: "ReadFile", args: { path: "a.txt" } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_123", toolName: "ReadFile", result: "file content" },
      ],
    },
    { role: "user", content: "Another question" },
  ];

  const result = convertMessagesToGeminiContents(messages, "Base prompt");
  assert.ok(result.systemInstruction.includes("Base prompt"));
  assert.ok(result.systemInstruction.includes("System rule 1"));

  // The tool result is mapped to user role, and followed by another user message,
  // which are merged into a single user message with 2 parts.
  assert.equal(result.contents[0].role, "user");
  assert.equal(result.contents[1].role, "model");
  assert.equal(result.contents[2].role, "user");
  assert.equal(result.contents.length, 3);
});

test("executeGeminiNativeStream streams SSE and auto-synthesizes SendMessage when plain text is returned", async () => {
  const secretsPath = path.join(os.homedir(), ".grokbot", "box-secrets.json");
  if (!fs.existsSync(secretsPath)) return;
  const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
  const apiKey = secrets?.secrets?.GEMINI_API_KEY || secrets?.GEMINI_API_KEY;
  if (!apiKey) return;

  const streamResult = executeGeminiNativeStream({
    apiKey,
    messages: [{ role: "user", content: "Answer strictly with the word: PING" }],
    systemPrompt: "Do not call any tool. Answer strictly with plain text.",
    definitions: [
      {
        name: "SendMessage",
        description: "Send chat reply",
        parameters: { type: "object", properties: { content: { type: "string" } } },
      },
    ],
  });

  const chunks = [];
  for await (const chunk of streamResult.fullStream) {
    chunks.push(chunk);
  }

  const toolCallChunk = chunks.find((c) => c.type === "tool-call" && c.toolName === "SendMessage");
  assert.ok(toolCallChunk, "Expected auto-synthesized SendMessage tool-call chunk");
  assert.equal(toolCallChunk.args.type, "text");
  assert.ok(toolCallChunk.args.content.includes("PING"));

  const response = await streamResult.response;
  assert.ok(response.messages.length > 0);
  const assistantMsg = response.messages[0];
  assert.equal(assistantMsg.role, "assistant");
  const synthInResponse = assistantMsg.content.find(
    (c) => c.type === "tool-call" && c.toolName === "SendMessage",
  );
  assert.ok(synthInResponse, "Expected SendMessage tool-call part in response.messages");
});
