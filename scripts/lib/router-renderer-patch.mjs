import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_BEFORE = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
const REGISTRY_AFTER = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"router",label:"Router",icon:"git-branch"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
const GENERAL_BEFORE = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null';
const GENERAL_AFTER = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):x==="router"?a.jsx(RRouterPanel,{}):null';
const USAGE_BEFORE = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null';
const USAGE_AFTER = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(RRouterUsage,{})}):null';
const ONBOARDING_BOOT_GATE_BEFORE = 'return t.status!=="ready"?{step:n4e,dailyTools:[],draft:Ptt}:{step:kMt(e.step,s),dailyTools:e.dailyTools,draft:e.draft}}';
const ONBOARDING_BOOT_GATE_AFTER = 'return{step:kMt(e.step,s),dailyTools:e.dailyTools,draft:e.draft}}';
const FIRST_BOX_REOPEN_BEFORE = 'r=()=>{s(),n.sandAccess.snapshots.get().state==="granted"&&e&&(e=!1,n.firstRun.forceOnboarding())}';
const FIRST_BOX_REOPEN_AFTER = 'r=()=>{s()}';
const LOCAL_GATE_BEFORE = 'isSignedIn:()=>n.desktop.getCursorAuthStatus().then(v=>{const b=v.kind==="logged-in";return f=b,b})';
const LOCAL_GATE_AFTER = 'isSignedIn:()=>Promise.all([n.desktop.getCursorAuthStatus(),n.desktop.agent.getBoxRuntime()]).then(async([v,b])=>{const m=v.kind==="logged-in"||b.mode==="local-docker"?b:await n.desktop.agent.setBoxRuntime("local-docker");const y=v.kind==="logged-in"||m.mode==="local-docker";return f=y,y})';
const LOCAL_SIGNOUT_BEFORE = 'noteSignedOut:d=>u({kind:"signed-out",accountSlot:d})';
const LOCAL_SIGNOUT_AFTER = 'noteSignedOut:d=>{n.desktop.agent.getBoxRuntime().then(m=>{m.mode!=="local-docker"&&u({kind:"signed-out",accountSlot:d})}).catch(()=>u({kind:"signed-out",accountSlot:d}))}';
const ONBOARDING_FORCE_G_BEFORE = 'case"force-onboarding":return{kind:"onboarding",runId:n.runId+1,resolveSeq:0,forced:!0,signedIn:!1,owedShell:null}';
const ONBOARDING_FORCE_G_AFTER = 'case"force-onboarding":return{kind:"onboarding",runId:n.runId+1,resolveSeq:0,forced:!0,signedIn:!0,owedShell:null}';
const ONBOARDING_COMPLETE_Y_BEFORE = 'case"force-onboarding":return{kind:"onboarding",runId:n.runId+1,resolveSeq:n.resolveSeq+1,forced:!0,signedIn:!1,owedShell:null};case"skip-onboarding":return e.isSignedIn?{kind:"shell",runId:n.runId,resolveSeq:n.resolveSeq,provisional:!1}:n;case"complete-onboarding":return n}';
const ONBOARDING_COMPLETE_Y_AFTER = 'case"force-onboarding":return{kind:"onboarding",runId:n.runId+1,resolveSeq:n.resolveSeq+1,forced:!0,signedIn:!0,owedShell:null};case"skip-onboarding":return{kind:"shell",runId:n.runId,resolveSeq:n.resolveSeq,provisional:!1};case"complete-onboarding":return{kind:"shell",runId:n.runId,resolveSeq:n.resolveSeq,provisional:!1}}';
const ONBOARDING_COMPLETE_K_BEFORE = 'owedShell:null};case"skip-onboarding":return e.isSignedIn||n.signedIn?{kind:"shell",runId:n.runId,resolveSeq:n.resolveSeq,provisional:!1}:n.forced?{...n,forced:!1}:n;case"complete-onboarding":return n.signedIn?{kind:"shell",runId:n.runId,resolveSeq:n.resolveSeq,provisional:!1}:n}return e}';
const ONBOARDING_COMPLETE_K_AFTER = 'owedShell:null};case"skip-onboarding":return{kind:"shell",runId:n.runId,resolveSeq:n.resolveSeq,provisional:!1};case"complete-onboarding":return{kind:"shell",runId:n.runId,resolveSeq:n.resolveSeq,provisional:!1}}return e}';
const ONBOARDING_HANDOFF_BEFORE = 'async function jqn(n,e){if(n.isRunning)return{kind:"already-running"};const t=e.currentAccountSlot();if(t==null)return{kind:"signed-away"};n.accountSlot!==t&&(n.agentId=null,n.accountSlot=t),n.isRunning=!0,e.enterHandOff();const s=()=>e.currentAccountSlot()===t?null:(n.isRunning=!1,{kind:"signed-away"});try{await e.waitForComputer();const r=s();if(r!=null)return r;if(n.agentId==null){if(await e.isAccountOnboarded()){const l=s();return l??(await e.markSeen(),{kind:"already-onboarded"})}const o=s();if(o!=null)return o;n.agentId=await e.createTeammate(l=>{n.agentId=l})}const i=s();return i??(await e.markSeen(),{kind:"completed",agentId:n.agentId})}catch(r){return n.isRunning=!1,{kind:"failed",error:r}}}';
const ONBOARDING_HANDOFF_AFTER = 'async function jqn(n,e){if(n.isRunning)return{kind:"already-running"};const t=e.currentAccountSlot()??"local-user";n.accountSlot!==t&&(n.agentId=null,n.accountSlot=t),n.isRunning=!0,e.enterHandOff();try{await e.waitForComputer();if(n.agentId==null){if(await e.isAccountOnboarded()){await e.markSeen();return{kind:"already-onboarded"}}n.agentId=await e.createTeammate(l=>{n.agentId=l})}await e.markSeen();return{kind:"completed",agentId:n.agentId}}catch(r){return n.isRunning=!1,{kind:"failed",error:r}}}';
const PRELOAD_RPC_ANCHOR = '  getCursorAuthStatus: { args: "none" },';
const PRELOAD_RPC_AFTER = '  getLocalGeminiStatus: { args: "none" },\n  configureLocalGemini: { args: "object" },\n' + PRELOAD_RPC_ANCHOR;
const PRELOAD_RPC_METHODS = ['  getLocalGeminiStatus: { args: "none" },', '  configureLocalGemini: { args: "object" },'];
const PRELOAD_AGENT_ANCHOR = '      setBoxRuntime: (mode) => edge("setBoxRuntime", { mode }),\n      clientPersistence: {';
const PRELOAD_AGENT_AFTER = '      setBoxRuntime: (mode) => edge("setBoxRuntime", { mode }),\n      getLocalGeminiStatus: () => edge("getLocalGeminiStatus"),\n      configureLocalGemini: (args) => edge("configureLocalGemini", args),\n      clientPersistence: {';
const PRELOAD_AGENT_METHODS = ['      getLocalGeminiStatus: () => edge("getLocalGeminiStatus"),', '      configureLocalGemini: (args) => edge("configureLocalGemini", args),'];
const COMPONENT_ANCHOR = 'function Sa(s){';
const COMPONENT_SOURCE = String.raw`
const RRouterProviders=[
  {value:"cursor",label:"Cursor",description:"Use your signed-in Cursor account.",kind:"account"},
  {value:"claude-code",label:"Claude Code",description:"Use your existing Claude Code sign-in and Grok Bot's connected plugins.",kind:"local",localKey:"claude-code"},
  {value:"codex",label:"Codex",description:"Use your existing ChatGPT sign-in from Codex with Grok Bot's connected plugins.",kind:"local",localKey:"codex"},
  {value:"gemini",label:"Google Gemini",description:"Route through Google Gemini API (gemini-3.5-flash).",kind:"key",secret:"GEMINI_API_KEY"},
  {value:"openrouter",label:"OpenRouter",description:"Route through your OpenRouter account and selected model.",kind:"key",secret:"OPENROUTER_API_KEY"}
],RRouterOptions=RRouterProviders.map(s=>({value:s.value,label:s.label})),RRouterEmptyUsage={requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,lastUsedAt:null},RRouterInputClass="sand-9f619 sand-h8yej3 sand-5f5z56 sand-u97haq sand-lrnmfh sand-uve7l6 sand-16b7oty sand-1rgtt3y sand-o7x2bt sand-mkeg23 sand-1y0btm7 sand-qz0629 sand-1043rbw sand-13l7odt sand-1wd3ewq sand-jb2p0i sand-4z9k3i sand-frs9s4 sand-tt52l0 sand-1odjw0f sand-1t137rt sand-ltfok3";
function RRouterState(){
  const[s,e]=de.useState({provider:"cursor",usage:null,local:null,error:null});
  de.useEffect(()=>{let t=!0;const n=r=>{t&&e(r.detail)};window.addEventListener("sand-router-provider-changed",n);window.desktop.agent.getInferenceRouter().then(r=>{t&&e({...r,error:null})}).catch(r=>{t&&e(i=>({...i,error:String(r?.message??r)}))});return()=>{t=!1;window.removeEventListener("sand-router-provider-changed",n)}},[]);
  const t=async n=>{const r=s;e(i=>({...i,provider:n,error:null}));try{const i=await window.desktop.agent.setInferenceRouter(n),o={...i,error:null};e(o);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:o}))}catch(i){e({...r,error:String(i?.message??i)})}};
  return[s,t]
}
function RRouterSecrets(){const[s,e]=de.useState([]),[t,n]=de.useState(0);de.useEffect(()=>{let r=!0;window.desktop.secrets.list().then(i=>{r&&e(Array.isArray(i?.keys)?i.keys:[])});return()=>{r=!1}},[t]);return[s,()=>n(r=>r+1)]}
function RRouterNumber(s){return new Intl.NumberFormat().format(s)}
function RRouterCredential({provider:s,state:e,keys:t,onSaved:n}){const[r,i]=de.useState(""),[o,l]=de.useState(!1);if(s.kind==="account")return a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Signed in"});if(s.kind==="local"){const c=e.local?.[s.localKey],d=c?.installed&&c?.authenticated;return a.jsx(se,{as:"span",color:d?"primary":"secondary",size:"sm",children:d?"Ready":c?.installed?"Sign in with "+(s.value==="codex"?"codex login":"claude"):"Not installed"})}const c=t.includes(s.secret),d=async()=>{if(r.trim().length===0)return;l(!0);try{s.value==="gemini"?await window.desktop.agent.configureLocalGemini({apiKey:r.trim()}):await window.desktop.secrets.upsert({[s.secret]:r.trim()}),i(""),n()}finally{l(!1)}};return a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",style:{width:360},children:[a.jsx("input",{"aria-label":s.secret,className:RRouterInputClass,disabled:o,onChange:u=>i(u.currentTarget.value),placeholder:c?"Replace saved key":"Paste API key",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},type:"password",value:r}),a.jsx(oe,{disabled:o||r.trim().length===0,onClick:d,shape:"rectangular",size:"sm",variant:"secondary",children:o?"Saving…":"Save"})]})}
function RRouterUsageRows({usage:s}){return a.jsxs("div",{children:[a.jsx(ie,{label:"Requests",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.requests)})}),a.jsx(ie,{divided:!0,label:"Input tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.inputTokens)})}),a.jsx(ie,{divided:!0,label:"Output tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.outputTokens)})}),a.jsx(ie,{divided:!0,label:"Cache tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.cacheReadTokens+s.cacheWriteTokens)})}),a.jsx(ie,{divided:!0,label:"Last used",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:s.lastUsedAt?new Date(s.lastUsedAt).toLocaleString():"Not used yet"})})]})}
function RBoxRuntime(){const[s,e]=de.useState({mode:"local-docker",status:null,error:null,busy:!1});de.useEffect(()=>{let t=!0;window.desktop.agent.getBoxRuntime().then(n=>{t&&e({...n,mode:"local-docker",error:null,busy:!1})}).catch(n=>{t&&e(r=>({...r,error:String(n?.message??n),busy:!1}))});return()=>{t=!1}},[]);const t=!0,n=async()=>{const r="local-docker";e(i=>({...i,mode:r,busy:!0,error:null}));try{const i=await window.desktop.agent.setBoxRuntime(r);e({...i,mode:"local-docker",error:null,busy:!1})}catch(i){e(o=>({...o,mode:"local-docker",error:String(i?.message??i),busy:!1}))}};return a.jsxs("div",{children:[a.jsx(ie,{description:s.status?.detail??"Shell, files and computer use run locally on this computer (Node.js, no Docker required).",label:"Use local Docker VM",variant:"card",children:a.jsx("button",{"aria-checked":t,"aria-label":"Use local Docker VM",disabled:s.busy,onClick:n,role:"switch",style:{appearance:"none",background:"var(--color-accent-primary, #4f8cff)",border:0,borderRadius:999,cursor:s.busy?"wait":"pointer",height:22,opacity:s.busy?0.65:1,padding:2,position:"relative",transition:"background .15s ease",width:38},type:"button",children:a.jsx("span",{style:{background:"white",borderRadius:"50%",boxShadow:"0 1px 3px rgba(0,0,0,.35)",display:"block",height:18,transform:"translateX(16px)",transition:"transform .15s ease",width:18}})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null]})}
function RRouterPanel(){const[s,e]=RRouterState(),[t,n]=RRouterSecrets(),r=RRouterProviders.find(i=>i.value===s.provider)??RRouterProviders[0],i=s.usage?.providers?.[s.provider]??RRouterEmptyUsage,o=r.value==="codex"?"Uses the private ChatGPT login already stored by Codex on this Mac. Requests are made by Grok Bot directly.":r.kind==="local"?"Uses Claude Code's existing login on this Mac.":r.kind==="key"?"Stored securely with your other Grok Bot secrets.":"Uses the account already connected to Grok Bot.";return a.jsx(Te,{children:a.jsxs("div",{className:k("sand-settings-general","sand-9f619 sand-78zum5 sand-dt5ytf sand-3qzy4x"),children:[a.jsx(re,{title:"Routing",children:a.jsx(ie,{description:r.description,label:"Provider",variant:"card",children:a.jsx(ye,{"aria-label":"Routing provider",onValueChange:l=>{if(l!==null)void e(l)},options:RRouterOptions,placement:"bottom-end",size:"lg",value:s.provider,variant:"filled"})})}),a.jsx(re,{title:"Computer",children:a.jsx(RBoxRuntime,{})}),a.jsx(re,{title:r.kind==="key"?r.label+" account":"Account",children:a.jsx(ie,{description:o,label:r.kind==="key"?"API key":"Status",variant:"card",children:a.jsx(RRouterCredential,{provider:r,state:s,keys:t,onSaved:n})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null,a.jsx(re,{title:"Usage for "+r.label,children:a.jsx(RRouterUsageRows,{usage:i})})]})})}
function RRouterUsageSummary({provider:s,usage:e,current:t,divided:n}){const r=[RRouterNumber(e.requests)+" requests",RRouterNumber(e.inputTokens)+" input",RRouterNumber(e.outputTokens)+" output",RRouterNumber(e.cacheReadTokens+e.cacheWriteTokens)+" cached"].join(" · "),i=t?"Current route":e.lastUsedAt?new Date(e.lastUsedAt).toLocaleString():"Not used yet";return a.jsx(ie,{divided:n,description:r,label:s.label,variant:"card",children:a.jsx(se,{as:"span",color:t?"primary":"secondary",size:"sm",children:i})})}
function RRouterUsage(){const[s]=RRouterState(),e=RRouterProviders.find(t=>t.value===s.provider)??RRouterProviders[0],t=RRouterProviders.filter(n=>n.value===s.provider||(s.usage?.providers?.[n.value]?.requests??0)>0);return a.jsxs("div",{className:k("sand-usage-section","sand-9f619 sand-78zum5 sand-dt5ytf sand-ou54vl"),children:[a.jsx(re,{title:"Current provider",children:a.jsx(ie,{description:e.description,label:e.label,variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Selected"})})}),a.jsx(re,{title:"Tracked activity",children:a.jsx("div",{children:t.map((n,r)=>a.jsx(RRouterUsageSummary,{provider:n,usage:s.usage?.providers?.[n.value]??RRouterEmptyUsage,current:n.value===s.provider,divided:r>0},n.value))})}),s.provider==="cursor"?a.jsx(Na,{}):null]})}
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + 1) >= 0) throw new Error(`Original renderer ${label} anchor is missing or ambiguous.`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchOriginalSettingsRegistry(source) {
  return replaceExactlyOnce(source, REGISTRY_BEFORE, REGISTRY_AFTER, "settings registry");
}

export function patchOriginalSettingsPanel(source) {
  let patched = replaceExactlyOnce(source, COMPONENT_ANCHOR, `${COMPONENT_SOURCE}${COMPONENT_ANCHOR}`, "component insertion");
  patched = replaceExactlyOnce(patched, GENERAL_BEFORE, GENERAL_AFTER, "Router panel switch");
  patched = replaceExactlyOnce(patched, USAGE_BEFORE, USAGE_AFTER, "Usage panel switch");
  return patched;
}

export function patchOriginalOnboardingBootstrap(source) {
  let patched = replaceExactlyOnce(source, ONBOARDING_BOOT_GATE_BEFORE, ONBOARDING_BOOT_GATE_AFTER, "onboarding reconnect step preservation");
  patched = replaceExactlyOnce(patched, FIRST_BOX_REOPEN_BEFORE, FIRST_BOX_REOPEN_AFTER, "first-box onboarding reopen guard");
  patched = replaceExactlyOnce(patched, LOCAL_GATE_BEFORE, LOCAL_GATE_AFTER, "local Gemini first-run access");
  patched = replaceExactlyOnce(patched, LOCAL_SIGNOUT_BEFORE, LOCAL_SIGNOUT_AFTER, "local Gemini signed-out transition guard");
  return patched;
}

export function patchOriginalOnboardingCompletion(source) {
  let patched = replaceExactlyOnce(source, ONBOARDING_FORCE_G_BEFORE, ONBOARDING_FORCE_G_AFTER, "force onboarding disconnected phase");
  patched = replaceExactlyOnce(patched, ONBOARDING_COMPLETE_Y_BEFORE, ONBOARDING_COMPLETE_Y_AFTER, "complete and skip onboarding checking phase");
  patched = replaceExactlyOnce(patched, ONBOARDING_COMPLETE_K_BEFORE, ONBOARDING_COMPLETE_K_AFTER, "complete and skip onboarding transitions");
  patched = replaceExactlyOnce(patched, ONBOARDING_HANDOFF_BEFORE, ONBOARDING_HANDOFF_AFTER, "onboarding teammate handoff creation");
  return patched;
}

export function patchOriginalPreloadRpc(source) {
  const ensureFragments = (input, fragments, anchor, replacement, label) => {
    const present = fragments.map((fragment) => input.includes(fragment));
    if (present.every(Boolean)) return input;
    if (present.some(Boolean)) throw new Error(`Original preload ${label} is only partially present.`);
    return replaceExactlyOnce(input, anchor, replacement, label);
  };
  let patched = ensureFragments(source, PRELOAD_RPC_METHODS, PRELOAD_RPC_ANCHOR, PRELOAD_RPC_AFTER, "local Gemini preload RPC contract");
  patched = ensureFragments(patched, PRELOAD_AGENT_METHODS, PRELOAD_AGENT_ANCHOR, PRELOAD_AGENT_AFTER, "local Gemini desktop.agent wrappers");
  return patched;
}

export async function applyOriginalRendererRouterPatch({ stageRoot }) {
  const assetsRoot = path.join(stageRoot, "dist", "renderer", "assets");
  const preloadPath = path.join(stageRoot, "dist", "electron-preload", "preload.cjs");
  const registryCandidates = [];
  const panelCandidates = [];
  const onboardingCandidates = [];
  for (const name of await readdir(assetsRoot)) {
    if (!name.endsWith(".js")) continue;
    const target = path.join(assetsRoot, name);
    const source = await readFile(target, "utf8");
    if (source.includes(REGISTRY_BEFORE)) registryCandidates.push({ name, target, source });
    if (source.includes(COMPONENT_ANCHOR) && source.includes(GENERAL_BEFORE) && source.includes(USAGE_BEFORE)) panelCandidates.push({ name, target, source });
    if (source.includes(ONBOARDING_BOOT_GATE_BEFORE)) onboardingCandidates.push({ name, target, source });
  }
  if (registryCandidates.length !== 1 || panelCandidates.length !== 1 || onboardingCandidates.length !== 1) {
    throw new Error(`Expected one original Settings registry, panel and onboarding chunk, found ${registryCandidates.length}/${panelCandidates.length}/${onboardingCandidates.length}.`);
  }
  const changes = [];
  const preloadSource = await readFile(preloadPath, "utf8");
  const patchedPreload = patchOriginalPreloadRpc(preloadSource);
  await writeFile(preloadPath, patchedPreload);
  changes.push({
    role: "preload-rpc",
    path: "dist/electron-preload/preload.cjs",
    original: { bytes: Buffer.byteLength(preloadSource), sha256: sha256(preloadSource) },
    patched: { bytes: Buffer.byteLength(patchedPreload), sha256: sha256(patchedPreload) },
  });
  const patchedAssets = new Map();
  for (const [role, candidate, transform] of [
    ["registry", registryCandidates[0], patchOriginalSettingsRegistry],
    ["panel", panelCandidates[0], patchOriginalSettingsPanel],
    ["onboarding", onboardingCandidates[0], patchOriginalOnboardingBootstrap],
    ["onboarding-completion", onboardingCandidates[0], patchOriginalOnboardingCompletion],
  ]) {
    const previous = patchedAssets.get(candidate.target);
    const input = previous?.source ?? candidate.source;
    const patched = transform(input);
    patchedAssets.set(candidate.target, { source: patched, original: previous?.original ?? candidate.source });
    changes.push({
      role,
      path: `dist/renderer/assets/${candidate.name}`,
      original: { bytes: Buffer.byteLength(previous?.original ?? candidate.source), sha256: sha256(previous?.original ?? candidate.source) },
      patched: { bytes: Buffer.byteLength(patched), sha256: sha256(patched) },
    });
  }
  for (const [target, entry] of patchedAssets) await writeFile(target, entry.source);
  const record = {
    schemaVersion: 1,
    mode: "original-renderer-settings-extension",
    chunks: changes,
    features: ["settings-router-provider", "settings-local-docker-vm", "usage-current-provider", "onboarding-reconnect-step-preservation", "first-box-onboarding-reopen-guard", "local-runtime-first-run-access", "onboarding-completion-transition"],
    transformations: ["settings-registry", "router-panel", "usage-panel", "onboarding-reconnect-step-preservation", "first-box-onboarding-reopen-guard", "local-runtime-first-run-access", "local-runtime-signed-out-guard", "onboarding-completion-transition"],
  };
  const provenancePath = path.join(stageRoot, "dist", "renderer-router-extension.json");
  await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, provenancePath, provenanceBytes: (await stat(provenancePath)).size };
}
