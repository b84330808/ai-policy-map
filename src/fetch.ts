// Fetches the files and metadata a repo's contribution policy lives in.
// Pass 1 (one query per repo): metadata, a few directory listings, labels,
//   check names on recent PRs; then listings of policy subfolders that exist.
// Pass 2: text of the candidate files, pinned to the commit seen in pass 1.
// Pass 2 is skipped for a repo when the cached snapshot has the same commit.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { graphql, lit } from "./github.ts";

export type FileKind =
  | "contributing"
  | "ai_policy"
  | "agents"
  | "pr_template"
  | "readme"
  | "workflow"
  | "doc";

export type RepoFile = {
  /** owner/name of the repo the file lives in (differs for org-level files). */
  repo: string;
  path: string;
  commit: string;
  oid: string;
  kind: FileKind;
  scope: "repo" | "org" | "extra";
  text: string;
};

export type RepoSnapshot = {
  repo: string;
  url: string;
  description: string | null;
  stars: number;
  language: string | null;
  archived: boolean;
  fork: boolean;
  mirror: boolean;
  hasPullRequests: boolean;
  prCreationPolicy: string | null;
  prCreationCap: boolean;
  defaultBranch: string | null;
  commit: string | null;
  contributingUrl: string | null;
  /** Paths seen in the listed directories (root, .github, docs, ...). */
  paths: string[];
  labels: string[];
  /** Check-run and status-context names on the most recent PRs. */
  checks: string[];
  files: RepoFile[];
  fetchedAt: string;
};

const CACHE_DIR = ".cache/snapshots";
const CONCURRENCY = 4;

/** Always listed. */
const DIRS = ["", ".github", ".github/workflows", "docs", "doc"];
/** Listed only when pass 1 shows they exist. */
const SUBDIR_RE = /^(\.github\/pull_request_template|\.claude|docs?\/(contributing|contributors?|development|developer|dev|developers))$/i;

const DOC_EXT = String.raw`(\.(md|markdown|mdx|rst|txt|adoc|asciidoc|org))?`;
const CONTRIBUTING_RE = new RegExp(String.raw`^(contributing|contribute|contribution[-_]?guide(lines)?|contributors?[-_]guide|hacking|developing|development|governance|code[-_]review|reviewing|submitting[-_]patches)${DOC_EXT}$`, "i");
const AI_POLICY_RE = new RegExp(String.raw`^(contributing[._-]ai|ai[._-]contributing|(generative[-_])?ai[-_]tools?[-_]policy|ai|llm|genai|generative[-_]ai|ai[-_]?(policy|policies|guidelines?|usage|use|contributions?|contributing|disclosure|assisted[-_]?contributions?|code[-_]of[-_]conduct)|(llm|ai)[-_]?(policy|usage|guidelines?)|automated[-_]contributions?|tools?[-_]policy)${DOC_EXT}$`, "i");
const AGENTS_RE = /^(agents|agent|claude|gemini|copilot-instructions|\.cursorrules|\.windsurfrules|\.clinerules|conventions)(\.(md|mdc|txt))?$/i;
const PR_TEMPLATE_RE = /^pull_request_template(\.(md|markdown|txt))?$/i;
const README_RE = /^readme(\.(md|markdown|rst|txt|adoc|org))?$/i;
const WORKFLOW_RE = /\.ya?ml$/i;
const DOC_DIR_RE = /^docs?\/(contributing|contributors?|development|developer|dev|developers)$/i;

/** Files whose presence alone is worth recording. */
export const AGENT_FILE_RE = /^(AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.cursorrules|\.cursor|\.claude|\.windsurfrules|\.clinerules|\.github\/copilot-instructions\.md|\.github\/instructions|\.agents|\.aider\.conf\.yml)$/i;

const MAX_BYTES: Record<FileKind, number> = {
  contributing: 400_000,
  ai_policy: 400_000,
  agents: 200_000,
  pr_template: 100_000,
  readme: 250_000,
  workflow: 80_000,
  doc: 200_000,
};

