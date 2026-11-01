import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  Coordinate,
  ComputerUseArgs,
  ComputerUseError,
  ComputerUseResult,
  ComputerUseSuccess,
  MouseButton,
} from "../packages/proto/generated/agent/v1/computer_use_tool_pb.js";

export interface AgentWindowEnvironment {
  readonly windowIndex: number;
  readonly baseDir: string;
  readonly workspaceDir: string;
  readonly tmpDir: string;
  readonly profileDir: string;
  readonly cdpPort: number;
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

class CdpSession {
  private ws: WebSocket | null = null;
  private idCounter = 1;
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private closed = false;

  constructor(private readonly wsUrl: string) {}

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("CDP WebSocket connection timeout"));
      }, 5000);

      socket.onopen = () => {
        clearTimeout(timer);
        this.ws = socket;
        resolve();
      };

      socket.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket error: ${String(event)}`));
      };

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data));
          if (parsed.id != null && this.pending.has(parsed.id)) {
            const entry = this.pending.get(parsed.id)!;
            this.pending.delete(parsed.id);
            if (parsed.error) entry.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            else entry.resolve(parsed.result);
          }
        } catch {}
      };

      socket.onclose = () => {
        this.closed = true;
        for (const entry of this.pending.values()) {
          entry.reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
      };
    });
  }

  async send(method: string, params: Record<string, any> = {}): Promise<any> {
    await this.connect();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP socket is not open");
    }
    const id = ++this.idCounter;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command ${method} timed out after 30s`));
        }
      }, 30000);
    });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.closed = true;
  }
}

export class AgentDesktopManager {
  private static instance: AgentDesktopManager | null = null;
  private readonly windows = new Map<number, AgentWindowEnvironment>();
  private readonly browserProcesses = new Map<number, ChildProcessWithoutNullStreams>();
  private readonly cdpSessions = new Map<number, CdpSession>();
  private readonly lastMousePosition = new Map<number, { x: number; y: number }>();
  private vncServer: Server | null = null;
  private readonly vncPort = 6080;

  static getInstance(): AgentDesktopManager {
    if (!this.instance) {
      this.instance = new AgentDesktopManager();
    }
    return this.instance;
  }

  constructor() {
    this.startVncWebServer();
  }

  private findChromiumPath(): string {
    const candidates = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return "msedge.exe";
  }

  getEnvironment(windowIndex = 1): AgentWindowEnvironment {
    const existing = this.windows.get(windowIndex);
    if (existing) return existing;

    const baseDir = path.join(homedir(), ".grokbot", "agent-boxes", `window-${windowIndex}`);
    const workspaceDir = path.join(baseDir, "workspace");
    const tmpDir = path.join(baseDir, "tmp");
    const profileDir = path.join(baseDir, "browser-profile");
    const cdpPort = 9222 + windowIndex;

    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(profileDir, { recursive: true });

    const env: AgentWindowEnvironment = {
      windowIndex,
      baseDir,
      workspaceDir,
      tmpDir,
      profileDir,
      cdpPort,
    };
    this.windows.set(windowIndex, env);
    return env;
  }

  async isCdpReady(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureAgentDesktop(windowIndex = 1, initialUrl = "https://web.whatsapp.com"): Promise<AgentWindowEnvironment> {
    const env = this.getEnvironment(windowIndex);
    if (await this.isCdpReady(env.cdpPort)) {
      return env;
    }

    const exe = this.findChromiumPath();
    const args = [
      `--remote-debugging-port=${env.cdpPort}`,
      `--user-data-dir=${env.profileDir}`,
      "--window-size=1280,800",
      `--window-position=${40 * (windowIndex - 1)},${40 * (windowIndex - 1)}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,OptimizationHints",
      initialUrl,
    ];

    const child = spawn(exe, args, {
      stdio: "pipe",
      detached: false,
      windowsHide: false,
    });
    this.browserProcesses.set(windowIndex, child);

    child.on("exit", () => {
      this.browserProcesses.delete(windowIndex);
      this.cdpSessions.get(windowIndex)?.close();
      this.cdpSessions.delete(windowIndex);
    });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await this.isCdpReady(env.cdpPort)) {
        return env;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return env;
  }

  private async getCdpSession(windowIndex = 1): Promise<CdpSession> {
    const env = await this.ensureAgentDesktop(windowIndex);
    const existing = this.cdpSessions.get(windowIndex);
    if (existing) return existing;

    const listRes = await fetch(`http://127.0.0.1:${env.cdpPort}/json/list`, {
      signal: AbortSignal.timeout(3000),
    });
    const targets = (await listRes.json()) as CdpTarget[];
    let pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);

