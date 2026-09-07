import fs from "node:fs";
import path from "node:path";

const roots = [
  "src/lib/infrastructure/supabase/yes-hotel",
  "src/lib/application/yes-hotel",
  "src/lib/domain/yes-hotel",
  "src/lib/integrations/ttlock",
  "src/lib/infrastructure/comunicacao",
];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

const files = roots.flatMap((r) => (fs.existsSync(r) ? walk(r) : []));
const re = /from\s+(['"])(\.\.?\/[^'"]+)\1/g;
let changed = 0;

for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  const n = s.replace(re, (m, q, spec) => {
    if (
      spec.endsWith(".ts") ||
      spec.endsWith(".js") ||
      spec.endsWith(".json") ||
      spec.endsWith(".tsx") ||
      spec.endsWith(".mjs")
    ) {
      return m;
    }
    return `from ${q}${spec}.ts${q}`;
  });
  if (n !== s) {
    fs.writeFileSync(f, n);
    changed += 1;
  }
}

console.log(`files_touched=${changed} scanned=${files.length}`);