export type TreeEntry = { name: string; type: string; path: string; object: { byteSize?: number } | null };
type Tree = { entries: TreeEntry[] } | null;

const TREE = `... on Tree { entries { name type path object { ... on Blob { byteSize } } } }`;

const META = `
    nameWithOwner url description stargazerCount isArchived isFork isMirror hasPullRequestsEnabled
    pullRequestCreationPolicy
    pullRequestCreationCapConfig { __typename }
    primaryLanguage { name }
    contributingGuidelines { url }
    defaultBranchRef { name target { oid } }
    ${DIRS.map((d, i) => `t${i}: object(expression: ${lit(`HEAD:${d}`)}) { ${TREE} }`).join("\n")}
    labels(first: 100) { nodes { name } }
    aiLabels: labels(first: 30, query: "ai") { nodes { name } }
    pullRequests(last: 3) { nodes { commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 30) {
      nodes { __typename ... on CheckRun { name } ... on StatusContext { context } } } } } } } } }`;

type MetaResult = {
  nameWithOwner: string;
  url: string;
  description: string | null;
  stargazerCount: number;
  isArchived: boolean;
  isFork: boolean;
  isMirror: boolean;
  hasPullRequestsEnabled: boolean;
  pullRequestCreationPolicy: string | null;
  pullRequestCreationCapConfig: unknown;
  primaryLanguage: { name: string } | null;
  contributingGuidelines: { url: string | null } | null;
  defaultBranchRef: { name: string; target: { oid: string } } | null;
  labels: { nodes: { name: string }[] } | null;
  aiLabels: { nodes: { name: string }[] } | null;
  pullRequests: { nodes: { commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: { name?: string; context?: string }[] } } | null } }[] } }[] } | null;
  [key: string]: unknown;
};

type Listed = { meta: MetaResult; entries: TreeEntry[] };

function splitName(full: string): [string, string] {
  const i = full.indexOf("/");
  return [full.slice(0, i), full.slice(i + 1)];
}

