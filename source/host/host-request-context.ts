import { release, type } from "node:os";
import { normalizeSandUserFullName } from "./sand-user-identity.js";
export function resolveTimeZone(): string | undefined { try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } }
export function createHostRequestContext(transcriptsFolder: string, resolveUserTimeZone: () => string | undefined = () => undefined, resolveRules: () => Promise<readonly unknown[]> = async () => [], resolveUserFullName: () => string | undefined = () => undefined) {
  return {
    resolve: () => {
      const userFullName = normalizeSandUserFullName(resolveUserFullName());
      const defaultShell = process.platform === "win32"
        ? "PowerShell (native PowerShell syntax; commands execute in a .ps1 script, do not wrap in powershell -Command)"
        : (process.env.SHELL || "bash");
      return {
        osVersion: `${type()} ${release()}`,
        shell: defaultShell,
        timeZone: resolveUserTimeZone() ?? resolveTimeZone(),
        transcriptsFolder,
        ...(userFullName == null ? {} : { userFullName })
      };
    },
    resolveRules
  };
}
