import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApiKeyPool } from "./api-key-pool.js";
import { CoordinateNormalizer, AGENT_DESKTOP_DEFAULT } from "./coordinate-normalizer.js";
import { ToolSchemaValidator } from "./tool-schema-validator.js";
import {
  DEFAULT_SEED_THOUGHT_SIGNATURE,
  type GeminiNativeStreamOptions,
  type StreamChunk,
  type UsageRecord,
} from "./gemini-native-adapter.js";

export type RoutingMode = "hybrid" | "oauth_first" | "gemma_only";

export interface DualRouterStats {
  routingMode: RoutingMode;
  engineAHealthy: boolean;
  engineAName: string;
  engineBName: string;
  keyPoolStats: ReturnType<ApiKeyPool["getStatus"]>;
  totalRoutedA: number;
  totalRoutedB: number;
  totalFailovers: number;
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

export class DualFreeLLMRouter {
  private static instance: DualFreeLLMRouter | null = null;
  private readonly keyPool: ApiKeyPool;
  private readonly validator = new ToolSchemaValidator();
  private readonly normalizer = new CoordinateNormalizer(AGENT_DESKTOP_DEFAULT);

  private routingMode: RoutingMode;
  private engineAUrl: string;
  private engineAModel: string;
  private engineBModel: string;

  private engineAHealthy = false;
  private lastHealthCheckTime = 0;
  private totalRoutedA = 0;
  private totalRoutedB = 0;
  private totalFailovers = 0;

  static getInstance(): DualFreeLLMRouter {
    if (!this.instance) {
      this.instance = new DualFreeLLMRouter();
    }
    return this.instance;
  }

  constructor() {
    this.keyPool = new ApiKeyPool();
    this.routingMode = (process.env.LLM_ROUTING_MODE?.toLowerCase() as RoutingMode) || "hybrid";
    this.engineAUrl = process.env.GEMINI_OAUTH_PROXY_URL?.trim() || "http://127.0.0.1:3000/v1";
    this.engineAModel = process.env.GEMINI_OAUTH_MODEL?.trim() || "gemini-3.8-flash";
    this.engineBModel = process.env.GEMMA_MODEL?.trim() || "gemma-4-31b-it";

    // Trigger initial non-blocking health check
    void this.checkEngineAHealth();
  }

  async checkEngineAHealth(): Promise<boolean> {
    const now = Date.now();
    // Cache health for 10 seconds
    if (now - this.lastHealthCheckTime < 10_000) {
      return this.engineAHealthy;
    }
    this.lastHealthCheckTime = now;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 450); // <500ms requirement
      const checkUrl = `${this.engineAUrl.replace(/\/v1\/?$/, "")}/v1/models`;
      const res = await fetch(checkUrl, {
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timer);

      if (res && res.ok) {
        this.engineAHealthy = true;
        return true;
      }
    } catch {}

    // Also check if local oauth credentials file exists and has a refresh token
    const oauthCredsPath = join(homedir(), ".gemini", "oauth_creds.json");
    if (existsSync(oauthCredsPath)) {
      try {
        const d = JSON.parse(readFileSync(oauthCredsPath, "utf8"));
        if (d && (d.refresh_token || d.access_token)) {
          // OAuth credentials exist; proxy can serve or direct token can be used
          this.engineAHealthy = true;
          return true;
        }
      } catch {}
    }

    this.engineAHealthy = false;
    return false;
  }

  getStats(): DualRouterStats {
    return {
      routingMode: this.routingMode,
      engineAHealthy: this.engineAHealthy,
      engineAName: this.engineAModel,
      engineBName: this.engineBModel,
      keyPoolStats: this.keyPool.getStatus(),
      totalRoutedA: this.totalRoutedA,
      totalRoutedB: this.totalRoutedB,
      totalFailovers: this.totalFailovers,
    };
  }

  /**
   * Cleans old thought blocks from concluded conversational history turns to avoid saturating context window.
   */
  private cleanHistoricalThoughts(messages: readonly any[]): any[] {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const len = messages.length;
    return messages.map((msg, idx) => {
      // Keep thoughts only for the very last turn if active
      const isLatestTurn = idx >= len - 2;
      if (isLatestTurn) return msg;

      if (msg.role === "assistant") {
        if (typeof msg.content === "string") {
          const cleaned = msg.content
            .replace(/<\|channel>thought[\s\S]*?<\|channel>text/g, "")
            .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
            .trim();
          return { ...msg, content: cleaned || " " };
        }
        if (Array.isArray(msg.content)) {
          const cleanedParts = msg.content.filter((part: any) => part.type !== "reasoning" && part.thought !== true);
          return { ...msg, content: cleanedParts.length > 0 ? cleanedParts : [{ type: "text", text: " " }] };
        }
      }
      return msg;
    });
  }

