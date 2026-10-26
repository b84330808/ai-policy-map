// Builds data/repos.txt from data/seed.txt plus the most-starred repos in
// major languages. Drops repos under 1,000 stars, archived repos, forks, and
// lists/tutorials (they have no code contribution policy to speak of).
// Usage: node src/discover.ts [--per-language N] [--max N]
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { graphql, lit } from "./github.ts";

const { values: args } = parseArgs({
  options: {
    "per-language": { type: "string", default: "4" },
    max: { type: "string", default: "340" },
  },
});

const LANGUAGES = ["JavaScript", "TypeScript", "Python", "Go", "Rust", "Java", "Kotlin", "C", "C++", "C#", "PHP", "Ruby", "Swift", "Dart", "Shell", "Zig", "Elixir", "Scala", "Lua", "Haskell"];
const MIN_STARS = 1000;
// Matched against names and topics with "-" and "_" turned into spaces.
const NOT_SOFTWARE = /\b(awesome|interview|roadmaps?|tutorials?|cheat ?sheets?|books?|courses?|curriculum|learn(ing)?|leetcode|algorithms?|public apis|guides?|system design|primer|resume|notes|examples|samples|papers|lists?|collection|style ?guide|dotfiles|free|bootcamp|exercises|hello world|projects for beginners|30 seconds|education|study|questions|skills?|prompts?|seclists|iptv)\b/i;
const LIST_DESCRIPTION = /^(awesome|a curated|curated list|list of|a collection of|collection of)|\b(skills? (library|collection|for (claude|ai|agents?))|agent skills|prompt (library|collection))\b/i;

type RepoInfo = {
  nameWithOwner: string;
  stargazerCount: number;
  isArchived: boolean;
  isFork: boolean;
  description: string | null;
  primaryLanguage: { name: string } | null;
  repositoryTopics: { nodes: { topic: { name: string } }[] };
};

const FIELDS = `nameWithOwner stargazerCount isArchived isFork description primaryLanguage { name } repositoryTopics(first: 10) { nodes { topic { name } } }`;

async function lookup(names: string[]): Promise<Map<string, RepoInfo | null>> {
  const out = new Map<string, RepoInfo | null>();
  for (let i = 0; i < names.length; i += 25) {
    const chunk = names.slice(i, i + 25);
    const q = chunk
      .map((n, j) => {
        const [o, r] = n.split("/");
        return `r${j}: repository(owner: ${lit(o!)}, name: ${lit(r!)}) { ${FIELDS} }`;
      })
      .join("\n");
    const data = await graphql<Record<string, RepoInfo | null>>(`query { ${q} }`);
    chunk.forEach((n, j) => out.set(n, data[`r${j}`] ?? null));
  }
  return out;
}

async function topStarred(language: string, n: number): Promise<RepoInfo[]> {
  const q = `language:${JSON.stringify(language)} stars:>${MIN_STARS} archived:false fork:false sort:stars`;
  const data = await graphql<{ search: { nodes: RepoInfo[] } }>(
    `query { search(query: ${lit(q)}, type: REPOSITORY, first: 50) { nodes { ... on Repository { ${FIELDS} } } } }`,
  );
  return data.search.nodes.filter((r) => !looksLikeList(r)).slice(0, n);
}

function looksLikeList(r: RepoInfo): boolean {
  const topics = r.repositoryTopics.nodes.map((t) => t.topic.name).join(" ");
  return NOT_SOFTWARE.test(r.nameWithOwner.replace(/[-_]/g, " ")) || NOT_SOFTWARE.test(topics.replace(/[-_]/g, " ")) || LIST_DESCRIPTION.test(r.description ?? "");
}

async function main() {
  const seedText = await readFile("data/seed.txt", "utf8");
  const leads: string[] = [];
  const popular: string[] = [];
  let section = leads;
  for (const raw of seedText.split(/\r?\n/)) {
    const l = raw.replace(/#.*/, "").trim();
    if (l === "[leads]") section = leads;
    else if (l === "[popular]") section = popular;
    else if (/^[\w.-]+\/[\w.-]+$/.test(l) && !leads.includes(l) && !popular.includes(l)) section.push(l);
  }
  const excludeText = await readFile("data/exclude.txt", "utf8").catch(() => "");
  const excluded = new Set(excludeText.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim().toLowerCase()).filter(Boolean));
  const info = await lookup([...leads, ...popular]);
  const kept = new Map<string, { info: RepoInfo; source: string }>();
  const extra: { info: RepoInfo; source: string }[] = [];
  const dropped: string[] = [];
  for (const s of [...leads, ...popular]) {
    const r = info.get(s);
    if (!r) dropped.push(`${s} (not found)`);
    else if (r.isArchived) dropped.push(`${s} (archived)`);
    else if (r.isFork) dropped.push(`${s} (fork)`);
    else if (r.stargazerCount < MIN_STARS) dropped.push(`${s} (${r.stargazerCount} stars)`);
    else if (leads.includes(s)) kept.set(r.nameWithOwner.toLowerCase(), { info: r, source: "seed" });
    else extra.push({ info: r, source: "seed" });
  }
  const max = Number(args.max);
  const per = Number(args["per-language"]);
  const known = (name: string) => kept.has(name.toLowerCase()) || extra.some((e) => e.info.nameWithOwner.toLowerCase() === name.toLowerCase());
  for (const lang of LANGUAGES) {
    for (const r of await topStarred(lang, per)) {
      if (!known(r.nameWithOwner) && !excluded.has(r.nameWithOwner.toLowerCase())) extra.push({ info: r, source: `top ${lang}` });
    }
  }
  // Leads are always kept; the rest fill the remaining places by stars.
  extra.sort((a, b) => b.info.stargazerCount - a.info.stargazerCount);
  for (const e of extra) {
    if (kept.size >= max) break;
    if (!kept.has(e.info.nameWithOwner.toLowerCase())) kept.set(e.info.nameWithOwner.toLowerCase(), e);
  }

  const rows = [...kept.values()].sort((a, b) => b.info.stargazerCount - a.info.stargazerCount);
  const body = rows.map((r) => `${r.info.nameWithOwner.padEnd(48)} # ${r.source}, ${r.info.primaryLanguage?.name ?? "n/a"}, ${r.info.stargazerCount}★`).join("\n");
  await writeFile(
    "data/repos.txt",
    `# Repos crawled by \`npm run collect\`. Generated by \`npm run discover\`;\n# edit data/seed.txt and re-run, or add lines by hand.\n${body}\n`,
  );
  console.log(`kept ${rows.length} (${rows.filter((r) => r.source === "seed").length} seeds); dropped ${dropped.length}:`);
  for (const d of dropped) console.log(`  ${d}`);
}

await main();
