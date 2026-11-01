import { CoordinateNormalizer, AGENT_DESKTOP_DEFAULT } from "./coordinate-normalizer.js";

export interface ToolValidationResult {
  valid: boolean;
  healedArgs: any;
  error?: string | undefined;
}

export class ToolSchemaValidator {
  private readonly normalizer = new CoordinateNormalizer(AGENT_DESKTOP_DEFAULT);

  /**
   * Attempt lenient parsing of malformed JSON emitted by LLMs (trailing commas, markdown fences, unclosed brackets).
   */
  parseLenientJson(input: unknown): any {
    if (typeof input !== "string") return input ?? {};
    const trimmed = input.trim();
    if (!trimmed) return {};

    // If it's plain text not resembling JSON object/array/quoted string, return raw text
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith('"') && !trimmed.startsWith("`")) {
      return trimmed;
    }

    // 1. Strip markdown fences if present
    let cleaned = trimmed;
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      if (!cleaned.startsWith("{") && !cleaned.startsWith("[") && !cleaned.startsWith('"')) {
        return cleaned;
      }
    }

    // 2. Direct JSON.parse
    try {
      return JSON.parse(cleaned);
    } catch {}

    // 3. Remove trailing commas in objects and arrays
    cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

    // 4. Try re-parsing after trailing comma removal
    try {
      return JSON.parse(cleaned);
    } catch {}

    // 5. Auto-close open strings, braces, or brackets
    let openBraces = 0;
    let openBrackets = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (char === "\\") {
        escapeNext = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === "{") openBraces++;
        else if (char === "}") openBraces = Math.max(0, openBraces - 1);
        else if (char === "[") openBrackets++;
        else if (char === "]") openBrackets = Math.max(0, openBrackets - 1);
      }
    }

    if (inString) cleaned += '"';
    while (openBrackets > 0) {
      cleaned += "]";
      openBrackets--;
    }
    while (openBraces > 0) {
      cleaned += "}";
      openBraces--;
    }

    try {
      return JSON.parse(cleaned);
    } catch {
      return { raw: input };
    }
  }

  /**
   * Validates and auto-heals arguments for high-frequency agentic tools.
   */
  validateAndHeal(toolName: string, rawArgs: unknown): ToolValidationResult {
    const parsed = typeof rawArgs === "string" ? this.parseLenientJson(rawArgs) : (rawArgs ?? {});
    const normName = (toolName || "").toLowerCase().replace(/[-_:]/g, "");

    // 1. SendMessage Tool
    if (normName === "sendmessage" || normName.endsWith("sendmessage")) {
      let content = "";
      if (typeof parsed === "string") {
        content = parsed;
      } else if (typeof parsed.raw === "string") {
        content = parsed.raw;
      } else if (typeof parsed.content === "string") {
        content = parsed.content;
      } else if (typeof parsed.message === "string") {
        content = parsed.message;
      } else if (typeof parsed.text === "string") {
        content = parsed.text;
      } else if (typeof parsed.msg === "string") {
        content = parsed.msg;
      } else {
        content = JSON.stringify(parsed);
      }

      return {
        valid: true,
        healedArgs: {
          type: "text",
          content: content.trim(),
        },
      };
    }

    // 2. ExternalShell / BoxShell / Shell Tools
    if (
      normName === "externalshell" ||
      normName === "boxshell" ||
      normName === "shell" ||
      normName.endsWith("externalshell") ||
      normName.endsWith("boxshell")
    ) {
      let command = "";
      if (typeof parsed === "string") {
        command = parsed;
      } else if (typeof parsed.command === "string") {
        command = parsed.command;
      } else if (typeof parsed.cmd === "string") {
        command = parsed.cmd;
      } else if (typeof parsed.script === "string") {
        command = parsed.script;
      }

      if (!command) {
        return {
          valid: false,
          healedArgs: { command: "" },
          error: "Tool ExternalShell requires non-empty string argument 'command'.",
        };
      }

      return {
        valid: true,
        healedArgs: { command },
      };
    }

    // 3. TodoWrite Tool
    if (normName === "todowrite" || normName.endsWith("todowrite")) {
      let todos: any[] = [];
      if (Array.isArray(parsed)) {
        todos = parsed;
      } else if (Array.isArray(parsed.todos)) {
        todos = parsed.todos;
      } else if (Array.isArray(parsed.tasks)) {
        todos = parsed.tasks;
      } else if (parsed.todo) {
        todos = [parsed.todo];
      }

      const healedTodos = todos.map((item, idx) => {
        if (typeof item === "string") {
          return { id: `task-${idx + 1}`, title: item, status: "pending" };
        }
        return {
          id: item.id || `task-${idx + 1}`,
          title: item.title || item.task || item.description || `Task ${idx + 1}`,
          status: item.status || "pending",
        };
      });

      return {
        valid: true,
        healedArgs: { todos: healedTodos },
      };
    }

    // 4. Task Subagent Tool
    if (normName === "task" || normName.endsWith("task")) {
      const prompt =
        typeof parsed.prompt === "string"
          ? parsed.prompt
          : typeof parsed.task === "string"
            ? parsed.task
            : typeof parsed.description === "string"
              ? parsed.description
              : "";

      const subagent_type =
        typeof parsed.subagent_type === "string"
          ? parsed.subagent_type
          : typeof parsed.type === "string"
            ? parsed.type
            : "generalPurpose";

      return {
        valid: prompt.trim().length > 0,
        healedArgs: {
          ...parsed,
          prompt,
          subagent_type,
        },
        error: prompt.trim().length === 0 ? "Task requires a non-empty 'prompt' description." : undefined,
      };
    }

    // 5. ComputerUse / Click / Mouse Actions with Coordinate Normalization
    if (
      normName === "computer" ||
      normName === "computeruse" ||
      normName.includes("click") ||
      normName.includes("mouse")
    ) {
      if (parsed.coordinate && typeof parsed.coordinate === "object") {
        const denorm = this.normalizer.denormalize(parsed.coordinate);
        parsed.coordinate = denorm;
      } else if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        const denorm = this.normalizer.denormalize({ x: parsed.x, y: parsed.y });
        parsed.x = denorm.x;
        parsed.y = denorm.y;
      }
      return { valid: true, healedArgs: parsed };
    }

    // Default: pass through leniently parsed JSON
    return {
      valid: true,
      healedArgs: parsed,
    };
  }
}
