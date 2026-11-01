export interface KeyStats {
  key: string;
  maskedKey: string;
  cooldownUntil: number;
  isCoolingDown: boolean;
  rpmCurrent: number;
  totalRequests: number;
  totalSuccesses: number;
  consecutiveErrors: number;
}

export class ApiKeyPool {
  private keys: string[] = [];
  private currentIndex = 0;
  private readonly keyState = new Map<
    string,
    {
      cooldownUntil: number;
      recentRequests: number[];
      totalRequests: number;
      totalSuccesses: number;
      consecutiveErrors: number;
    }
  >();
  private readonly maxRpm: number;
  private readonly defaultCooldownMs: number;

  constructor(options?: {
    keys?: string[];
    maxRpm?: number;
    defaultCooldownMs?: number;
  }) {
    this.maxRpm = options?.maxRpm ?? 30;
    this.defaultCooldownMs = options?.defaultCooldownMs ?? 65_000;

    const initialKeys =
      options?.keys && options.keys.length > 0
        ? options.keys
        : this.resolveKeysFromEnvironment();

    this.setKeys(initialKeys);
  }

  private resolveKeysFromEnvironment(): string[] {
    let rawKeys =
      process.env.GEMINI_FREE_API_KEYS?.trim() ||
      process.env.GEMINI_API_KEYS?.trim() ||
      process.env.GEMINI_API_KEY?.trim() ||
      "";

    if (!rawKeys) {
      try {
        const { homedir } = require("node:os");
        const { join } = require("node:path");
        const { existsSync, readFileSync } = require("node:fs");

        // Check box-secrets.json
        const boxSecretsPath = join(homedir(), ".grokbot", "box-secrets.json");
        if (existsSync(boxSecretsPath)) {
          try {
            const parsed = JSON.parse(readFileSync(boxSecretsPath, "utf8"));
            const s = parsed?.secrets;
            if (s && typeof s === "object") {
              const val = s.GEMINI_FREE_API_KEYS || s.GEMINI_API_KEYS || s.GEMINI_API_KEY;
              if (typeof val === "string" && val.trim().length > 0) {
                rawKeys = val.trim();
              }
            }
          } catch {}
        }

        if (!rawKeys) {
          const candidates = [
            join(process.cwd(), ".env"),
            join(homedir(), ".grokbot", ".env"),
            join(homedir(), ".cursor", ".env"),
          ];
          for (const candidate of candidates) {
            if (!existsSync(candidate)) continue;
            const content = readFileSync(candidate, "utf8");
            for (const line of content.split(/\r?\n/)) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("#")) continue;
              const eq = trimmed.indexOf("=");
              if (eq > 0) {
                const key = trimmed.slice(0, eq).trim();
                let val = trimmed.slice(eq + 1).trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                  val = val.slice(1, -1);
                }
                if ((key === "GEMINI_FREE_API_KEYS" || key === "GEMINI_API_KEYS" || key === "GEMINI_API_KEY") && val) {
                  rawKeys = val;
                  break;
                }
              }
            }
            if (rawKeys) break;
          }
        }
      } catch {}
    }

    if (!rawKeys) return [];

    return rawKeys
      .split(/[,;\s]+/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
  }

  setKeys(keys: string[]): void {
    const unique = Array.from(new Set(keys.filter((k) => typeof k === "string" && k.trim().length > 0)));
    this.keys = unique;
    for (const key of unique) {
      if (!this.keyState.has(key)) {
        this.keyState.set(key, {
          cooldownUntil: 0,
          recentRequests: [],
          totalRequests: 0,
          totalSuccesses: 0,
          consecutiveErrors: 0,
        });
      }
    }
    // Remove stale states
    for (const k of this.keyState.keys()) {
      if (!unique.includes(k)) this.keyState.delete(k);
    }
    this.currentIndex = 0;
  }

  addKey(key: string): void {
    const trimmed = key.trim();
    if (!trimmed || this.keys.includes(trimmed)) return;
    this.keys.push(trimmed);
    this.keyState.set(trimmed, {
      cooldownUntil: 0,
      recentRequests: [],
      totalRequests: 0,
      totalSuccesses: 0,
      consecutiveErrors: 0,
    });
  }

  private pruneRecentRequests(state: { recentRequests: number[] }, now: number): void {
    const cutoff = now - 60_000;
    while (state.recentRequests.length > 0 && state.recentRequests[0]! < cutoff) {
      state.recentRequests.shift();
    }
  }

  getNextKey(): string {
    if (this.keys.length === 0) {
      throw new Error(
        "ApiKeyPool has no keys configured. Add GEMINI_FREE_API_KEYS in .env or Settings.",
      );
    }

    const now = Date.now();

    // Clean sliding window for all keys
    for (const key of this.keys) {
      const state = this.keyState.get(key);
      if (state) this.pruneRecentRequests(state, now);
    }

    // 1. Find candidates that are NOT in cooldown and NOT exceeding RPM
    const healthyCandidates = this.keys.filter((k) => {
      const s = this.keyState.get(k);
      if (!s) return false;
      return s.cooldownUntil <= now && s.recentRequests.length < this.maxRpm;
    });

    if (healthyCandidates.length > 0) {
      // Pick via round-robin among healthy candidates
      const key = healthyCandidates[this.currentIndex % healthyCandidates.length]!;
      this.currentIndex = (this.currentIndex + 1) % healthyCandidates.length;

      const state = this.keyState.get(key)!;
      state.recentRequests.push(now);
      state.totalRequests += 1;
      return key;
    }

    // 2. Next fallback: candidates not in cooldown, even if approaching RPM limit
    const nonCooling = this.keys.filter((k) => {
      const s = this.keyState.get(k);
      return s ? s.cooldownUntil <= now : false;
    });

    if (nonCooling.length > 0) {
      // Pick candidate with smallest number of recent requests
      nonCooling.sort((a, b) => {
        const sa = this.keyState.get(a)!.recentRequests.length;
        const sb = this.keyState.get(b)!.recentRequests.length;
        return sa - sb;
      });
      const key = nonCooling[0]!;
      const state = this.keyState.get(key)!;
      state.recentRequests.push(now);
      state.totalRequests += 1;
      return key;
    }

    // 3. All keys are in cooldown: pick the one whose cooldown expires earliest
    const sorted = [...this.keys].sort((a, b) => {
      const ca = this.keyState.get(a)?.cooldownUntil ?? 0;
      const cb = this.keyState.get(b)?.cooldownUntil ?? 0;
      return ca - cb;
    });

    const bestKey = sorted[0]!;
    const state = this.keyState.get(bestKey)!;
    state.recentRequests.push(now);
    state.totalRequests += 1;
    return bestKey;
  }

  recordSuccess(key: string): void {
    const state = this.keyState.get(key);
    if (!state) return;
    state.consecutiveErrors = 0;
    state.totalSuccesses += 1;
  }

  recordRateLimit(key: string, cooldownMs?: number): void {
    const state = this.keyState.get(key);
    if (!state) return;
    const cooldown = cooldownMs ?? this.defaultCooldownMs;
    state.cooldownUntil = Date.now() + cooldown;
    state.consecutiveErrors += 1;
    console.warn(
      `[ApiKeyPool] Key ${this.maskKey(key)} hit 429 rate limit. Cooling down for ${Math.round(cooldown / 1000)}s until ${new Date(state.cooldownUntil).toISOString()}`,
    );
  }

  recordError(key: string, status?: number): void {
    if (status === 429) {
      this.recordRateLimit(key);
      return;
    }
    const state = this.keyState.get(key);
    if (!state) return;
    state.consecutiveErrors += 1;
  }

  private maskKey(k: string): string {
    if (!k || k.length < 8) return "***";
    return `${k.slice(0, 4)}...${k.slice(-4)}`;
  }

  getStatus(): {
    totalKeys: number;
    activeKeys: number;
    coolingKeys: number;
    keys: KeyStats[];
  } {
    const now = Date.now();
    const stats: KeyStats[] = this.keys.map((key) => {
      const s = this.keyState.get(key) ?? {
        cooldownUntil: 0,
        recentRequests: [],
        totalRequests: 0,
        totalSuccesses: 0,
        consecutiveErrors: 0,
      };
      this.pruneRecentRequests(s, now);
      const isCooling = s.cooldownUntil > now;
      return {
        key,
        maskedKey: this.maskKey(key),
        cooldownUntil: s.cooldownUntil,
        isCoolingDown: isCooling,
        rpmCurrent: s.recentRequests.length,
        totalRequests: s.totalRequests,
        totalSuccesses: s.totalSuccesses,
        consecutiveErrors: s.consecutiveErrors,
      };
    });

    const activeKeys = stats.filter((s) => !s.isCoolingDown).length;
    const coolingKeys = stats.filter((s) => s.isCoolingDown).length;

    return {
      totalKeys: this.keys.length,
      activeKeys,
      coolingKeys,
      keys: stats,
    };
  }
}