/** Runs `fn` over `items`, a few at a time. */
async function pool<T, R>(items: T[], n: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Pass 1 for one repo. Returns null when the repo does not exist. */
async function listRepo(repo: string): Promise<Listed | null> {
  const [o, n] = splitName(repo);
  const data = await graphql<{ repository: MetaResult | null }>(`query { repository(owner: ${lit(o)}, name: ${lit(n)}) { ${META} } rateLimit { cost remaining resetAt } }`);
  const meta = data.repository;
  if (!meta) return null;
  return withSubdirs(meta);
}

function treesOf(meta: MetaResult): TreeEntry[] {
  const entries: TreeEntry[] = [];
  DIRS.forEach((_, i) => {
    const t = meta[`t${i}`] as Tree;
    if (t?.entries) entries.push(...t.entries);
  });
  return entries;
}

/** Org `.github` repos only need their file listings: batch them, no labels or PRs. */
async function listOrgRepos(repos: string[]): Promise<Map<string, Listed | null>> {
  const out = new Map<string, Listed | null>();
  const sel = `nameWithOwner url description stargazerCount isArchived isFork isMirror hasPullRequestsEnabled
    pullRequestCreationPolicy primaryLanguage { name } defaultBranchRef { name target { oid } }
    ${DIRS.map((d, i) => `t${i}: object(expression: ${lit(`HEAD:${d}`)}) { ${TREE} }`).join("\n")}`;
  for (let i = 0; i < repos.length; i += 10) {
    const chunk = repos.slice(i, i + 10);
    const q = chunk.map((r, j) => {
      const [o, n] = splitName(r);
      return `r${j}: repository(owner: ${lit(o)}, name: ${lit(n)}) { ${sel} }`;
    });
    try {
      const data = await graphql<Record<string, MetaResult | null>>(`query { ${q.join("\n")} rateLimit { cost remaining resetAt } }`, {}, { retries: 2 });
      for (const [j, r] of chunk.entries()) {
        const meta = data[`r${j}`];
        out.set(r, meta ? await withSubdirs({ ...meta, labels: null, aiLabels: null, pullRequests: null, pullRequestCreationCapConfig: null, contributingGuidelines: null }) : null);
      }
    } catch {
      for (const r of chunk) out.set(r, await listRepo(r).catch(() => null));
    }
  }
  return out;
}

async function withSubdirs(meta: MetaResult): Promise<Listed> {
  const [o, n] = splitName(meta.nameWithOwner);
  const entries = treesOf(meta);
  const subdirs = entries.filter((e) => e.type === "tree" && SUBDIR_RE.test(e.path)).map((e) => e.path);
  const commit = meta.defaultBranchRef?.target.oid;
  if (subdirs.length > 0 && commit) {
    const sel = subdirs.map((d, i) => `s${i}: object(expression: ${lit(`${commit}:${d}`)}) { ${TREE} }`).join("\n");
    const sub = await graphql<{ repository: Record<string, Tree> | null }>(`query { repository(owner: ${lit(o)}, name: ${lit(n)}) { ${sel} } }`);
    for (const t of Object.values(sub.repository ?? {})) if (t?.entries) entries.push(...t.entries);
  }
  return { meta, entries };
}

type Candidate = { path: string; kind: FileKind; size: number };

/** Chooses which files to read, based on the directory listings. */
export function pickCandidates(entries: TreeEntry[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.type !== "blob" || seen.has(e.path)) continue;
    const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
    const size = e.object?.byteSize ?? 0;
    let kind: FileKind | null = null;
    if (dir === ".github/workflows") kind = WORKFLOW_RE.test(e.name) ? "workflow" : null;
    else if (/^\.github\/pull_request_template$/i.test(dir)) kind = /\.(md|markdown|txt)$/i.test(e.name) ? "pr_template" : null;
    else if (AI_POLICY_RE.test(e.name)) kind = "ai_policy";
    else if (PR_TEMPLATE_RE.test(e.name)) kind = "pr_template";
    else if (AGENTS_RE.test(e.name) && ["", ".github", ".claude"].includes(dir)) kind = "agents";
    else if (CONTRIBUTING_RE.test(e.name)) kind = "contributing";
    else if (README_RE.test(e.name) && dir === "") kind = "readme";
    else if (DOC_DIR_RE.test(dir) && /\.(md|markdown|mdx|rst|txt|adoc)$/i.test(e.name)) kind = "doc";
    if (!kind || size > MAX_BYTES[kind]) continue;
    seen.add(e.path);
    out.push({ path: e.path, kind, size });
  }
  // Large doc folders: keep the first few files only.
  let docs = 0;
  return out.filter((c) => c.kind !== "doc" || ++docs <= 12);
}

type BlobResult = { oid: string; text: string | null; isTruncated: boolean } | null;

type FileRequest = {
  repo: string;
  commit: string;
  path: string;
  kind: FileKind;
  scope: RepoFile["scope"];
  size: number;
  /** Set for files read from another repo on behalf of this one. */
  target?: string;
};

type FetchedFile = RepoFile & { target?: string };

