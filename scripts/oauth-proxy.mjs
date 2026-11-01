import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const OAUTH_CREDS_PATH = join(homedir(), ".gemini", "oauth_creds.json");

interface OAuthCreds {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
  expiry_date?: number;
  client_id?: string;
  client_secret?: string;
}

function loadCreds(): OAuthCreds | null {
  if (!existsSync(OAUTH_CREDS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(OAUTH_CREDS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveCreds(creds: OAuthCreds): void {
  try {
    writeFileSync(OAUTH_CREDS_PATH, JSON.stringify(creds, null, 2), "utf8");
  } catch (e) {
    console.warn("[oauth-proxy] Failed to persist refreshed creds:", e);
  }
}

async function getValidAccessToken(): Promise<string | null> {
  const creds = loadCreds();
  if (!creds) return null;

  const now = Date.now();
  if (creds.access_token && creds.expiry_date && creds.expiry_date > now + 60_000) {
    return creds.access_token;
  }

  // Attempt refresh if refresh_token is present
  if (!creds.refresh_token) {
    return creds.access_token || null;
  }

  // Google CLI / Gemini public client_id
  const clientId = creds.client_id || process.env.GOOGLE_OAUTH_CLIENT_ID || "681255809395-ooimltobgcv3slsvqg0tqchllvdmi4bu.apps.googleusercontent.com";
  const clientSecret = creds.client_secret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";

  try {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
      client_id: clientId,
    });
    if (clientSecret) params.append("client_secret", clientSecret);

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (tokenRes.ok) {
      const data = await tokenRes.json();
      if (data.access_token) {
        creds.access_token = data.access_token;
        creds.expiry_date = Date.now() + (data.expires_in ?? 3600) * 1000;
        saveCreds(creds);
        console.log("[oauth-proxy] Successfully refreshed Google OAuth token");
        return creds.access_token;
      }
    }
  } catch (err: any) {
    console.warn("[oauth-proxy] Token refresh error:", err.message);
  }

  return creds.access_token || null;
}

const server = createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  // Health check endpoints
  if (url.pathname === "/health" || url.pathname === "/v1/models" || url.pathname === "/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        models: [
          { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (Google AI Pro OAuth)" },
          { id: "gemma-4-31b-it", name: "Gemma 4 31B IT" },
        ],
      }),
    );
    return;
  }

  const accessToken = await getValidAccessToken();

  let bodyBuf = Buffer.alloc(0);
  req.on("data", (chunk) => {
    bodyBuf = Buffer.concat([bodyBuf, chunk]);
  });

  req.on("end", async () => {
    try {
      // Determine destination target path
      let upstreamPath = url.pathname;
      if (upstreamPath.startsWith("/v1/")) {
        upstreamPath = upstreamPath.slice(3);
      }
      if (!upstreamPath.startsWith("/v1beta/")) {
        upstreamPath = `/v1beta${upstreamPath.startsWith("/") ? "" : "/"}${upstreamPath}`;
      }

      const upstreamUrl = new URL(
        upstreamPath + url.search,
        "https://generativelanguage.googleapis.com",
      );

      const headers: Record<string, string> = {
        "content-type": req.headers["content-type"] || "application/json",
      };

      if (accessToken) {
        headers["authorization"] = `Bearer ${accessToken}`;
      } else if (process.env.GEMINI_API_KEY) {
        headers["x-goog-api-key"] = process.env.GEMINI_API_KEY;
      }

      const upstreamRes = await fetch(upstreamUrl.toString(), {
        method: req.method || "POST",
        headers,
        body: bodyBuf.length > 0 ? bodyBuf : undefined,
      });

      res.writeHead(upstreamRes.status, {
        "content-type": upstreamRes.headers.get("content-type") || "application/json",
      });

      if (!upstreamRes.body) {
        res.end();
        return;
      }

      for await (const chunk of upstreamRes.body as any) {
        res.write(chunk);
      }
      res.end();
    } catch (err: any) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[oauth-proxy] Google Gemini OAuth Proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`[oauth-proxy] Credentials source: ${OAUTH_CREDS_PATH}`);
});
