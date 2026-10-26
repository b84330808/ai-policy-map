// Manual reviews in data/reviews.json override the keyword verdicts.
// A review goes stale when the file it cites changes, or when the keyword
// verdict moves away from what it was at review time.
import type { RepoFile, RepoSnapshot } from "./fetch.ts";
import { IMPLIED_NOTE, blobUrl, shortQuote, type PolicyRecord, type Verdict } from "./classify.ts";
import { sentences, tagSentence, type Tag } from "./rules.ts";

export type Review = {
  verdict: string;
  /** The line the verdict rests on. Omit for "not_stated" after a manual check. */
  source?: { repo?: string; path: string; line: number };
  quote?: string;
  note?: string;
  reviewed: string;
  /** GitHub handle of the reviewer, or the tool that did the review. */
  by: string;
  /** Blob oid of the source file at review time. */
  oid?: string;
  /** The keyword verdict at review time. */
  auto?: string;
};

export type ReviewedField = "ai_policy" | "agent_prs" | "issue_first";
export type Reviews = Record<string, Partial<Record<ReviewedField, Review>>>;

export function applyReviews(rec: PolicyRecord, snap: RepoSnapshot, reviews: Reviews): PolicyRecord {
  const r = reviews[rec.repo];
  if (!r) return rec;
  for (const field of ["ai_policy", "agent_prs", "issue_first"] as const) {
    const rv = r[field];
    if (!rv) continue;
    const auto = rec[field] as Verdict<string>;
    let stale = rv.auto !== undefined && rv.auto !== auto.value;
    let evidence = auto.evidence;
    let quote = rv.quote ?? null;
    if (rv.source) {
      const repo = rv.source.repo ?? rec.repo;
      const file = snap.files.find((f) => f.repo === repo && f.path === rv.source!.path);
      if (!file) stale = true;
      else if (rv.oid && file.oid !== rv.oid) stale = true;
      const commit = file?.commit ?? snap.commit ?? "HEAD";
      const lineText = file ? bestSentence(file, rv.source.line, rv.verdict) : undefined;
      quote = quote ?? (lineText ? shortQuote(lineText) : null);
      evidence = [{ repo, path: rv.source.path, line: rv.source.line, url: blobUrl(repo, commit, rv.source.path, rv.source.line), quote: quote ?? "" }];
    } else if (rv.verdict === "not_stated") {
      evidence = [];
    }
    const v: Verdict<string> = {
      value: rv.verdict,
      status: stale ? "review_stale" : "reviewed",
      quote,
      evidence,
      ...(rv.note ? { note: rv.note } : {}),
      review: { by: rv.by, date: rv.reviewed },
    };
    if (stale) v.note = `${v.note ? v.note + " " : ""}(Source changed since the review on ${rv.reviewed}; keyword verdict now: ${auto.value}.)`;
    (rec as Record<string, unknown>)[field] = v;
  }
  // "Agents forbidden" implied by an AI ban must follow the reviewed AI verdict.
  const ai = rec.ai_policy;
  const agent = rec.agent_prs;
  if (agent.status === "auto") {
    if (agent.note === IMPLIED_NOTE && ai.value !== "banned") {
      rec.agent_prs = { value: "not_stated", status: "auto", quote: null, evidence: [] };
    } else if (agent.value === "not_stated" && ai.value === "banned") {
      rec.agent_prs = { value: "forbidden", status: "auto", quote: ai.quote, evidence: ai.evidence, note: IMPLIED_NOTE };
    }
  }
  return rec;
}

const TAG_FOR_VERDICT: Record<string, Tag> = {
  banned: "ai_ban",
  human_text_only: "ai_human_text",
  allowed_with_disclosure: "ai_disclose",
  allowed: "ai_allow",
  forbidden: "agent_forbid",
};

/** The sentence on a cited line that best supports the verdict (a line can hold several). */
function bestSentence(file: RepoFile, line: number, verdict: string): string | undefined {
  const onLine = sentences(file.text).filter((s) => s.line === line);
  const ctx = { agentFile: file.kind === "agents", strict: false };
  const tagged = onLine.map((s) => ({ s, tags: tagSentence(s, ctx) }));
  const want = TAG_FOR_VERDICT[verdict];
  const pick =
    (want && tagged.find((x) => x.tags.has(want))) ||
    tagged.find((x) => [...x.tags].some((t) => t.startsWith("ai_") || t.startsWith("agent_"))) ||
    tagged[0];
  return pick?.s.text;
}
