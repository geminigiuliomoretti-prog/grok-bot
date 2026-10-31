/**
 * Offline Network Guard
 * Short-circuits any residual HTTP/fetch calls to *.cursor.sh and inactive Linux container ports
 * returning an instant (<1ms) 200 OK JSON response without touching the network.
 */

const BLOCKED_DOMAINS = [
  "api2.cursor.sh",
  "api3.cursor.sh",
  "api4.cursor.sh",
  "api5.cursor.sh",
  "agent.api5.cursor.sh",
  "repo42.cursor.sh",
  "authenticate.cursor.sh",
  "marketplace.cursorapi.com",
  "cursor.sh",
  "cursorapi.com",
  "cursor-cdn.com",
];

const BLOCKED_LOCAL_PORTS = new Set(["26500", "1339", "6081"]);

export function isBlockedUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();
    for (const domain of BLOCKED_DOMAINS) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        return true;
      }
    }
    if ((hostname === "127.0.0.1" || hostname === "localhost") && BLOCKED_LOCAL_PORTS.has(url.port)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function installNetworkOfflineGuard(): void {
  const originalFetch = globalThis.fetch;
  if ((originalFetch as any)?.__offlineGuardInstalled) return;

  const guardedFetch: typeof fetch = async (input, init) => {
    let urlString = "";
    if (typeof input === "string") {
      urlString = input;
    } else if (input instanceof URL) {
      urlString = input.toString();
    } else if (input && typeof (input as any).url === "string") {
      urlString = (input as any).url;
    }

    if (isBlockedUrl(urlString)) {
      return new Response(JSON.stringify({}), {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "application/json",
          "x-offline-guard": "true",
        },
      });
    }

    return await originalFetch(input, init);
  };

  (guardedFetch as any).__offlineGuardInstalled = true;
  globalThis.fetch = guardedFetch;
}
