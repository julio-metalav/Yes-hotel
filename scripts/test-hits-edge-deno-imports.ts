/**
 * Regressão AST: grafo local alcançado por hits-reservation-sync
 * deve usar extensão .ts em todo import/export relativo (bundler Deno).
 *
 * Usa a API TypeScript (createSourceFile + forEachChild). Sem rede. Sem deploy.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(process.cwd());
const ENTRY = resolve(ROOT, "supabase/functions/hits-reservation-sync/index.ts");

const EXTERNAL_PREFIXES = ["jsr:", "npm:", "https:", "http:", "node:"];

type ImportHit = {
  file: string;
  specifier: string;
  line: number;
};

function rel(p: string): string {
  return relative(ROOT, p).replace(/\\/g, "/");
}

function isExternal(specifier: string): boolean {
  return EXTERNAL_PREFIXES.some((p) => specifier.startsWith(p));
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  if (existsSync(base) && extname(base)) return normalize(base);
  const withTs = `${base}.ts`;
  if (existsSync(withTs)) return normalize(withTs);
  const indexTs = join(base, "index.ts");
  if (existsSync(indexTs)) return normalize(indexTs);
  return null;
}

/** Extrai specifiers relativos via AST do TypeScript (não regex). */
function extractRelativeImportsAst(file: string): ImportHit[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hits: ImportHit[] = [];

  const push = (specifier: string, node: ts.Node) => {
    if (!isRelative(specifier) || isExternal(specifier)) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    hits.push({ file, specifier, line: line + 1 });
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      push(node.moduleSpecifier.text, node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      push(node.moduleSpecifier.text, node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      push(node.arguments[0]!.text, node.arguments[0]!);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      push(node.moduleReference.expression.text, node.moduleReference.expression);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return hits;
}

function walkGraph(entry: string): {
  files: string[];
  imports: ImportHit[];
  missingExtension: ImportHit[];
  unresolved: ImportHit[];
} {
  const queue = [normalize(entry)];
  const seen = new Set<string>();
  const imports: ImportHit[] = [];
  const missingExtension: ImportHit[] = [];
  const unresolved: ImportHit[] = [];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(existsSync(file), `arquivo do grafo ausente: ${rel(file)}`);

    for (const hit of extractRelativeImportsAst(file)) {
      imports.push(hit);
      if (!extname(hit.specifier)) missingExtension.push(hit);

      const resolved = resolveRelativeImport(file, hit.specifier);
      if (!resolved) {
        unresolved.push(hit);
        continue;
      }
      if (resolved.startsWith(ROOT) && resolved.endsWith(".ts") && !seen.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return {
    files: [...seen].sort(),
    imports,
    missingExtension,
    unresolved,
  };
}

function main() {
  console.log("\n== AST Deno import graph: hits-reservation-sync ==");
  assert.ok(existsSync(ENTRY), `entrypoint ausente: ${rel(ENTRY)}`);

  const graph = walkGraph(ENTRY);

  if (graph.unresolved.length > 0) {
    for (const hit of graph.unresolved) {
      console.error(`  UNRESOLVED ${rel(hit.file)}:${hit.line} → ${hit.specifier}`);
    }
  }
  assert.equal(graph.unresolved.length, 0, "imports relativos sem resolução em disco");

  if (graph.missingExtension.length > 0) {
    for (const hit of graph.missingExtension) {
      console.error(`  MISSING_EXT ${rel(hit.file)}:${hit.line} → ${hit.specifier}`);
    }
  }
  assert.equal(
    graph.missingExtension.length,
    0,
    "imports relativos sem extensão (.ts) no grafo Edge",
  );

  for (const hit of graph.imports) {
    assert.match(
      hit.specifier,
      /\.ts$/,
      `extensão esperada .ts: ${rel(hit.file)}:${hit.line} → ${hit.specifier}`,
    );
  }

  assert.ok(graph.files.length >= 14, `esperado ≥14 arquivos, got ${graph.files.length}`);
  assert.ok(
    graph.files.some((f) => rel(f).endsWith("fixtures/sync-catalog.ts")),
    "sync-catalog.ts deve estar no grafo",
  );

  const sourceFile = resolve(
    ROOT,
    "src/lib/integrations/hits-mock/hits-mock-reservation-source.ts",
  );
  const sourceHits = extractRelativeImportsAst(sourceFile);
  assert.ok(
    sourceHits.some((h) => h.specifier === "./fixtures/sync-catalog.ts"),
    "hits-mock-reservation-source deve importar ./fixtures/sync-catalog.ts",
  );
  assert.ok(
    !sourceHits.some((h) => h.specifier === "./fixtures/sync-catalog"),
    "import sem extensão ./fixtures/sync-catalog não pode permanecer",
  );

  console.log(
    `  ok files=${graph.files.length} relative_imports=${graph.imports.length} missing_ext=0 unresolved=0`,
  );
  for (const f of graph.files) {
    console.log(`    - ${rel(f)}`);
  }
  console.log("\nOK test-hits-edge-deno-imports (AST)");
}

main();
