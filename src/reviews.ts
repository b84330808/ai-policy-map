// Manual reviews in data/reviews.json override the keyword verdicts.
// A review goes stale when the file it cites changes, or when the keyword
// verdict moves away from what it was at review time.
import type { RepoSnapshot } from "./fetch.ts";
import { blobUrl, shortQuote, type PolicyRecord, type Verdict } from "./classify.ts";
import { sentences } from "./rules.ts";

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
      const lineText = file ? sentences(file.text).find((s) => s.line === rv.source!.line)?.text : undefined;
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
  return rec;
}