async function fetchFileBatch(batch: FileRequest[]): Promise<FetchedFile[]> {
  const byRepo = new Map<string, FileRequest[]>();
  for (const r of batch) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
  const parts: string[] = [];
  const index = new Map<string, FileRequest>();
  let ri = 0;
  for (const [repo, files] of byRepo) {
    const [o, n] = splitName(repo);
    const sel = files.map((f) => {
      const key = `f${index.size}`;
      index.set(key, f);
      return `${key}: object(expression: ${lit(`${f.commit}:${f.path}`)}) { ... on Blob { oid text isTruncated } }`;
    });
    parts.push(`r${ri++}: repository(owner: ${lit(o)}, name: ${lit(n)}) { ${sel.join("\n")} }`);
  }
  const data = await graphql<Record<string, Record<string, BlobResult> | null>>(`query { ${parts.join("\n")} rateLimit { cost remaining resetAt } }`, {}, { retries: 2 });
  const out: FetchedFile[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (!v || k === "rateLimit") continue;
    for (const [key, blob] of Object.entries(v)) {
      const req = index.get(key);
      if (!req || !blob || blob.text == null) continue;
      out.push({ repo: req.repo, path: req.path, commit: req.commit, oid: blob.oid, kind: req.kind, scope: req.scope, text: blob.text, target: req.target });
    }
  }
  return out;
}

/** Reads file texts in size-limited batches; a failed batch is split and retried. */
async function fetchFiles(reqs: FileRequest[], log: (m: string) => void): Promise<FetchedFile[]> {
  const batches: FileRequest[][] = [];
  let batch: FileRequest[] = [];
  let bytes = 0;
  for (const r of reqs) {
    if (batch.length > 0 && (bytes + r.size > 1_000_000 || batch.length >= 40)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(r);
    bytes += r.size;
  }
  if (batch.length > 0) batches.push(batch);

  const run = async (b: FileRequest[]): Promise<FetchedFile[]> => {
    try {
      return await fetchFileBatch(b);
    } catch (err) {
      if (b.length === 1) {
        log(`  skipped ${b[0]!.repo}:${b[0]!.path} (${(err as Error).message})`);
        return [];
      }
      const mid = Math.ceil(b.length / 2);
      return [...(await run(b.slice(0, mid))), ...(await run(b.slice(mid)))];
    }
  };
  let done = 0;
  const results = await pool(batches, CONCURRENCY, async (b) => {
    const r = await run(b);
    if (++done % 10 === 0) log(`files ${done}/${batches.length} batches`);
    return r;
  });
  return results.flat();
}

function cachePath(repo: string): string {
  return join(CACHE_DIR, repo.replace("/", "__") + ".json");
}

async function readCache(repo: string): Promise<(RepoSnapshot & { extras?: string[]; key?: string }) | null> {
  try {
    return JSON.parse(await readFile(cachePath(repo), "utf8")) as RepoSnapshot;
  } catch {
    return null;
  }
}

async function writeCache(s: RepoSnapshot & { extras: string[]; key: string }): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath(s.repo), JSON.stringify(s));
}

function toSnapshot({ meta, entries }: Listed): RepoSnapshot {
  const labels = new Set<string>();
  for (const n of [...(meta.labels?.nodes ?? []), ...(meta.aiLabels?.nodes ?? [])]) labels.add(n.name);
  const checks = new Set<string>();
  for (const pr of meta.pullRequests?.nodes ?? []) {
    for (const c of pr.commits.nodes) {
      for (const ctx of c.commit.statusCheckRollup?.contexts.nodes ?? []) {
        const name = ctx.name ?? ctx.context;
        if (name) checks.add(name);
      }
    }
  }
  return {
    repo: meta.nameWithOwner,
    url: meta.url,
    description: meta.description,
    stars: meta.stargazerCount,
    language: meta.primaryLanguage?.name ?? null,
    archived: meta.isArchived,
    fork: meta.isFork,
    mirror: meta.isMirror,
    hasPullRequests: meta.hasPullRequestsEnabled,
    prCreationPolicy: meta.pullRequestCreationPolicy?.toLowerCase() ?? null,
    prCreationCap: meta.pullRequestCreationCapConfig != null,
    defaultBranch: meta.defaultBranchRef?.name ?? null,
    commit: meta.defaultBranchRef?.target.oid ?? null,
    contributingUrl: meta.contributingGuidelines?.url ?? null,
    paths: [...new Set(entries.map((e) => e.path))].sort(),
    labels: [...labels].sort(),
    checks: [...checks].sort(),
    files: [],
    fetchedAt: new Date().toISOString(),
  };
}

