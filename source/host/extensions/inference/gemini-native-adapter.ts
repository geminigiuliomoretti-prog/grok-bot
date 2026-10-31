import { randomUUID } from "node:crypto";

export interface UsageRecord {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface GeminiNativeStreamOptions {
  apiKey: string;
  messages: readonly any[];
  systemPrompt?: string | undefined;
  definitions?: readonly any[] | undefined;
  invocationId?: string | undefined;
  isSummarization?: boolean | undefined;
  preferredModel?: string | undefined;
  onUsage?: ((usage: UsageRecord) => void) | undefined;
}

export interface StreamChunkTextDelta {
  type: "text-delta";
  textDelta: string;
}

export interface StreamChunkReasoning {
  type: "reasoning";
  textDelta: string;
}

export interface StreamChunkToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: any;
}

export type StreamChunk = StreamChunkTextDelta | StreamChunkReasoning | StreamChunkToolCall;

const PRIMARY_MODELS = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.5-flash"];
const SUMMARIZATION_MODELS = ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash"];

function deferred<T>() {
  return Promise.withResolvers<T>();
}

export function sanitizeGeminiSchema(schema: any): any {
  if (schema == null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);

  const unwrapped = schema.jsonSchema ?? schema;
  const result: Record<string, any> = {};

  if (typeof unwrapped.type === "string") {
    result.type = unwrapped.type.toUpperCase();
  }

  if (typeof unwrapped.description === "string") {
    result.description = unwrapped.description;
  }

  if (Array.isArray(unwrapped.enum)) {
    result.enum = unwrapped.enum;
  }

  if (Array.isArray(unwrapped.required)) {
    result.required = unwrapped.required;
  }

  if (unwrapped.properties && typeof unwrapped.properties === "object") {
    result.properties = {};
    for (const [k, v] of Object.entries(unwrapped.properties)) {
      result.properties[k] = sanitizeGeminiSchema(v);
    }
  }

  if (unwrapped.items && typeof unwrapped.items === "object") {
    result.items = sanitizeGeminiSchema(unwrapped.items);
  }

  return result;
}

