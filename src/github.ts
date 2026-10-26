// Minimal GitHub GraphQL client: token from GITHUB_TOKEN or `gh auth token`,
// rate-limit aware, retries transient failures.
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const ENDPOINT = "https://api.github.com/graphql";
// Pause between queries so we stay well clear of secondary rate limits.
const MIN_GAP_MS = 400;

let token: string | undefined;
let lastCall = 0;

function getToken(): string {
  if (token) return token;
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  }
  if (!token) throw new Error("No GitHub token: set GITHUB_TOKEN or log in with gh");
  return token;
}

export type GraphQLResult<T> = { data: T | null; errors?: { message: string; type?: string; path?: unknown[] }[] };

export class GraphQLError extends Error {
  readonly errors: { message: string; type?: string }[];
  constructor(errors: { message: string; type?: string }[]) {
    super(errors.map((e) => e.message).join("; "));
    this.errors = errors;
  }
}

/**
 * Runs a query. Partial data with NOT_FOUND errors is returned as-is (missing
 * repos come back as null); any other error throws after retries.
 */
export async function graphql<T>(query: string, variables: Record<string, unknown> = {}, opts: { retries?: number } = {}): Promise<T> {
  return (await graphqlPartial<T>(query, variables, opts)).data;
}

/**
 * Like graphql(), but FORBIDDEN errors on some fields do not fail the query:
 * the fields come back null and their paths are returned. An Actions
 * GITHUB_TOKEN, for one, cannot read check runs of other repositories.
 */
export async function graphqlPartial<T>(query: string, variables: Record<string, unknown> = {}, opts: { retries?: number } = {}): Promise<{ data: T; forbidden: string[] }> {
  const retries = opts.retries ?? 4;
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `bearer ${getToken()}`,
          "content-type": "application/json",
          "user-agent": "ai-policy-map",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(5000 * attempt);
      continue;
    }

    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const remaining = res.headers.get("x-ratelimit-remaining");
      let ms = 60_000;
      if (retryAfter > 0) ms = retryAfter * 1000;
      else if (remaining === "0" && reset > 0) ms = Math.max(0, reset * 1000 - Date.now()) + 2000;
      console.warn(`rate limited (HTTP ${res.status}); sleeping ${Math.round(ms / 1000)}s`);
      await sleep(ms);
      continue;
    }
    if (res.status >= 500) {
      if (attempt >= retries) throw new Error(`GitHub GraphQL HTTP ${res.status}`);
      await sleep(5000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}: ${await res.text()}`);

    const body = (await res.json()) as GraphQLResult<T>;
    const forbidden = (body.errors ?? []).filter((e) => e.type === "FORBIDDEN" && body.data).map((e) => (e.path ?? []).join("."));
    const errors = (body.errors ?? []).filter((e) => e.type !== "NOT_FOUND" && !(e.type === "FORBIDDEN" && body.data));
    if (errors.length > 0) {
      const transient = errors.some((e) => /something went wrong|timeout|timed out/i.test(e.message));
      const limited = errors.some((e) => e.type === "RATE_LIMITED");
      if (limited) {
        console.warn("GraphQL RATE_LIMITED; sleeping 60s");
        await sleep(60_000);
        continue;
      }
      if (transient && attempt < retries) {
        await sleep(3000 * attempt);
        continue;
      }
      throw new GraphQLError(errors);
    }
    if (!body.data) throw new Error("GitHub GraphQL returned no data");
    await respectBudget(body.data);
    return { data: body.data, forbidden };
  }
}

/** If the query asked for rateLimit, wait for the reset when the budget runs low. */
async function respectBudget(data: unknown): Promise<void> {
  const rl = (data as { rateLimit?: { remaining: number; resetAt: string } }).rateLimit;
  if (!rl || rl.remaining > 50) return;
  const ms = Math.max(0, Date.parse(rl.resetAt) - Date.now()) + 2000;
  console.warn(`GraphQL budget low (${rl.remaining} left); sleeping ${Math.round(ms / 1000)}s`);
  await sleep(ms);
}

/** GraphQL string literal. */
export function lit(s: string): string {
  return JSON.stringify(s);
}