export type FetchOptions = {
  /** Extra file paths per repo: "path" (same repo) or "owner/name:path". */
  extraSources?: Record<string, string[]>;
  log?: (msg: string) => void;
};

/** Pass 1 for many repos; a repo that keeps failing maps to null. */
async function listMany(repos: string[], log: (m: string) => void, label: string): Promise<Map<string, Listed | null>> {
  const out = new Map<string, Listed | null>();
  let done = 0;
  await pool(repos, CONCURRENCY, async (r) => {
    try {
      out.set(r, await listRepo(r));
    } catch (err) {
      log(`  ${r}: ${(err as Error).message}`);
      out.set(r, null);
    }
    if (++done % 25 === 0 || done === repos.length) log(`${label} ${done}/${repos.length}`);
  });
  return out;
}

/** Fetches snapshots for many repos. Missing repos map to null. */
export async function fetchSnapshots(repos: string[], opts: FetchOptions = {}): Promise<Map<string, RepoSnapshot | null>> {
  const log = opts.log ?? (() => {});
  const result = new Map<string, RepoSnapshot | null>();
  const listed = await listMany(repos, log, "repos");

  // Org-level .github repos: GitHub's fallback for community health files.
  const owners = [...new Set([...listed.values()].filter((l) => l).map((l) => splitName(l!.meta.nameWithOwner)[0]))];
  const orgListed = await listOrgRepos(owners.map((o) => `${o}/.github`));
  log(`org .github repos: ${[...orgListed.values()].filter(Boolean).length}/${owners.length}`);

  const orgSnaps = new Map<string, RepoSnapshot>();
  const requests: FileRequest[] = [];
  const reuse = new Map<string, RepoFile[]>();
  const cacheKeys = new Map<string, string>();

  const plan = async (l: Listed, scope: "repo" | "org", extras: string[]) => {
    const snap = toSnapshot(l);
    if (!snap.commit) return snap;
    // Reuse the cached texts only if the commit, the extra sources and the file choice are all unchanged.
    const candidates = pickCandidates(l.entries);
    const key = JSON.stringify([snap.commit, extras, candidates.map((c) => [c.path, c.kind])]);
    cacheKeys.set(snap.repo, key);
    const cached = await readCache(snap.repo);
    if (cached && cached.key === key) {
      reuse.set(snap.repo, cached.files);
      return snap;
    }
    for (const c of candidates) {
      requests.push({ repo: snap.repo, commit: snap.commit, path: c.path, kind: c.kind, scope, size: c.size });
    }
    for (const x of extras) {
      if (x.includes(":")) continue; // other-repo sources are fetched below
      requests.push({ repo: snap.repo, commit: snap.commit, path: x, kind: "doc", scope: "extra", size: 50_000 });
    }
    return snap;
  };

  const extrasFor = (name: string, canonical: string) => opts.extraSources?.[name] ?? opts.extraSources?.[canonical] ?? [];
  const snaps: { snap: RepoSnapshot; extras: string[] }[] = [];
  for (const [name, l] of listed) {
    if (!l) {
      result.set(name, null);
      continue;
    }
    const extras = extrasFor(name, l.meta.nameWithOwner);
    snaps.push({ snap: await plan(l, "repo", extras), extras });
  }
  for (const l of orgListed.values()) {
    if (l) orgSnaps.set(l.meta.nameWithOwner.toLowerCase(), await plan(l, "org", []));
  }

  // Extra sources that live in another repo, e.g. python/devguide for python/cpython.
  const crossRepo = new Map<string, { target: string; path: string }[]>();
  for (const { snap, extras } of snaps) {
    for (const x of extras) {
      const m = /^([^/:]+\/[^/:]+):(.+)$/.exec(x);
      if (m) crossRepo.set(m[1]!, [...(crossRepo.get(m[1]!) ?? []), { target: snap.repo, path: m[2]! }]);
    }
  }
  const crossFiles: FileRequest[] = [];
  if (crossRepo.size > 0) {
    const names = [...crossRepo.keys()];
    const parts = names.map((r, i) => {
      const [o, n] = splitName(r);
      return `r${i}: repository(owner: ${lit(o)}, name: ${lit(n)}) { defaultBranchRef { target { oid } } }`;
    });
    const data = await graphql<Record<string, { defaultBranchRef: { target: { oid: string } } | null } | null>>(`query { ${parts.join("\n")} }`);
    names.forEach((r, i) => {
      const commit = data[`r${i}`]?.defaultBranchRef?.target.oid;
      if (!commit) return;
      for (const { target, path } of crossRepo.get(r)!) {
        crossFiles.push({ repo: r, commit, path, kind: "doc", scope: "extra", size: 50_000, target });
      }
    });
  }

  log(`fetching ${requests.length + crossFiles.length} files (${reuse.size} repos unchanged, read from cache)`);
  const files = await fetchFiles([...requests, ...crossFiles], log);
  const strip = ({ target: _t, ...f }: FetchedFile): RepoFile => f;

  // Cross-repo files are re-read every run; the cache keeps the latest copy for --offline runs.
  const assemble = async (snap: RepoSnapshot, extras: string[]) => {
    const own = reuse.get(snap.repo)?.filter((f) => f.repo === snap.repo) ?? files.filter((f) => !f.target && f.repo === snap.repo).map(strip);
    const cross = files.filter((f) => f.target === snap.repo).map(strip);
    snap.files = [...own, ...cross];
    await writeCache({ ...snap, extras, key: cacheKeys.get(snap.repo) ?? "" });
  };

  for (const s of orgSnaps.values()) await assemble(s, []);
  for (const { snap, extras } of snaps) {
    await assemble(snap, extras);
    const org = orgSnaps.get(`${splitName(snap.repo)[0].toLowerCase()}/.github`);
    if (org && org.repo.toLowerCase() !== snap.repo.toLowerCase()) snap.files.push(...orgFallbackFiles(snap, org));
    result.set(snap.repo, snap);
  }
  // Keep the caller's spelling as a key too when GitHub redirected the name.
  for (const [name, l] of listed) {
    if (l && name !== l.meta.nameWithOwner) result.set(name, result.get(l.meta.nameWithOwner) ?? null);
  }
  return result;
}