    if (!pageTarget) {
      const newRes = await fetch(`http://127.0.0.1:${env.cdpPort}/json/new`, {
        method: "PUT",
        signal: AbortSignal.timeout(3000),
      });
      pageTarget = (await newRes.json()) as CdpTarget;
    }

    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error(`Unable to acquire CDP page session on port ${env.cdpPort}`);
    }

    const session = new CdpSession(pageTarget.webSocketDebuggerUrl);
    await session.connect();
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    this.cdpSessions.set(windowIndex, session);
    return session;
  }

  async captureScreenshot(windowIndex = 1): Promise<string> {
    const session = await this.getCdpSession(windowIndex);
    const shot = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    return shot.data;
  }

  async executeComputerUse(args: ComputerUseArgs, windowIndex = 1): Promise<ComputerUseResult> {
    const started = Date.now();
    try {
      await this.ensureAgentDesktop(windowIndex);
      const session = await this.getCdpSession(windowIndex);
      let lastScreenshot: string | undefined;
      const pos = this.lastMousePosition.get(windowIndex) ?? { x: 640, y: 400 };

      for (const item of args.actions) {
        const actionCase = item.action.case;
        const val = item.action.value as any;

        switch (actionCase) {
          case "screenshot": {
            lastScreenshot = await this.captureScreenshot(windowIndex);
            break;
          }
          case "mouseMove": {
            if (val?.coordinate) {
              pos.x = val.coordinate.x;
              pos.y = val.coordinate.y;
              this.lastMousePosition.set(windowIndex, pos);
              await session.send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: pos.x,
                y: pos.y,
              });
            }
            break;
          }
          case "click": {
            if (val?.coordinate) {
              pos.x = val.coordinate.x;
              pos.y = val.coordinate.y;
              this.lastMousePosition.set(windowIndex, pos);
            }
            const btnNum = val?.button ?? MouseButton.LEFT;
            const button = btnNum === MouseButton.RIGHT ? "right" : btnNum === MouseButton.MIDDLE ? "middle" : "left";
            const clickCount = Math.max(1, val?.count ?? 1);

            await session.send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: pos.x,
              y: pos.y,
              button,
              clickCount,
            });
            await session.send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: pos.x,
              y: pos.y,
              button,
              clickCount,
            });
            await new Promise((r) => setTimeout(r, 200));
            lastScreenshot = await this.captureScreenshot(windowIndex);
            break;
          }
          case "mouseDown": {
            const btnNum = val?.button ?? MouseButton.LEFT;
            const button = btnNum === MouseButton.RIGHT ? "right" : btnNum === MouseButton.MIDDLE ? "middle" : "left";
            await session.send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: pos.x,
              y: pos.y,
              button,
            });
            break;
          }
          case "mouseUp": {
            const btnNum = val?.button ?? MouseButton.LEFT;
            const button = btnNum === MouseButton.RIGHT ? "right" : btnNum === MouseButton.MIDDLE ? "middle" : "left";
            await session.send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: pos.x,
              y: pos.y,
              button,
            });
            break;
          }
          case "drag": {
            if (val?.coordinate) {
              pos.x = val.coordinate.x;
              pos.y = val.coordinate.y;
              this.lastMousePosition.set(windowIndex, pos);
              await session.send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: pos.x,
                y: pos.y,
                buttons: 1,
              });
            }
            break;
          }
          case "type": {
            const text = String(val?.text ?? "");
            if (text.length > 0) {
              await session.send("Input.insertText", { text });
              await new Promise((r) => setTimeout(r, 150));
              lastScreenshot = await this.captureScreenshot(windowIndex);
            }
            break;
          }
          case "key": {
            const key = String(val?.key ?? "");
            if (key) {
              await session.send("Input.dispatchKeyEvent", {
                type: "rawKeyDown",
                key,
                code: key,
              });
              await session.send("Input.dispatchKeyEvent", {
                type: "keyUp",
                key,
                code: key,
              });
              await new Promise((r) => setTimeout(r, 150));
              lastScreenshot = await this.captureScreenshot(windowIndex);
            }
            break;
          }
          case "scroll": {
            const deltaX = val?.deltaX ?? (val?.direction === 3 ? -100 : val?.direction === 4 ? 100 : 0);
            const deltaY = val?.deltaY ?? (val?.direction === 1 ? -100 : val?.direction === 2 ? 100 : 100);
            await session.send("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x: pos.x,
              y: pos.y,
              deltaX,
              deltaY,
            });
            await new Promise((r) => setTimeout(r, 150));
            lastScreenshot = await this.captureScreenshot(windowIndex);
            break;
          }
          case "wait": {
            const ms = Math.min(Math.max(val?.durationMs ?? 500, 100), 5000);
            await new Promise((r) => setTimeout(r, ms));
            break;
          }
        }
      }

      if (!lastScreenshot) {
        lastScreenshot = await this.captureScreenshot(windowIndex);
      }

      return new ComputerUseResult({
        result: {
          case: "success",
          value: new ComputerUseSuccess({
            actionCount: args.actions.length,
            durationMs: Date.now() - started,
            screenshot: lastScreenshot,
            cursorPosition: new Coordinate({ x: pos.x, y: pos.y }),
          }),
        },
      });
    } catch (error: any) {
      return new ComputerUseResult({
        result: {
          case: "error",
          value: new ComputerUseError({
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      });
    }
  }

  private startVncWebServer(): void {
    try {
      this.vncServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
          const windowIndex = Number.parseInt(url.searchParams.get("windowIndex") ?? "1", 10) || 1;

          if (url.pathname === "/frame") {
            const shot = await this.captureScreenshot(windowIndex).catch(() => "");
            if (!shot) {
              res.writeHead(503, { "content-type": "text/plain" });
              res.end("Waiting for desktop...");
              return;
            }
            const buf = Buffer.from(shot, "base64");
            res.writeHead(200, {
              "content-type": "image/png",
              "cache-control": "no-store, no-cache, must-revalidate",
              "content-length": buf.length,
            });
            res.end(buf);
            return;
          }

          if (url.pathname === "/navigate") {
            const target = url.searchParams.get("url") || "https://web.whatsapp.com";
            const session = await this.getCdpSession(windowIndex);
            await session.send("Page.navigate", { url: target });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, navigatedTo: target }));
            return;
          }

          if (url.pathname === "/action" && req.method === "POST") {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", async () => {
              try {
                const data = JSON.parse(body);
                const session = await this.getCdpSession(windowIndex);
                if (data.type === "click") {
                  await session.send("Input.dispatchMouseEvent", {
                    type: "mousePressed",
                    x: data.x,
                    y: data.y,
                    button: "left",
                    clickCount: 1,
                  });
                  await session.send("Input.dispatchMouseEvent", {
                    type: "mouseReleased",
                    x: data.x,
                    y: data.y,
                    button: "left",
                    clickCount: 1,
                  });
                } else if (data.type === "type") {
                  await session.send("Input.insertText", { text: data.text });
                } else if (data.type === "key") {
                  await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: data.key });
                  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: data.key });
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
              } catch (e: any) {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: e.message }));
              }
            });
            return;
          }

          // Default: interactive HTML5 Live Desktop canvas
          const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>Agent Virtual Desktop (Window ${windowIndex})</title>
  <style>
    body { margin: 0; background: #121316; color: #e4e6eb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; height: 100vh; overflow: hidden; }
    #toolbar { width: 100%; max-width: 1280px; box-sizing: border-box; background: #1f232a; padding: 8px 12px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #2e3440; }
    #toolbar input { flex: 1; background: #121316; border: 1px solid #3b4252; color: #eceff4; padding: 6px 10px; border-radius: 4px; font-size: 13px; }
    #toolbar button { background: #4c566a; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500; }
    #toolbar button:hover { background: #5e81ac; }
    #screen-wrap { flex: 1; width: 100%; display: flex; justify-content: center; align-items: center; padding: 8px; box-sizing: border-box; }
    canvas { background: #000; border-radius: 6px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); cursor: crosshair; max-width: 100%; max-height: calc(100vh - 60px); }
  </style>
</head>
<body>
  <div id="toolbar">
    <span style="font-weight: 600; font-size: 13px;">Agent Desktop #${windowIndex}</span>
    <input id="urlInput" value="https://web.whatsapp.com" placeholder="Inserisci URL..." />
    <button onclick="navigate()">Vai</button>
    <button onclick="navigate('https://web.whatsapp.com')">WhatsApp Web</button>
    <button onclick="refresh()">Aggiorna</button>
  </div>
  <div id="screen-wrap">
    <canvas id="screen" width="1280" height="800"></canvas>
  </div>
  <script>
    const canvas = document.getElementById("screen");
    const ctx = canvas.getContext("2d");
    const img = new Image();
    let updating = false;

    function refresh() {
      if (updating) return;
      updating = true;
      img.src = "/frame?windowIndex=${windowIndex}&t=" + Date.now();
    }
    img.onload = () => {
      ctx.drawImage(img, 0, 0, 1280, 800);
      updating = false;
    };
    img.onerror = () => { updating = false; };
    setInterval(refresh, 600);
    refresh();

    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = 1280 / rect.width;
      const scaleY = 800 / rect.height;
      const x = Math.round((e.clientX - rect.left) * scaleX);
      const y = Math.round((e.clientY - rect.top) * scaleY);
      fetch("/action?windowIndex=${windowIndex}", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "click", x, y })
      }).then(() => setTimeout(refresh, 100));
    });

    window.addEventListener("keydown", (e) => {
      if (document.activeElement === document.getElementById("urlInput")) return;
      fetch("/action?windowIndex=${windowIndex}", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "key", key: e.key })
      }).then(() => setTimeout(refresh, 100));
    });

    function navigate(url) {
      const target = url || document.getElementById("urlInput").value;
      fetch("/navigate?windowIndex=${windowIndex}&url=" + encodeURIComponent(target))
        .then(() => setTimeout(refresh, 500));
    }
  </script>
</body>
</html>`;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (e: any) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(String(e?.message ?? e));
        }
      });

      this.vncServer.listen(this.vncPort, "127.0.0.1", () => {
        // Listening on 6080
      });
      this.vncServer.on("error", () => {});
    } catch {}
  }
}
