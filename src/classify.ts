// Turns a repo snapshot into a policy record: one verdict per question,
// each with links to the lines it is based on.
import type { FileKind, RepoFile, RepoSnapshot } from "./fetch.ts";
import {
  AGENT_FILE_RE,
} from "./fetch.ts";
import {
  CLA_CHECK,
  CLA_FILE,
  DCO_CHECK,
  DCO_FILE,
  LARGER_CHANGES,
  antiAutomationChecks,
  antiAutomationLabels,
  scanWorkflow,
  sentences,
  tagSentence,
  type Tag,
} from "./rules.ts";

export const AI_POLICY_VALUES = ["banned", "human_text_only", "allowed_with_disclosure", "allowed", "not_stated", "needs_review"] as const;
export type AiPolicy = (typeof AI_POLICY_VALUES)[number];
export const AGENT_VALUES = ["forbidden", "allowed", "not_stated", "needs_review"] as const;
export type AgentPolicy = (typeof AGENT_VALUES)[number];
export const ISSUE_FIRST_VALUES = ["required", "for_larger_changes", "not_required", "not_stated"] as const;
export type IssueFirst = (typeof ISSUE_FIRST_VALUES)[number];
export const OUTSIDE_PR_VALUES = ["open", "collaborators_only", "disabled", "not_accepted"] as const;
export type OutsidePrs = (typeof OUTSIDE_PR_VALUES)[number];

/** auto: keyword rules only. reviewed: a person checked it. review_stale: checked, but the source changed since. */
export type Status = "auto" | "reviewed" | "review_stale";

export type Evidence = { repo: string; path: string; line: number; url: string; quote: string };

export type Verdict<V> = {
  value: V;
  status: Status;
  /** One short line from the source. */
  quote: string | null;
  evidence: Evidence[];
  note?: string;
  /** Who reviewed it and when (status reviewed or review_stale). */
  review?: { by: string; date: string };
};

export type Flag = { value: boolean | null; evidence: Evidence[] };

export type Signal = { kind: "workflow" | "label" | "check" | "pr_cap"; name: string; url: string | null };

export type PolicyRecord = {
  repo: string;
  url: string;
  description: string | null;
  stars: number;
  language: string | null;
  archived: boolean;
  checked: string;
  commit: string | null;
  ai_policy: Verdict<AiPolicy>;
  agent_prs: Verdict<AgentPolicy>;
  cla: Flag;
  dco: Flag;
  issue_first: Verdict<IssueFirst>;
  assignment_required: Flag;
  outside_prs: { value: OutsidePrs; evidence: Evidence[] };
  pr_creation_policy: string | null;
  anti_automation: Signal[];
  agent_files: string[];
  sources: { repo: string; path: string; kind: FileKind; scope: RepoFile["scope"]; url: string }[];
};

export const IMPLIED_NOTE = "Implied by the ban on AI-generated contributions.";

const KIND_RANK: Record<FileKind, number> = { ai_policy: 0, contributing: 1, pr_template: 2, doc: 3, agents: 4, readme: 5, workflow: 6 };
const QUOTE_MAX = 160;

export function blobUrl(repo: string, commit: string, path: string, line?: number): string {
  const p = path.split("/").map(encodeURIComponent).join("/");
  const plain = /\.(md|markdown|mdx|rst|adoc|asciidoc|org)$/i.test(path) ? "?plain=1" : "";
  return `https://github.com/${repo}/blob/${commit}/${p}${plain}${line ? `#L${line}` : ""}`;
}

export function shortQuote(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= QUOTE_MAX) return t;
  const cut = t.slice(0, QUOTE_MAX - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 80)) + "…";
}

type Hit = { tag: Tag; file: RepoFile; line: number; text: string };

function rank(h: Hit): number {
  return KIND_RANK[h.file.kind] * 10 + (h.file.scope === "org" ? 5 : 0) + Math.min(h.line, 9999) / 10000;
}

function toEvidence(h: Hit): Evidence {
  return { repo: h.file.repo, path: h.file.path, line: h.line, url: blobUrl(h.file.repo, h.file.commit, h.file.path, h.line), quote: shortQuote(h.text) };
}