/**
 * Org-level files that apply to a repo: dedicated AI-policy files always;
 * CONTRIBUTING and PR templates only when the repo has none of its own,
 * which is how GitHub's community-health fallback works.
 */
function orgFallbackFiles(repo: RepoSnapshot, org: RepoSnapshot): RepoFile[] {
  const hasOwn = (kind: FileKind) => repo.files.some((f) => f.kind === kind && f.scope === "repo");
  return org.files
    .filter((f) => f.kind === "ai_policy" || (f.kind === "contributing" && !hasOwn("contributing") && /^(\.github\/|docs\/)?contributing/i.test(f.path)) || (f.kind === "pr_template" && !hasOwn("pr_template")))
    .map((f) => ({ ...f, scope: "org" as const }));
}

/**
 * Rebuilds snapshots from the cache without any API call (for working on the
 * rules). Cross-repo extra sources are not cached, so they are missing here.
 */
export async function cachedSnapshots(repos: string[]): Promise<Map<string, RepoSnapshot | null>> {
  const out = new Map<string, RepoSnapshot | null>();
  for (const name of repos) {
    const snap = await readCache(name);
    if (!snap) {
      out.set(name, null);
      continue;
    }
    const org = await readCache(`${splitName(snap.repo)[0]}/.github`);
    if (org && org.repo.toLowerCase() !== snap.repo.toLowerCase()) snap.files.push(...orgFallbackFiles(snap, org));
    out.set(name, snap);
  }
  return out;
}