  /**
   * Prepares contents with Gemma-specific Multimodal Ordering:
   * Image blocks MUST precede Text blocks for maximum spatial precision.
   */
  private prepareContents(messages: readonly any[], isGemma: boolean): any[] {
    const cleaned = this.cleanHistoricalThoughts(messages);
    const contents: any[] = [];
    let lastSeenThoughtSig = DEFAULT_SEED_THOUGHT_SIGNATURE;

    for (const msg of cleaned) {
      if (msg.role === "system") continue;

      if (msg.role === "user") {
        const imageParts: any[] = [];
        const textParts: any[] = [];

        if (typeof msg.content === "string") {
          textParts.push({ text: msg.content || " " });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === "image" && part.image) {
              const prep = this.normalizer.prepareScreenshotPayload(part.image);
              imageParts.push({
                inlineData: {
                  mimeType: part.mimeType || "image/png",
                  data: prep.base64,
                },
              });
            } else if (part.type === "text" && typeof part.text === "string") {
              textParts.push({ text: part.text });
            }
          }
        }

        // Gemma Multimodal ordering: Image blocks BEFORE Text blocks
        const parts = isGemma
          ? [...imageParts, ...textParts]
          : [...textParts, ...imageParts];

        if (parts.length === 0) parts.push({ text: " " });
        contents.push({ role: "user", parts });
        continue;
      }

