// Read-only acceptance check for one secretary-team run.
// Reads session logs under $DSH_HOME/sessions, the projection cache, and the
// delegation log. Never talks to the running Host and never writes anything.
//
// Usage (with ELECTRON_RUN_AS_NODE=1):
//   "DeepSeek Harness.exe" verify-acceptance.cjs [rootSessionId] [--since=ISO]
//       [--require-workers] [--require-leader-write] [--delegation-log=PATH] [--project=PATH]
// Default accepts a hands-on leader with no workers; --require-workers exercises
// the three-level chain. This is log/structure evidence, NOT artifact correctness.
// Without rootSessionId it picks the most recent root session that the
// delegation plugin logged with a secretary-* preset (default: last 48h).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const HOME = process.env.DSH_HOME;
if (!HOME) { console.log('DSH_HOME is not set'); process.exit(2); }
const SESSIONS = path.join(HOME, 'sessions');
const PROJCACHE = path.join(HOME, 'storages', 'session_projcache', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const args = process.argv.slice(2);
const logArg = args.find(a => a.startsWith('--delegation-log='));
const DELEGATION_LOG = logArg ? logArg.slice('--delegation-log='.length) : 'G:/DSH-Platform-Hub/research/secretary-team-20261030/delegation-status.log';
const requireWorkers = args.includes('--require-workers');
const requireLeaderWrite = args.includes('--require-leader-write');
const sinceArg = args.find((a) => a.startsWith('--since='));
const since = sinceArg ? Date.parse(sinceArg.slice(8)) : Date.now() - 48 * 3600 * 1000;
// Optional deliverable directory: printed as read-only evidence, never a check
// (the assertions are about the agent tree; the files are the outcome).
const projectArg = args.find((a) => a.startsWith('--project='));
const projectDir = projectArg ? projectArg.slice(10) : undefined;
let rootId = args.find((a) => !a.startsWith('--'));

// Session logs are concatenated zstd frames; decode each frame in turn.
function decode(buf, firstOnly = false) {
  const starts = [];
  for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 1)) starts.push(i);
  const parts = [];
  let i = 0;
  while (i < starts.length) {
    let ok = false;
    for (let j = i + 1; j <= starts.length; j++) {
      const end = j < starts.length ? starts[j] : buf.length;
      try { parts.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8')); i = j; ok = true; break; } catch {}
    }
    if (!ok) i++;
    if (firstOnly && parts.length > 0) break;
  }
  return parts.join('').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Preset per Agent, as logged by preset/delegation.mjs on agent/created.
const loggedPresets = new Map();
const loggedOrder = [];
try {
  for (const m of fs.readFileSync(DELEGATION_LOG, 'utf8').matchAll(/^(\S+) agent (\S+) preset=(\S+)/gm)) {
    loggedPresets.set(m[2], m[3]);
    loggedOrder.push({ at: Date.parse(m[1]), id: m[2], preset: m[3] });
  }
} catch {}

function cachedPreset(id) {
  try { return JSON.parse(fs.readFileSync(path.join(PROJCACHE, id + '.json'), 'utf8')).record?.rows?.agentPreset?.val ?? undefined; } catch { return undefined; }
}

// Index session directories modified after `since`.
const dirs = new Map();
for (const cwd of fs.readdirSync(SESSIONS)) {
  let entries;
  try { entries = fs.readdirSync(path.join(SESSIONS, cwd), { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(SESSIONS, cwd, e.name, 'session.v4.jsonl.zstd');
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs >= since || e.name === rootId) dirs.set(e.name, file);
  }
}

if (!rootId) {
  const candidates = loggedOrder.filter((r) => r.at >= since && r.preset.startsWith('secretary-') && dirs.has(r.id));
  if (candidates.length === 0) { console.log('no secretary-* root session logged since ' + new Date(since).toISOString()); process.exit(1); }
  rootId = candidates.at(-1).id;
}
if (!dirs.has(rootId)) { console.log('session log not found for ' + rootId); process.exit(1); }

// Parent -> children from session headers.
const children = new Map();
for (const [id, file] of dirs) {
  const parent = decode(fs.readFileSync(file), true).find((e) => e.type === 'session')?.parentSession;
  if (!parent) continue;
  if (!children.has(parent)) children.set(parent, []);
  children.get(parent).push(id);
}

const WRITE_LIKE = /(Set-Content|Add-Content|Out-File|New-Item|WriteAllText|WriteAllBytes|writeFileSync|Copy-Item|Move-Item|Remove-Item|(?<![0-9=-])>(?![&=]))/i;
// A quoted string is data, not a redirect: the live Opus leader ran
// `'; >>> node cli.js'; node cli.js` (an echo marker) and the raw regex read the
// `>>>` as a file redirect. Strip quoted segments before testing.
const unquote = (cmd) => cmd.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

function collectToolCalls(node, out, seen) {
  if (Array.isArray(node)) { for (const x of node) collectToolCalls(x, out, seen); return; }
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string' && /^tool[-_]?call$/i.test(node.type) && typeof node.name === 'string') {
    const key = node.id ?? JSON.stringify(node).slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    let a = node.arguments ?? node.args ?? node.input;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch {} }
    out.push({ name: node.name, args: a ?? {} });
    return;
  }
  for (const v of Object.values(node)) collectToolCalls(v, out, seen);
}