function evidenceOf(hits: Hit[], max = 3): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const h of [...hits].sort((a, b) => rank(a) - rank(b))) {
    const key = `${h.file.repo}:${h.file.path}:${h.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toEvidence(h));
    if (out.length >= max) break;
  }
  return out;
}

function verdict<V>(value: V, hits: Hit[], note?: string): Verdict<V> {
  const evidence = evidenceOf(hits);
  return { value, status: "auto", quote: evidence[0]?.quote ?? null, evidence, ...(note ? { note } : {}) };
}

const AI_SUBJECT = /\b(ai|llms?|language models?|gpt|agents?|agentic|machine learning|deep learning|neural|chatbot|rag|inference|generative|diffusion|transformers?|copilot|mcp)\b/i;

export function classify(snap: RepoSnapshot, today = new Date().toISOString().slice(0, 10)): PolicyRecord {
  const hits: Hit[] = [];
  const signals: Signal[] = [];
  const workflowHits: { kind: string; ev: Evidence }[] = [];

  for (const f of snap.files) {
    if (f.kind === "workflow") {
      for (const w of scanWorkflow(f.path, f.text)) {
        const ev = { repo: f.repo, path: f.path, line: w.line, url: blobUrl(f.repo, f.commit, f.path, w.line), quote: w.name };
        workflowHits.push({ kind: w.kind, ev });
        if (w.kind === "anti_automation") signals.push({ kind: "workflow", name: w.name, url: ev.url });
      }
      continue;
    }
    const ctx = { agentFile: f.kind === "agents", strict: f.kind === "readme" };
    for (const s of sentences(f.text)) {
      for (const tag of tagSentence(s, ctx)) hits.push({ tag, file: f, line: s.line, text: s.text });
    }
  }
  const by = (...tags: Tag[]) => hits.filter((h) => tags.includes(h.tag));

  // --- AI policy ---
  // Mentions only count from policy-type files, and not at all in repos that are about AI.
  const aiSubject = AI_SUBJECT.test(snap.description ?? "");
  const mentions = by("ai_mention").filter((h) => ["ai_policy", "contributing", "pr_template", "doc"].includes(h.file.kind) && (!aiSubject || h.file.kind === "ai_policy"));
  const ban = by("ai_ban");
  const cond = by("ai_ban_conditional");
  const human = by("ai_human_text");
  // "[ ] No AI tools were used" checkboxes count as a disclosure question, unless a ban says more.
  const disclose = [...by("ai_disclose"), ...(ban.length === 0 ? by("ai_attest") : [])];
  const allow = by("ai_allow");
  const policyFile = snap.files.some((f) => f.kind === "ai_policy");

  let ai: Verdict<AiPolicy>;
  if (ban.length > 0 && (allow.length > 0 || disclose.length > 0)) {
    ai = verdict<AiPolicy>("needs_review", [...ban, ...allow, ...disclose], "Both a ban and a permission or disclosure rule matched.");
  } else if (ban.length > 0) {
    ai = verdict<AiPolicy>("banned", [...ban, ...human]);
  } else if (human.length > 0) {
    ai = verdict<AiPolicy>("human_text_only", [...human, ...disclose], disclose.length > 0 ? "Disclosure is also asked for." : undefined);
  } else if (disclose.length > 0) {
    ai = verdict<AiPolicy>("allowed_with_disclosure", [...disclose, ...cond]);
  } else if (allow.length > 0) {
    ai = verdict<AiPolicy>("allowed", [...allow, ...cond], cond.length > 0 ? "With conditions (e.g. no unreviewed or low-effort AI output)." : undefined);
  } else if (cond.length > 0) {
    ai = verdict<AiPolicy>("needs_review", cond, "Only a conditional restriction matched (e.g. unreviewed AI output is not accepted).");
  } else if (mentions.length > 0 || policyFile) {
    const pf = snap.files.filter((f) => f.kind === "ai_policy").map((f) => ({ tag: "ai_mention" as Tag, file: f, line: 1, text: f.path }));
    ai = verdict<AiPolicy>("needs_review", [...mentions, ...pf], "AI tools are mentioned, but no rule matched.");
  } else {
    ai = verdict<AiPolicy>("not_stated", []);
  }

  // --- agents opening PRs on their own ---
  const forbid = by("agent_forbid");
  const agentAllow = by("agent_allow");
  let agent: Verdict<AgentPolicy>;
  if (forbid.length > 0 && agentAllow.length > 0) agent = verdict<AgentPolicy>("needs_review", [...forbid, ...agentAllow], "Rules both allow and forbid agent PRs.");
  else if (forbid.length > 0) agent = verdict<AgentPolicy>("forbidden", forbid);
  else if (agentAllow.length > 0) agent = verdict<AgentPolicy>("allowed", agentAllow);
  else if (ai.value === "banned") agent = verdict<AgentPolicy>("forbidden", ban, IMPLIED_NOTE);
  else agent = verdict<AgentPolicy>("not_stated", []);

  // --- CLA / DCO ---
  const fileEv = (re: RegExp) =>
    snap.paths.filter((p) => re.test(p)).map((p) => ({ repo: snap.repo, path: p, line: 0, url: blobUrl(snap.repo, snap.commit ?? "HEAD", p), quote: p }));
  const checkEv = (re: RegExp) =>
    snap.checks.filter((c) => re.test(c)).map((c) => ({ repo: snap.repo, path: "", line: 0, url: `${snap.url}/pulls`, quote: `check on recent PRs: ${c}` }));
  const wf = (kind: string) => workflowHits.filter((w) => w.kind === kind).map((w) => w.ev);

  const claPos = [...evidenceOf(by("cla")), ...wf("cla"), ...checkEv(CLA_CHECK), ...fileEv(CLA_FILE)];
  const claNeg = by("cla_negated");
  const cla: Flag = claPos.length > 0 ? { value: true, evidence: claPos.slice(0, 3) } : claNeg.length > 0 ? { value: false, evidence: evidenceOf(claNeg) } : { value: null, evidence: [] };
  const dcoPos = [...evidenceOf(by("dco")), ...wf("dco"), ...checkEv(DCO_CHECK), ...fileEv(DCO_FILE)];
  const dco: Flag = dcoPos.length > 0 ? { value: true, evidence: dcoPos.slice(0, 3) } : { value: null, evidence: [] };

  // --- issue first / assignment ---
  const issueHits = by("issue_first").filter((h) => h.file.kind !== "readme");
  const strictIssue = issueHits.filter((h) => !LARGER_CHANGES.test(h.text));
  const issueWf = wf("issue_first");
  let issue: Verdict<IssueFirst>;
  if (issueWf.length > 0) {
    issue = { value: "required", status: "auto", quote: issueWf[0]!.quote, evidence: [...issueWf, ...evidenceOf(strictIssue)].slice(0, 3), note: "A workflow checks PRs for a linked issue." };
  } else if (strictIssue.length > 0) issue = verdict<IssueFirst>("required", strictIssue);
  else if (issueHits.length > 0) issue = verdict<IssueFirst>("for_larger_changes", issueHits);
  else if (by("issue_first_negated").length > 0) issue = verdict<IssueFirst>("not_required", by("issue_first_negated"));
  else issue = verdict<IssueFirst>("not_stated", []);
  const assign = by("assignment").filter((h) => h.file.kind !== "readme");
  const assignment: Flag = assign.length > 0 ? { value: true, evidence: evidenceOf(assign) } : { value: null, evidence: [] };

  // --- who can open PRs ---
  let outside: PolicyRecord["outside_prs"];
  const noPrs = by("no_outside_prs");
  if (!snap.hasPullRequests) outside = { value: "disabled", evidence: [] };
  else if (snap.prCreationPolicy === "collaborators_only") outside = { value: "collaborators_only", evidence: [] };
  else if (noPrs.length > 0) outside = { value: "not_accepted", evidence: evidenceOf(noPrs) };
  else outside = { value: "open", evidence: [] };

  // --- anti-automation signals ---
  for (const l of antiAutomationLabels(snap.labels)) signals.push({ kind: "label", name: l, url: `${snap.url}/labels?q=${encodeURIComponent(l)}` });
  for (const c of antiAutomationChecks(snap.checks)) signals.push({ kind: "check", name: c, url: `${snap.url}/pulls` });
  if (snap.prCreationCap) signals.push({ kind: "pr_cap", name: "pull request creation cap", url: null });

  return {
    repo: snap.repo,
    url: snap.url,
    description: snap.description,
    stars: snap.stars,
    language: snap.language,
    archived: snap.archived,
    checked: today,
    commit: snap.commit,
    ai_policy: ai,
    agent_prs: agent,
    cla,
    dco,
    issue_first: issue,
    assignment_required: assignment,
    outside_prs: outside,
    pr_creation_policy: snap.prCreationPolicy,
    anti_automation: dedupeSignals(signals),
    agent_files: snap.paths.filter((p) => AGENT_FILE_RE.test(p)),
    sources: snap.files
      .filter((f) => f.kind !== "workflow")
      .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])
      .map((f) => ({ repo: f.repo, path: f.path, kind: f.kind, scope: f.scope, url: blobUrl(f.repo, f.commit, f.path) })),
  };
}

function dedupeSignals(s: Signal[]): Signal[] {
  const seen = new Set<string>();
  return s.filter((x) => {
    const k = `${x.kind}|${x.name.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
