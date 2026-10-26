// Crawls the repos in data/repos.txt and writes data/policies.{json,csv}.
// Usage: node src/collect.ts [--only owner/name,...] [--limit N] [--offline]
// --offline re-classifies the cached snapshots without calling the API.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { classify, type PolicyRecord } from "./classify.ts";
import { cachedSnapshots, fetchSnapshots } from "./fetch.ts";
import { applyReviews, type Reviews } from "./reviews.ts";
import { toCsv } from "./csv.ts";

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    limit: { type: "string" },
    out: { type: "string", default: "data" },
    offline: { type: "boolean", default: false },
  },
});

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function readRepoList(path = "data/repos.txt"): Promise<string[]> {
  const text = await readFile(path, "utf8");
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (/^[\w.-]+\/[\w.-]+$/.test(line) && !out.includes(line)) out.push(line);
  }
  return out;
}

async function main() {
  let repos = await readRepoList();
  if (args.only) repos = args.only.split(",").map((s) => s.trim());
  if (args.limit) repos = repos.slice(0, Number(args.limit));
  const extraSources = await readJson<Record<string, string[]>>("data/extra-sources.json", {});
  const reviews = await readJson<Reviews>("data/reviews.json", {});
  const previous = await readJson<PolicyRecord[]>(`${args.out}/policies.json`, []);

  const started = Date.now();
  const snaps = args.offline ? await cachedSnapshots(repos) : await fetchSnapshots(repos, { extraSources, log: (m) => console.log(m) });
  const today = new Date().toISOString().slice(0, 10);
  const records: PolicyRecord[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const name of repos) {
    const snap = snaps.get(name);
    if (!snap) {
      missing.push(name);
      continue;
    }
    if (seen.has(snap.repo)) continue;
    seen.add(snap.repo);
    records.push(applyReviews(classify(snap, today), snap, reviews));
  }

  // A partial run (--only/--limit) updates those records and keeps the rest.
  let all = records;
  if (args.only || args.limit) {
    const updated = new Set(records.map((r) => r.repo));
    all = [...previous.filter((p) => !updated.has(p.repo)), ...records];
  }
  all.sort((a, b) => a.repo.toLowerCase().localeCompare(b.repo.toLowerCase()));

  await mkdir(args.out!, { recursive: true });
  await writeFile(`${args.out}/policies.json`, JSON.stringify(all, null, 2) + "\n");
  await writeFile(`${args.out}/policies.csv`, toCsv(all));
  const meta = summarize(all);
  await writeFile(`${args.out}/meta.json`, JSON.stringify({ generated: today, ...meta }, null, 2) + "\n");
  await mkdir(".cache", { recursive: true });
  await writeFile(".cache/refresh-summary.md", changeSummary(previous, all, missing));

  console.log(`done: ${records.length} repos in ${Math.round((Date.now() - started) / 1000)}s; missing: ${missing.join(", ") || "none"}`);
  console.log(JSON.stringify(meta.counts, null, 2));
}

export function summarize(all: PolicyRecord[]) {
  const count = (f: (r: PolicyRecord) => string) => {
    const c: Record<string, number> = {};
    for (const r of all) c[f(r)] = (c[f(r)] ?? 0) + 1;
    return c;
  };
  return {
    repos: all.length,
    counts: {
      ai_policy: count((r) => r.ai_policy.value),
      ai_policy_status: count((r) => r.ai_policy.status),
      agent_prs: count((r) => r.agent_prs.value),
      cla: count((r) => String(r.cla.value)),
      dco: count((r) => String(r.dco.value)),
      issue_first: count((r) => r.issue_first.value),
      outside_prs: count((r) => r.outside_prs.value),
      anti_automation: count((r) => (r.anti_automation.length > 0 ? "yes" : "no")),
    },
  };
}

/** Markdown for the weekly refresh PR body. */
export function changeSummary(prev: PolicyRecord[], next: PolicyRecord[], missing: string[]): string {
  const before = new Map(prev.map((r) => [r.repo, r]));
  const lines: string[] = [];
  const fields = ["ai_policy", "agent_prs", "issue_first"] as const;
  for (const r of next) {
    const p = before.get(r.repo);
    if (!p) {
      lines.push(`- new: \`${r.repo}\` (AI policy: ${r.ai_policy.value})`);
      continue;
    }
    for (const f of fields) {
      if (p[f].value !== r[f].value || p[f].status !== r[f].status) {
        lines.push(`- \`${r.repo}\` ${f}: ${p[f].value} (${p[f].status}) → ${r[f].value} (${r[f].status})`);
      }
    }
    for (const f of ["cla", "dco"] as const) {
      if (p[f].value !== r[f].value) lines.push(`- \`${r.repo}\` ${f}: ${p[f].value} → ${r[f].value}`);
    }
    if (p.outside_prs.value !== r.outside_prs.value) lines.push(`- \`${r.repo}\` outside PRs: ${p.outside_prs.value} → ${r.outside_prs.value}`);
    const sig = (x: PolicyRecord) => x.anti_automation.map((s) => `${s.kind}:${s.name}`).sort().join(", ");
    if (sig(p) !== sig(r)) lines.push(`- \`${r.repo}\` anti-automation: [${sig(p)}] → [${sig(r)}]`);
  }
  const gone = prev.filter((p) => !next.some((n) => n.repo === p.repo)).map((p) => p.repo);
  const stale = next.filter((r) => fields.some((f) => r[f].status === "review_stale")).map((r) => `\`${r.repo}\``);
  return [
    "Weekly refresh of the policy data.",
    "",
    "### Verdict changes",
    lines.length > 0 ? lines.join("\n") : "None.",
    "",
    "### Reviews that need another look",
    stale.length > 0 ? stale.join(", ") : "None.",
    "",
    ...(missing.length > 0 || gone.length > 0 ? ["### Not found or removed", [...missing, ...gone].map((m) => `\`${m}\``).join(", "), ""] : []),
  ].join("\n");
}

if (import.meta.main) await main();