      if (msg.role === "assistant" || msg.role === "model") {
        const parts: any[] = [];
        if (typeof msg.content === "string") {
          if (msg.content.trim().length > 0) parts.push({ text: msg.content.trim() });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (!part) continue;
            if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
              parts.push({ text: part.text });
            } else if (part.type === "tool-call" || part.type === "toolCall" || part.toolName) {
              const sig = part.thoughtSignature || part.thought_signature;
              if (sig && typeof sig === "string" && sig.length > 20) lastSeenThoughtSig = sig;
              parts.push({
                functionCall: {
                  name: part.toolName || part.name,
                  args: typeof part.args === "string" ? JSON.parse(part.args) : (part.args ?? {}),
                  ...(part.toolCallId || part.id ? { id: part.toolCallId || part.id } : {}),
                },
                thoughtSignature: lastSeenThoughtSig,
              });
            } else if (part.functionCall) {
              const sig = part.thoughtSignature || part.thought_signature;
              if (sig && typeof sig === "string" && sig.length > 20) lastSeenThoughtSig = sig;
              parts.push({
                functionCall: part.functionCall,
                thoughtSignature: lastSeenThoughtSig,
              });
            }
          }
        }
        if (parts.length === 0) parts.push({ text: " " });
        contents.push({ role: "model", parts });
        continue;
      }

      if (msg.role === "tool") {
        const parts: any[] = [];
        if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === "tool-result") {
              parts.push({
                functionResponse: {
                  name: item.toolName || item.name || "tool",
                  response: { output: item.result ?? item.output ?? "" },
                  ...(item.toolCallId ? { id: item.toolCallId } : {}),
                },
              });
            }
          }
        } else {
          parts.push({
            functionResponse: {
              name: msg.name || msg.id || "tool",
              response: { output: msg.content ?? "" },
            },
          });
        }
        if (parts.length > 0) contents.push({ role: "user", parts });
      }
    }

    return contents;
  }

  /**
   * Determines whether the given request should be routed to Engine A (Gemini 3.8 Flash via OAuth).
   */
  private shouldRouteToEngineA(options: GeminiNativeStreamOptions): boolean {
    if (this.routingMode === "gemma_only") return false;
    if (this.routingMode === "oauth_first") return true;

    // In "hybrid" mode:
    // Route to Engine A if payload contains images/screenshots (Computer Use, WhatsApp Web UI)
    // or if it's an architectural planning task.
    for (const msg of options.messages) {
      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === "image" || p.image) return true;
        }
      }
    }

    // Check if initial planning prompt
    const lastMsg = options.messages[options.messages.length - 1];
    const text = typeof lastMsg?.content === "string" ? lastMsg.content.toLowerCase() : "";
    if (
      text.includes("pianifica") ||
      text.includes("piano") ||
      text.includes("architettura") ||
      text.includes("screen") ||
      text.includes("whatsapp") ||
      text.includes("desktop")
    ) {
      return true;
    }

    return false;
  }

  /**
   * Main entry point: executes stream with intelligent routing and zero-drop failover.
   */
  executeRoutedStream(options: GeminiNativeStreamOptions) {
    const invocationId = options.invocationId ?? randomUUID();
    const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
    const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
    const resultResponse = deferred<any>();
    const metadata = deferred<Record<string, unknown>>();

    const self = this;

    const fullStream = (async function* () {
      let isEngineA = self.shouldRouteToEngineA(options);
      let streamSucceeded = false;
      let lastError: unknown;

      const attempts = [isEngineA, !isEngineA];

      for (let routeAttempt = 0; routeAttempt < attempts.length; routeAttempt++) {
        const useEngineA = attempts[routeAttempt]!;

        if (useEngineA) {
          // Check if Engine A is available
          const healthy = await self.checkEngineAHealth();
          if (!healthy && self.routingMode === "hybrid") {
            // Silently fall back to Engine B without throwing
            continue;
          }
        }

        try {
          if (useEngineA) {
            self.totalRoutedA++;
            yield* self.streamFromEngineA(options, invocationId, usage, extendedUsage, metadata, resultResponse);
          } else {
            self.totalRoutedB++;
            yield* self.streamFromEngineB(options, invocationId, usage, extendedUsage, metadata, resultResponse);
          }
          streamSucceeded = true;
          break;
        } catch (err: any) {
          lastError = err;
          self.totalFailovers++;
          console.warn(`[DualFreeLLMRouter] Engine ${useEngineA ? "A (OAuth)" : "B (KeyPool)"} failed. Triggering Zero-Drop failover:`, err?.message || err);
          // Loop continues to alternate engine
        }
      }

      if (!streamSucceeded) {
        const finalErr = lastError instanceof Error ? lastError : new Error(String(lastError ?? "Dual router failed"));
        usage.reject(finalErr);
        extendedUsage.reject(finalErr);
        metadata.reject(finalErr);
        resultResponse.reject(finalErr);
        throw finalErr;
      }
    })();

    return {
      fullStream,
      response: resultResponse.promise,
      usage: usage.promise,
      extendedUsage: extendedUsage.promise,
      providerMetadata: metadata.promise,
      invocationId: Promise.resolve(invocationId),
    };
  }

  /**
   * ENGINE A: Gemini 3.8 Flash via OAuth micro-proxy or local endpoint.
   */
  private async *streamFromEngineA(
    options: GeminiNativeStreamOptions,
    invocationId: string,
    usage: ReturnType<typeof deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>>,
    extendedUsage: ReturnType<typeof deferred<any>>,
    metadata: ReturnType<typeof deferred<Record<string, unknown>>>,
    resultResponse: ReturnType<typeof deferred<any>>,
  ): AsyncGenerator<StreamChunk> {
    const isUiTask = options.messages.some((m) =>
      Array.isArray(m.content) ? m.content.some((p: any) => p.type === "image") : false,
    );
    const thinkingLevel = isUiTask ? "low" : "high";

    const contents = this.prepareContents(options.messages, false);
    const requestBody: Record<string, any> = {
      model: this.engineAModel,
      contents,
      generationConfig: {
        thinking_level: thinkingLevel,
      },
    };

    if (options.systemPrompt) {
      requestBody.systemInstruction = { parts: [{ text: options.systemPrompt }] };
    }

    if (options.definitions && options.definitions.length > 0) {
      requestBody.tools = [{
        functionDeclarations: options.definitions.map((d: any) => ({
          name: d.name,
          description: d.description,
          parameters: d.inputSchema ?? d.parameters,
        })),
      }];
    }

    const url = `${this.engineAUrl.replace(/\/+$/, "")}/models/${this.engineAModel}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Engine A (OAuth ${this.engineAModel}) returned ${res.status}: ${errText}`);
    }

    yield* this.consumeSseStream(res, this.engineAModel, invocationId, usage, extendedUsage, metadata, resultResponse, options);
  }

  /**
   * ENGINE B: Gemma 4 / Gemini Free Key Pool.
   */
  private async *streamFromEngineB(
    options: GeminiNativeStreamOptions,
    invocationId: string,
    usage: ReturnType<typeof deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>>,
    extendedUsage: ReturnType<typeof deferred<any>>,
    metadata: ReturnType<typeof deferred<Record<string, unknown>>>,
    resultResponse: ReturnType<typeof deferred<any>>,
  ): AsyncGenerator<StreamChunk> {
    const apiKey = this.keyPool.getNextKey();
    const isGemma = this.engineBModel.toLowerCase().includes("gemma");

    const contents = this.prepareContents(options.messages, isGemma);

    // Standardized Sampling for Gemma: temperature 1.0, top_p 0.95, top_k 64
    const generationConfig: Record<string, any> = {
      temperature: 1.0,
      topP: 0.95,
      topK: 64,
    };

    let systemText = options.systemPrompt ?? "";
    if (isGemma && !systemText.includes("<|think|>")) {
      systemText = `<|think|>\n${systemText}`.trim();
    }

    const requestBody: Record<string, any> = {
      contents,
      generationConfig,
    };

    if (systemText) {
      requestBody.systemInstruction = { parts: [{ text: systemText }] };
    }

    if (options.definitions && options.definitions.length > 0) {
      requestBody.tools = [{
        functionDeclarations: options.definitions.map((d: any) => ({
          name: d.name,
          description: d.description,
          parameters: d.inputSchema ?? d.parameters,
        })),
      }];
    }

    // Try primary model in pool (e.g. gemma-4-31b-it or fallback to gemini-3.1-flash-lite)
    const candidateModels = [this.engineBModel, "gemini-3.1-flash-lite", "gemini-flash-lite-latest"];
    let lastError: unknown;

    for (const model of candidateModels) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          if (res.status === 429) {
            this.keyPool.recordRateLimit(apiKey);
            throw new Error(`Engine B Key Rate Limited (429): ${errText}`);
          }
          if (res.status === 404) {
            continue; // Model not available, try next candidate
          }
          throw new Error(`Engine B (${model}) returned ${res.status}: ${errText}`);
        }

        this.keyPool.recordSuccess(apiKey);
        yield* this.consumeSseStream(res, model, invocationId, usage, extendedUsage, metadata, resultResponse, options);
        return;
      } catch (e) {
        lastError = e;
        this.keyPool.recordError(apiKey);
      }
    }

    throw lastError ?? new Error("All Engine B candidates exhausted.");
  }

  /**
   * Common SSE consumer with Self-Healing Tool Validation and SendMessage auto-synthesis.
   */
  private async *consumeSseStream(
    res: Response,
    modelName: string,
    invocationId: string,
    usage: ReturnType<typeof deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>>,
    extendedUsage: ReturnType<typeof deferred<any>>,
    metadata: ReturnType<typeof deferred<Record<string, unknown>>>,
    resultResponse: ReturnType<typeof deferred<any>>,
    options: GeminiNativeStreamOptions,
  ): AsyncGenerator<StreamChunk> {
    if (!res.body) throw new Error("Empty SSE stream body.");

    let buffer = "";
    let plainText = "";
    let reasoningText = "";
    let hasEmittedToolCall = false;
    let lastThoughtSignature = DEFAULT_SEED_THOUGHT_SIGNATURE;
    const assistantContentParts: any[] = [];

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    for await (const chunk of res.body as any) {
      buffer += Buffer.from(chunk).toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;

        let parsed: any;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (parsed.usageMetadata) {
          promptTokens = parsed.usageMetadata.promptTokenCount ?? promptTokens;
          completionTokens = parsed.usageMetadata.candidatesTokenCount ?? completionTokens;
          totalTokens = parsed.usageMetadata.totalTokenCount ?? (promptTokens + completionTokens);
        }

        const candidate = parsed.candidates?.[0];
        const parts = candidate?.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const sig = part.thoughtSignature || part.thought_signature;
            if (sig && typeof sig === "string" && sig.length > 20) {
              lastThoughtSignature = sig;
            }

            if (part.thought === true && typeof part.text === "string") {
              reasoningText += part.text;
              yield { type: "reasoning", textDelta: part.text };
            } else if (typeof part.text === "string" && part.text.length > 0) {
              plainText += part.text;
              yield { type: "text-delta", textDelta: part.text };
            } else if (part.functionCall) {
              hasEmittedToolCall = true;
              const toolName = part.functionCall.name;
              const toolCallId = part.functionCall.id || `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

              // Self-Healing JSON and Schema Validation
              const validation = this.validator.validateAndHeal(toolName, part.functionCall.args);
              const args = validation.healedArgs;

              const chunk: StreamChunk = {
                type: "tool-call",
                toolCallId,
                toolName,
                args,
                thoughtSignature: lastThoughtSignature,
              };

              assistantContentParts.push(chunk);
              yield chunk;
            }
          }
        }
      }
    }

    // Auto-synthesize SendMessage if only plainText was generated and SendMessage is supported
    const supportsSendMessage = options.definitions?.some(
      (d: any) => d.name && d.name.toLowerCase() === "sendmessage",
    );
    if (!hasEmittedToolCall && plainText.trim().length > 0 && supportsSendMessage) {
      const synthId = `call_synth_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const synthArgs = { type: "text", content: plainText.trim() };
      const chunk: StreamChunk = {
        type: "tool-call",
        toolCallId: synthId,
        toolName: "SendMessage",
        args: synthArgs,
        thoughtSignature: lastThoughtSignature,
      };
      assistantContentParts.push(chunk);
      yield chunk;
    }

    const usageRecord: UsageRecord = {
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    options.onUsage?.(usageRecord);

    usage.resolve({ promptTokens, completionTokens, totalTokens });
    extendedUsage.resolve({
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      maxTokens: 0,
    });
    metadata.resolve({ dualRouter: { model: modelName } });
    resultResponse.resolve({
      id: invocationId,
      modelId: modelName,
      timestamp: new Date(),
      headers: {},
      messages: [{ role: "assistant", content: assistantContentParts, id: invocationId }],
    });
  }
}
