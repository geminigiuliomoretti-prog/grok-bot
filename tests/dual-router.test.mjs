import test from "node:test";
import assert from "node:assert/strict";
import { ApiKeyPool } from "../source/host/extensions/inference/api-key-pool.js";
import { CoordinateNormalizer, SURFACE_PRO_9_NATIVE, AGENT_DESKTOP_DEFAULT } from "../source/host/extensions/inference/coordinate-normalizer.js";
import { ToolSchemaValidator } from "../source/host/extensions/inference/tool-schema-validator.js";
import { DualFreeLLMRouter } from "../source/host/extensions/inference/dual-free-llm-router.js";

test("ApiKeyPool: round-robin selection and 429 cooldown", () => {
  const pool = new ApiKeyPool({
    keys: ["key_alpha", "key_beta", "key_gamma"],
    maxRpm: 30,
    defaultCooldownMs: 65000,
  });

  const k1 = pool.getNextKey();
  const k2 = pool.getNextKey();
  const k3 = pool.getNextKey();
  assert.equal(k1, "key_alpha");
  assert.equal(k2, "key_beta");
  assert.equal(k3, "key_gamma");

  // Round-robin wraps around
  const k4 = pool.getNextKey();
  assert.equal(k4, "key_alpha");

  // Trigger 429 on key_alpha
  pool.recordRateLimit("key_alpha", 65000);
  const statusAfterRateLimit = pool.getStatus();
  assert.equal(statusAfterRateLimit.coolingKeys, 1);
  assert.equal(statusAfterRateLimit.activeKeys, 2);

  // Subsequent getNextKey skips key_alpha
  const k5 = pool.getNextKey();
  const k6 = pool.getNextKey();
  assert.notEqual(k5, "key_alpha");
  assert.notEqual(k6, "key_alpha");
});

test("CoordinateNormalizer: spatial translation for Surface Pro 9 and Desktop", () => {
  const normalizer = new CoordinateNormalizer(AGENT_DESKTOP_DEFAULT);

  // Center coordinate normalization (640, 400 on 1280x800) -> 500, 500
  const norm = normalizer.normalize({ x: 640, y: 400 });
  assert.equal(norm.x, 500);
  assert.equal(norm.y, 500);

  // Denormalization back to pixel space
  const pixel = normalizer.denormalize({ x: 500, y: 500 });
  assert.equal(pixel.x, 640);
  assert.equal(pixel.y, 400);

  // Surface Pro 9 native resolution denormalization (500, 500 on 2880x1920 -> 1440, 960)
  const surfacePixel = normalizer.denormalize({ x: 500, y: 500 }, SURFACE_PRO_9_NATIVE);
  assert.equal(surfacePixel.x, 1440);
  assert.equal(surfacePixel.y, 960);

  // Auto-detect already pixel coordinates (>1000)
  const rawPixel = normalizer.denormalize({ x: 1200, y: 750 });
  assert.equal(rawPixel.x, 1200);
  assert.equal(rawPixel.y, 750);
});

test("ToolSchemaValidator: self-healing JSON and schema compliance", () => {
  const validator = new ToolSchemaValidator();

  // 1. Lenient JSON: trailing commas and unclosed brackets
  const malformed = '{"todos": [{"title": "Scan disk", "status": "pending",},]';
  const healed = validator.parseLenientJson(malformed);
  assert.ok(Array.isArray(healed.todos));
  assert.equal(healed.todos[0].title, "Scan disk");

  // 2. SendMessage healing from plain text or { message: ... }
  const sm1 = validator.validateAndHeal("SendMessage", "Hello from bot");
  assert.equal(sm1.valid, true);
  assert.equal(sm1.healedArgs.type, "text");
  assert.equal(sm1.healedArgs.content, "Hello from bot");

  const sm2 = validator.validateAndHeal("SendMessage", { message: "Test reply" });
  assert.equal(sm2.valid, true);
  assert.equal(sm2.healedArgs.content, "Test reply");

  // 3. ExternalShell normalization
  const sh = validator.validateAndHeal("ExternalShell", { cmd: "dir C:\\" });
  assert.equal(sh.valid, true);
  assert.equal(sh.healedArgs.command, "dir C:\\");

  // 4. TodoWrite normalization from array
  const td = validator.validateAndHeal("TodoWrite", ["First item", "Second item"]);
  assert.equal(td.valid, true);
  assert.equal(td.healedArgs.todos.length, 2);
  assert.equal(td.healedArgs.todos[0].title, "First item");
});

test("DualFreeLLMRouter: health-check and router stats", async () => {
  const router = DualFreeLLMRouter.getInstance();
  const isHealthy = await router.checkEngineAHealth();
  assert.equal(typeof isHealthy, "boolean");

  const stats = router.getStats();
  assert.ok(["hybrid", "oauth_first", "gemma_only"].includes(stats.routingMode));
  assert.equal(stats.engineAName, "gemini-3.8-flash");
  assert.ok(stats.engineBName.length > 0);
});
