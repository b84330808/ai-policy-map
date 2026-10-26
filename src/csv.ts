import type { PolicyRecord } from "./classify.ts";

const COLUMNS: [string, (r: PolicyRecord) => string | number | boolean | null][] = [
  ["repo", (r) => r.repo],
  ["url", (r) => r.url],
  ["stars", (r) => r.stars],
  ["language", (r) => r.language],
  ["ai_policy", (r) => r.ai_policy.value],
  ["ai_policy_status", (r) => r.ai_policy.status],
  ["ai_policy_source", (r) => r.ai_policy.evidence[0]?.url ?? ""],
  ["ai_policy_quote", (r) => r.ai_policy.quote],
  ["agent_prs", (r) => r.agent_prs.value],
  ["agent_prs_status", (r) => r.agent_prs.status],
  ["agent_prs_source", (r) => r.agent_prs.evidence[0]?.url ?? ""],
  ["cla", (r) => r.cla.value],
  ["dco", (r) => r.dco.value],
  ["issue_first", (r) => r.issue_first.value],
  ["assignment_required", (r) => r.assignment_required.value],
  ["outside_prs", (r) => r.outside_prs.value],
  ["pr_creation_policy", (r) => r.pr_creation_policy],
  ["anti_automation", (r) => r.anti_automation.map((s) => `${s.kind}:${s.name}`).join("; ")],
  ["agent_files", (r) => r.agent_files.join("; ")],
  ["archived", (r) => r.archived],
  ["checked", (r) => r.checked],
];

function cell(v: string | number | boolean | null): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(records: PolicyRecord[]): string {
  const rows = [COLUMNS.map(([h]) => h).join(",")];
  for (const r of records) rows.push(COLUMNS.map(([, f]) => cell(f(r))).join(","));
  return rows.join("\n") + "\n";
}
