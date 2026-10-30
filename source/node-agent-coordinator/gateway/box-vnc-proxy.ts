import {
  SAND_BOX_FORK_NOVNC_PORT,
  SAND_BOX_PRIMARY_NOVNC_PORT,
  buildSandBoxNoVncUrl,
  isSandSpecialTreatmentNoVncUrl
} from "../../packages/constants/sand-box.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export interface VncProxyDescriptor {
  primaryUrl: string;
  forkBaseUrl: string;
  networkToken: string;
}

export interface ForeverBoxWindowStatus {
  vncUrl: string;
  [key: string]: unknown;
}

export interface ForeverBoxStatus {
  vncUrl?: string | null;
  windows?: ForeverBoxWindowStatus[] | null;
  [key: string]: unknown;
}

export function getAgentVncOffset(agentId?: string): number {
  if (!agentId || agentId === "default") return 0;
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash) + agentId.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % 50) * 10;
}

export function proxifyBoxVncUrl(vncUrl: string, vncProxy: VncProxyDescriptor, agentId?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(vncUrl);
  } catch {
    return vncUrl;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname) || !parsed.pathname.endsWith("/vnc.html")) return vncUrl;
  const port = Number.parseInt(parsed.port, 10);
  const offset = getAgentVncOffset(agentId);
  if (port === SAND_BOX_PRIMARY_NOVNC_PORT || (port >= SAND_BOX_PRIMARY_NOVNC_PORT && port < SAND_BOX_PRIMARY_NOVNC_PORT + 500)) {
    if (offset > 0) return `http://127.0.0.1:${SAND_BOX_PRIMARY_NOVNC_PORT + offset}/vnc.html`;
    return vncProxy.primaryUrl;
  }
  if (port === SAND_BOX_FORK_NOVNC_PORT || (port >= SAND_BOX_FORK_NOVNC_PORT && port < SAND_BOX_FORK_NOVNC_PORT + 500)) {
    if (offset > 0) return `http://127.0.0.1:${SAND_BOX_FORK_NOVNC_PORT + offset}/vnc.html`;
    return buildSandBoxNoVncUrl(vncProxy.forkBaseUrl, vncProxy.networkToken, forkDisplayToken(parsed), isSandSpecialTreatmentNoVncUrl(vncProxy.primaryUrl));
  }
  return vncUrl;
}

function forkDisplayToken(parsed: URL): string | undefined {
  const path = parsed.searchParams.get("path");
  const queryIndex = path?.indexOf("?") ?? -1;
  if (path == null || queryIndex < 0) return undefined;
  const token = new URLSearchParams(path.slice(queryIndex + 1)).get("token");
  return token != null && token.length > 0 ? token : undefined;
}

export function proxifyForeverBoxStatus<T extends ForeverBoxStatus>(status: T, vncProxy: VncProxyDescriptor | null, agentId?: string): T {
  if (vncProxy == null) return status;
  const proxified = { ...status, vncUrl: status.vncUrl != null ? proxifyBoxVncUrl(status.vncUrl, vncProxy, agentId) : status.vncUrl };
  if (status.windows == null) return proxified as T;
  return { ...proxified, windows: status.windows.map((window) => ({ ...window, vncUrl: proxifyBoxVncUrl(window.vncUrl, vncProxy, agentId) })) } as T;
}