export function convertMessagesToGeminiContents(
  messages: readonly any[],
  baseSystemPrompt?: string,
): { systemInstruction?: string | undefined; contents: any[] } {
  const systemTexts: string[] = [];
  if (baseSystemPrompt && baseSystemPrompt.trim().length > 0) {
    systemTexts.push(baseSystemPrompt.trim());
  }

  const rawContents: any[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      if (text.trim().length > 0) systemTexts.push(text.trim());
      continue;
    }

    if (msg.role === "user") {
      const parts: any[] = [];
      if (typeof msg.content === "string") {
        if (msg.content.length > 0) parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text" && typeof part.text === "string") {
            parts.push({ text: part.text });
          } else if (part.type === "image" && part.image) {
            parts.push({ inlineData: { mimeType: part.mimeType || "image/png", data: part.image } });
          }
        }
      }
      if (parts.length === 0) parts.push({ text: " " });
      rawContents.push({ role: "user", parts });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: any[] = [];
      if (typeof msg.content === "string") {
        if (msg.content.length > 0) parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
            parts.push({ text: part.text });
          } else if (part.type === "tool-call") {
            const args = typeof part.args === "string" ? JSON.parse(part.args) : (part.args ?? {});
            parts.push({
              functionCall: {
                name: part.toolName,
                args,
                ...(part.toolCallId ? { id: part.toolCallId } : {}),
              },
            });
          }
        }
      }
      if (parts.length === 0) parts.push({ text: " " });
      rawContents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "tool") {
      const parts: any[] = [];
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === "tool-result") {
            parts.push({
              functionResponse: {
                name: item.toolName || "tool",
                response: { output: item.result ?? item.output ?? "" },
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
      if (parts.length === 0) {
        parts.push({ functionResponse: { name: "tool", response: { output: "" } } });
      }
      rawContents.push({ role: "user", parts });
    }
  }

  // Gemini requires strictly alternating roles (user, model, user, model...). Merge consecutive matching roles.
  const contents: any[] = [];
  for (const item of rawContents) {
    const prev = contents.at(-1);
    if (prev && prev.role === item.role) {
      prev.parts.push(...item.parts);
    } else {
      contents.push({ role: item.role, parts: [...item.parts] });
    }
  }

  // If first message is model, prepend an empty user message
  if (contents.length > 0 && contents[0].role === "model") {
    contents.unshift({ role: "user", parts: [{ text: "Hello" }] });
  }

  return {
    systemInstruction: systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined,
    contents,
  };
}

export function executeGeminiNativeStream(options: GeminiNativeStreamOptions) {
  const invocationId = options.invocationId ?? randomUUID();
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<any>();
  const metadata = deferred<Record<string, unknown>>();

  const candidateModels = options.isSummarization
    ? SUMMARIZATION_MODELS
    : options.preferredModel
      ? [options.preferredModel, ...PRIMARY_MODELS.filter(m => m !== options.preferredModel)]
      : PRIMARY_MODELS;

  const functionDeclarations: any[] = [];
  let supportsSendMessage = false;
  if (options.definitions && options.definitions.length > 0) {
    for (const def of options.definitions) {
      if (!def || typeof def.name !== "string" || def.name.length === 0) continue;
      if (def.name.toLowerCase() === "sendmessage") supportsSendMessage = true;
      const rawParams = def.inputSchema ?? def.parameters?.jsonSchema ?? def.parameters;
      const parameters = rawParams ? sanitizeGeminiSchema(rawParams) : { type: "OBJECT", properties: {} };
      functionDeclarations.push({
        name: def.name,
        ...(typeof def.description === "string" ? { description: def.description } : {}),
        parameters,
      });
    }
  }

  const { systemInstruction, contents } = convertMessagesToGeminiContents(options.messages, options.systemPrompt);

  const fullStream = (async function* () {
    let plainText = "";
    let reasoningText = "";
    let hasEmittedToolCall = false;
    const assistantContentParts: any[] = [];
    let actualModelUsed = candidateModels[0];
    let streamSucceeded = false;
    let lastError: unknown;

    for (const model of candidateModels) {
      actualModelUsed = model;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
      const requestBody: Record<string, any> = { contents };

      if (systemInstruction) {
        requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
      }

      if (functionDeclarations.length > 0) {
        requestBody.tools = [{ functionDeclarations }];
      }

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": options.apiKey,
          },
          body: JSON.stringify(requestBody),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          if (res.status === 404 || res.status === 429 || res.status === 503) {
            console.warn(`[gemini-native] Model ${model} returned ${res.status}: ${errText.slice(0, 100)}. Falling back to next model.`);
            lastError = new Error(`Model ${model} returned ${res.status}: ${errText}`);
            continue;
          }
          throw new Error(`Gemini API error (${res.status} ${res.statusText}): ${errText}`);
        }

        if (!res.body) {
          throw new Error(`Gemini response body was empty for ${model}`);
        }

        let buffer = "";
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
                if (part.thought === true && typeof part.text === "string") {
                  reasoningText += part.text;
                  yield { type: "reasoning" as const, textDelta: part.text };
                } else if (typeof part.text === "string" && part.text.length > 0) {
                  plainText += part.text;
                  yield { type: "text-delta" as const, textDelta: part.text };
                } else if (part.functionCall) {
                  hasEmittedToolCall = true;
                  const toolName = part.functionCall.name;
                  const toolCallId = part.functionCall.id || `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
                  const args = part.functionCall.args ?? {};

                  // Normalization for SendMessage: Zod schema requires { type: "text", content: string }
                  if (typeof toolName === "string" && toolName.toLowerCase() === "sendmessage") {
                    if (args && typeof args === "object") {
                      if (!args.type) args.type = "text";
                      if (args.message && !args.content) args.content = args.message;
                    }
                  }

                  assistantContentParts.push({
                    type: "tool-call",
                    toolCallId,
                    toolName,
                    args,
                  });

                  yield {
                    type: "tool-call" as const,
                    toolCallId,
                    toolName,
                    args,
                  };
                }
              }
            }
          }
        }

        // Process any remainder in buffer
        if (buffer.trim().startsWith("data:")) {
          try {
            const parsed = JSON.parse(buffer.trim().slice(5).trim());
            if (parsed.usageMetadata) {
              promptTokens = parsed.usageMetadata.promptTokenCount ?? promptTokens;
              completionTokens = parsed.usageMetadata.candidatesTokenCount ?? completionTokens;
              totalTokens = parsed.usageMetadata.totalTokenCount ?? (promptTokens + completionTokens);
            }
          } catch {}
        }

        // LEVEL 1 AUTO-SYNTHESIS:
        // If no tool call was emitted, plainText was generated, and SendMessage is an available tool:
        // Automatically synthesize a SendMessage tool call so Grok Bot delivers it to the user.
        if (!hasEmittedToolCall && plainText.trim().length > 0 && supportsSendMessage) {
          const synthId = `call_synth_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
          const synthArgs = { type: "text", content: plainText.trim() };
          assistantContentParts.push({
            type: "tool-call",
            toolCallId: synthId,
            toolName: "SendMessage",
            args: synthArgs,
          });
          yield {
            type: "tool-call" as const,
            toolCallId: synthId,
            toolName: "SendMessage",
            args: synthArgs,
          };
          hasEmittedToolCall = true;
        }

        // Build assistant content for final model response
        const finalContentParts: any[] = [];
        if (reasoningText.length > 0) {
          finalContentParts.push({ type: "reasoning", text: reasoningText });
        }
        if (plainText.length > 0) {
          finalContentParts.push({ type: "text", text: plainText });
        }
        for (const part of assistantContentParts) {
          finalContentParts.push(part);
        }

        const usageRecord: UsageRecord = {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        options.onUsage?.(usageRecord);

        usage.resolve({
          promptTokens,
          completionTokens,
          totalTokens,
        });

        extendedUsage.resolve({
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          maxTokens: 0,
        });

        metadata.resolve({
          gemini: {
            model: actualModelUsed,
            direct: true,
          },
        });

        resultResponse.resolve({
          id: invocationId,
          modelId: actualModelUsed,
          timestamp: new Date(),
          headers: {},
          messages: [
            {
              role: "assistant",
              content: finalContentParts,
              id: invocationId,
            },
          ],
        });

        streamSucceeded = true;
        break;
      } catch (err) {
        lastError = err;
        console.warn(`[gemini-native] Attempt with ${model} failed:`, err);
      }
    }

    if (!streamSucceeded) {
      const finalError = lastError instanceof Error ? lastError : new Error(String(lastError ?? "Gemini streaming failed"));
      usage.reject(finalError);
      extendedUsage.reject(finalError);
      metadata.reject(finalError);
      resultResponse.reject(finalError);
      throw finalError;
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