function analyze(id) {
  const evs = decode(fs.readFileSync(dirs.get(id)));
  let preset = evs.find((e) => e.type === 'session')?.agentPreset;
  const routes = new Set();
  const ends = [];
  const calls = [];
  const seen = new Set();
  let lastText = '';
  let offered;
  const catalogs = [];
  const times = evs.map(e => typeof e.time === 'number' ? e.time : Date.parse(e.time)).filter(Number.isFinite);
  for (const e of evs) {
    if (e.type === 'agent-preset/selected') preset = e.data?.agentPreset ?? preset;
    if (e.type === 'request/header') {
      const c = e.data?.header?.config ?? e.data?.config;
      if (c?.provider) routes.add(`${c.provider}/${c.model}${c.reasoningEffort ? '@' + c.reasoningEffort : ''}`);
      // Keep each catalog: a later request must not silently regain a bypass.
      const list = e.data?.header?.tools ?? e.data?.tools;
      if (Array.isArray(list)) {
        const names = list.map(t => typeof t === 'string' ? t : t?.name ?? t?.function?.name).filter(Boolean);
        catalogs.push(names);
        offered ??= names;
      }
    }
    if (e.type === 'turn/end') ends.push(e.data?.reason?.kind ?? '?');
    if (e.type === 'assistant/message') {
      const msg = e.data?.message ?? e.data;
      collectToolCalls(msg, calls, seen);
      const text = (Array.isArray(msg?.content) ? msg.content : []).filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim();
      if (text) lastText = text;
    }
  }
  preset ??= cachedPreset(id) ?? loggedPresets.get(id);
  const shell = calls.filter((c) => c.name === 'pwsh' || c.name === 'bash');
  const duplicates = (offered ?? []).filter((name, index) => (offered ?? []).indexOf(name) !== index);
  return {
    id, preset, routes: [...routes], ends, lastText, calls, offered: offered ?? [], catalogs,
    startedAt: times.length ? Math.min(...times) : undefined,
    endedAt: times.length ? Math.max(...times) : undefined,
    duplicates: [...new Set(duplicates)],
    delegations: calls.filter((c) => c.name.startsWith('delegate_')).map((c) => c.name),
    writes: calls.filter((c) => c.name === 'write' || c.name === 'edit').map((c) => `${c.name}:${c.args.file_path ?? c.args.path ?? '?'}`),
    shellCount: shell.length,
    shellWrites: shell.map((c) => String(c.args.command ?? '')).filter((cmd) => WRITE_LIKE.test(unquote(cmd))).map((cmd) => cmd.replace(/\s+/g, ' ').slice(0, 110)),
    teamToolCalls: calls.filter((c) => /^(spawn_teammate|send_message|team_task_)/.test(c.name)).length,
  };
}

