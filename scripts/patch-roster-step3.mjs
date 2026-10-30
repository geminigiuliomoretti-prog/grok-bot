import fs from 'node:fs';

let roster = fs.readFileSync('source/host/extensions/session/session-roster.ts', 'utf8');

// Import mkdirSync, writeFileSync from node:fs and join from node:path
if (!roster.includes('import { mkdirSync, writeFileSync, existsSync } from "node:fs";')) {
  roster = 'import { mkdirSync, writeFileSync, existsSync } from "node:fs";\nimport { join } from "node:path";\n' + roster;
}

// In listAgents, before returning:
// if (filtered.length === 0) -> create default agent directory and return default summary
const defaultAgentLogic = `
  const sortedSummaries = summaries.filter((value):value is Record<string,unknown>=>value!=null).sort((a,b)=>Number(b.updatedAt??0)-Number(a.updatedAt??0));
  if (sortedSummaries.length === 0) {
    const defaultAgentId = "default-grok-agent";
    const defaultAgentDir = join(host.rootDir, defaultAgentId);
    try {
      if (!existsSync(defaultAgentDir)) {
        mkdirSync(defaultAgentDir, { recursive: true });
        writeFileSync(join(defaultAgentDir, "profile.json"), JSON.stringify({
          name: "Grok Bot",
          description: "Default assistant",
          title: "Grok Bot",
          avatarColor: "blue",
          avatarShape: "circle"
        }, null, 2), "utf8");
      }
    } catch {}
    const defaultAgentDbPath = getAgentDbPath(host.rootDir, defaultAgentId);
    const defaultSummary = minimalAgentSummary({
      dirName: defaultAgentId,
      dbPath: defaultAgentDbPath,
      activeAgentId: activeAgentId ?? defaultAgentId
    });
    return [{ ...defaultSummary, id: defaultAgentId, name: "Grok Bot", description: "Default assistant", isActive: true }];
  }
  return sortedSummaries;
`;

roster = roster.replace(
  'return summaries.filter((value):value is Record<string,unknown>=>value!=null).sort((a,b)=>Number(b.updatedAt??0)-Number(a.updatedAt??0))}',
  defaultAgentLogic + '}'
);

fs.writeFileSync('source/host/extensions/session/session-roster.ts', roster, 'utf8');
console.log('session-roster.ts updated with auto-mint default agent');
