// Copies the static site and the data files into _site/ for GitHub Pages.
import { cp, mkdir, rm } from "node:fs/promises";

const OUT = "_site";
await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/data`, { recursive: true });
await cp("site", OUT, { recursive: true });
for (const f of ["policies.json", "policies.csv", "meta.json"]) await cp(`data/${f}`, `${OUT}/data/${f}`);
await cp("data/LICENSE", `${OUT}/data/LICENSE`);
console.log(`built ${OUT}/`);