const tree = [];
const walk = (id, depth) => {
  const info = analyze(id);
  info.depth = depth;
  tree.push(info);
  for (const child of (children.get(id) ?? []).sort()) walk(child, depth + 1);
};
walk(rootId, 0);

for (const a of tree) {
  const pad = '  '.repeat(a.depth);
  console.log(`${pad}${a.depth === 0 ? 'ROOT' : 'child'} ${a.id.slice(0, 44)} preset=${a.preset} route=${a.routes.join(',') || '-'} turns=${a.ends.join(',') || '-'}`);
  console.log(`${pad}   tool calls=${a.calls.length} delegate=[${a.delegations.join(', ')}] write/edit=${a.writes.length} shell=${a.shellCount} (write-like ${a.shellWrites.length})`);
  console.log(`${pad}   offered tools=${a.offered.length} write/edit offered=${['write', 'edit'].filter((t) => a.offered.includes(t)).join(',') || 'none'}`);
  if (a.duplicates.length > 0) console.log(`${pad}   DUPLICATE TOOLS: ${a.duplicates.join(', ')}`);
  for (const w of a.writes) console.log(`${pad}     ${w}`);
  for (const s of a.shellWrites) console.log(`${pad}     shell: ${s}`);
  if (a.lastText) console.log(`${pad}   last text: ${a.lastText.replace(/\s+/g, ' ').slice(0, 140)}`);
}

const root = tree[0];
const leaders = tree.filter((a) => a.depth === 1 && /^team-leader/.test(a.preset ?? ''));
const workers = tree.filter((a) => a.depth === 2 && /^team-worker/.test(a.preset ?? ''));
const okLeaders = leaders.filter((a) => a.ends.at(-1) === 'completed');
// v1.7: Team tools and generic spawn tools must be absent from every team role's
// catalog, not just the secretary's (all of them reach the same global rows).
const BOUNDARY_TOOLS = new Set([
  'subagent', 'subagent_fork', 'subagent_claude_code', 'delegate_claude_code',
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update', 'followup_task',
]);
const infringes = agent => agent.catalogs.some(names => names.some(name => BOUNDARY_TOOLS.has(name)));
const allCatalogsHave = (agent, names) => agent.catalogs.length > 0 && agent.catalogs.every(catalog => names.every(name => catalog.includes(name)));
const FAILURE_LINE = /mount .* failed|dispose failed|plugin load failed/;
function mountFailuresForRun() {
  let lines;
  try { lines = fs.readFileSync(DELEGATION_LOG, 'utf8').split(/\r?\n/).filter(Boolean); }
  catch { return undefined; }
  if (!Number.isFinite(root.startedAt)) return undefined;
  const ids = new Set(tree.map(a => a.id));
  const end = Math.max(...tree.map(a => a.endedAt ?? 0));
  let failures = 0;
  for (const line of lines.filter(line => FAILURE_LINE.test(line))) {
    const owner = /(?:failed for|for) (\S+?):/.exec(line)?.[1];
    // Keep ALL failures attributed to this tree, including teardown and failures
    // preceding later reloads. A reload must not rewrite this run's verdict.
    if (owner) { if (ids.has(owner)) failures++; continue; }
    const at = Date.parse(line.split(' ')[0]);
    if (!Number.isFinite(at)) return undefined;
    if (at >= root.startedAt && at <= end) failures++;
  }
  return failures;
}
const runFailures = mountFailuresForRun();
const workerRequested = leaders.some(a => a.delegations.some(d => d.startsWith('delegate_worker')));
const needsWorkers = requireWorkers || workerRequested || workers.length > 0;
const checks = [
  ['root is a secretary preset', /^secretary-/.test(root.preset ?? '')],
  ['secretary delegated to a leader', root.delegations.some((d) => d.startsWith('delegate_leader'))],
  ['secretary used no Team tools', root.teamToolCalls === 0],
  ['a leader finished its turn (completed)', okLeaders.length > 0],
  ['no native Claude model route', tree.every(a => a.routes.length > 0 && a.routes.every(r => !/claude|(?:^|[/_-])(?:opus|sonnet|haiku)(?:$|[/_@-])/i.test(r)))],
  ['leaders were offered write/edit', leaders.length > 0 && leaders.every(a => allCatalogsHave(a, ['write', 'edit']))],
  // Direct implementation, delegation, or both are all legitimate leader work.
  ['leaders were offered worker delegation tools', leaders.length > 0 && leaders.every(a => a.catalogs.length > 0 && a.catalogs.every(c => c.some(n => n.startsWith('delegate_worker_'))))],
  ['finished leader delegated to a worker', needsWorkers ? okLeaders.some(a => a.delegations.some(d => d.startsWith('delegate_worker'))) : null],
  ['workers finished their turns (completed)', needsWorkers ? workers.length > 0 && workers.every(a => a.ends.at(-1) === 'completed') : null],
  ['leaders made direct write/edit calls (requested evidence)', requireLeaderWrite ? okLeaders.some(a => a.writes.length > 0) : null],
  ['delegation log has no mount/dispose failures for this run', runFailures === undefined ? 'insufficient' : runFailures === 0],
  // v1.6: both leader presets carry a tool-jobs row, so a background delegation
  // is collectable; if this fails the preset patch never re-loaded.
  ['leaders were offered job_output (v1.6 preset rows live)', leaders.length > 0 && leaders.every(a => allCatalogsHave(a, ['job_output']))],
  ['secretary was not offered subagent* tools', root.catalogs.length > 0 && root.catalogs.every(c => !c.some(n => ['subagent', 'subagent_fork', 'subagent_claude_code', 'delegate_claude_code'].includes(n)))],
  ['leaders were not offered subagent*/Team tools', leaders.length > 0 && leaders.every(a => a.catalogs.length > 0 && !infringes(a))],
  ['workers were not offered subagent*/Team tools', workers.length > 0 ? workers.every(a => a.catalogs.length > 0 && !infringes(a)) : null],
  ['root was created after requested --since', sinceArg ? Number.isFinite(root.startedAt) && root.startedAt >= since : null],
];
console.log('--- acceptance ---');
for (const [label, pass] of checks) console.log(`${pass === null ? 'N/A' : pass === 'insufficient' ? 'INSUFFICIENT' : pass ? 'PASS' : 'FAIL'}  ${label}`);
const failed = new Set(checks.filter(([, pass]) => pass === false || pass === 'insufficient').map(([label]) => label));
const allPass = failed.size === 0;
console.log('NOTE: tool calls are invocation evidence, not proof of successful writes or passing artifact tests.');
console.log('NOTE: this verifier covers DSH-native session trees; external CLI leaders require CLI and worker-bridge evidence.');
console.log(allPass ? 'RESULT: PASS' : 'RESULT: FAIL');
// Turn a confusing FAIL into an actionable hint.
if (failed.has('leaders were offered write/edit') || failed.has('leaders were offered job_output (v1.6 preset rows live)')) {
  console.log('HINT: inspect the tested leader request/header and its preset revision. Old read-only leaders cannot prove the new engineering role.');
  console.log('      A newer reload does not update the historical evidence. Do not restart or alter profile-wide tools merely to clear this result.');
}
if (failed.has('secretary was not offered subagent* tools')) {
  console.log('HINT: the tested secretary tool boundary was not satisfied. Inspect the scoped preset; do not automatically disable global CLI channels.');
}
if (failed.has('secretary delegated to a leader') && root.offered.length === 0) {
  console.log('HINT: this session never sent a model request with a tool list, so the delegation tools were never offered. Run a real turn, then re-check.');
}
if (projectDir !== undefined) {
  console.log(`--- deliverable files under ${projectDir} ---`);
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < 2) walk(full, depth + 1); continue; }
      let size = 0;
      try { size = fs.statSync(full).size; } catch {}
      console.log(`${path.relative(projectDir, full)}  ${size}B`);
    }
  };
  walk(projectDir, 0);
}
process.exit(allPass ? 0 : 1);
