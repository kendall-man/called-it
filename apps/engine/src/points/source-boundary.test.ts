import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const POINTS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE_DIRECTORY = resolve(POINTS_DIRECTORY, '..');
const POINTS_POLICY_ROOT = new URL('./', import.meta.url);
const ALLOWED_ENGINE_MODULE = '../ports.js';

type ModuleReferenceForm = 'static' | 'import-type' | 'dynamic-import' | 'require' | 'import-equals';

type ModuleReference = {
  readonly specifier: string | null;
  readonly runtime: boolean;
  readonly form: ModuleReferenceForm;
};

function workspacePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function productionTypeScriptFiles(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    if (!entry.isFile() || !path.endsWith('.ts')) return [];
    if (path.endsWith('.test.ts') || path.endsWith('.test-support.ts') || path.endsWith('.d.ts')) {
      return [];
    }
    return [path];
  });
}

function importRunsAtRuntime(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return bindings !== undefined;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function exportRunsAtRuntime(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
}

function moduleReferences(fileName: string, source: string): readonly ModuleReference[] {
  const sourceFile = ts.createSourceFile(
    fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
  const references: ModuleReference[] = [];
  const add = (node: ts.Node | undefined, runtime: boolean, form: ModuleReferenceForm): void => {
    const specifier = node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
    references.push({ specifier, runtime, form });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, importRunsAtRuntime(node), 'static');
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(node.moduleSpecifier, exportRunsAtRuntime(node), 'static');
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      add(
        ts.isExternalModuleReference(reference) ? reference.expression : undefined,
        !node.isTypeOnly,
        'import-equals',
      );
    }
    if (ts.isCallExpression(node)) {
      const firstArgument = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require');
      if (isDynamicImport) add(firstArgument, true, 'dynamic-import');
      if (isRequire) add(firstArgument, true, 'require');
    }
    if (ts.isImportTypeNode(node)) {
      add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, false, 'import-type');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function pointImportAllowed(fileName: string, reference: ModuleReference): boolean {
  if (
    reference.specifier === null ||
    reference.form === 'dynamic-import' ||
    reference.form === 'require' ||
    reference.form === 'import-equals'
  ) return false;
  const specifier = reference.specifier;
  if (specifier === ALLOWED_ENGINE_MODULE) return true;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  const sourceUrl = new URL(fileName.replaceAll('\\', '/'), POINTS_POLICY_ROOT);
  const targetUrl = new URL(specifier, sourceUrl);
  return sourceUrl.pathname.startsWith(POINTS_POLICY_ROOT.pathname) &&
    targetUrl.pathname.startsWith(POINTS_POLICY_ROOT.pathname);
}

function pointImportViolations(fileName: string, source: string): readonly string[] {
  return moduleReferences(fileName, source)
    .filter((reference) => !pointImportAllowed(fileName, reference))
    .map((reference) => `${fileName} -> ${reference.specifier ?? `<computed:${reference.form}>`}`);
}

function engineDatabaseViolations(fileName: string, source: string): readonly string[] {
  return moduleReferences(fileName, source).flatMap((reference) => {
    const specifier = reference.specifier;
    if (specifier === null) return [];
    const directSupabase = specifier.startsWith('@supabase/');
    const directDbSource = specifier.includes('packages/db');
    const facadeRuntimeOutsideWiring = reference.runtime &&
      specifier.startsWith('@calledit/db') &&
      fileName !== 'wiring.ts';
    return directSupabase || directDbSource || facadeRuntimeOutsideWiring
      ? [`${fileName} -> ${specifier}`]
      : [];
  });
}

describe('points source boundary', () => {
  it('rejects a direct database import in a points module', () => {
    // Given a synthetic points module that bypasses the engine port
    const source = "import { createEngineDb } from '@calledit/db';";
    // When its imports are checked against the points boundary
    const violations = pointImportViolations('fixture.ts', source);
    // Then the direct database dependency is reported
    expect(violations).toEqual(['fixture.ts -> @calledit/db']);
  });

  it('detects normalized traversal mutations in a production points module', () => {
    // Given real points source mutated with traversal spellings that escape the directory
    const source = readFileSync(join(POINTS_DIRECTORY, 'presentation.ts'), 'utf8');
    const mutations = [
      "import './../wiring.js';",
      "import './nested/../../wiring.js';",
      "import './%2e%2e/wiring.js';",
      "import '../ports/../../wiring.js';",
    ];
    // When each mutation is checked against the points boundary
    const violations = mutations.flatMap((mutation) =>
      pointImportViolations('presentation.ts', `${source}\n${mutation}`),
    );
    // Then every normalized escape is reported
    expect(violations).toEqual([
      'presentation.ts -> ./../wiring.js',
      'presentation.ts -> ./nested/../../wiring.js',
      'presentation.ts -> ./%2e%2e/wiring.js',
      'presentation.ts -> ../ports/../../wiring.js',
    ]);
  });

  it('rejects non-static and non-literal module-loading forms', () => {
    // Given module-loading syntax that can bypass a string-only static-import scan
    const sources = [
      "const target = './presentation.js'; import(target);",
      'import value from target;',
      "import('./presentation.js');",
      "require('./presentation.js');",
      "module.require('./presentation.js');",
      "import Presentation = require('./presentation.js');",
    ];
    // When each source is checked against the points boundary
    const violations = sources.flatMap((source) => pointImportViolations('fixture.ts', source));

    // Then computed, dynamic, require, and ImportEquals forms are all reported
    expect(violations).toHaveLength(sources.length);
  });

  it('rejects absolute module specifiers', () => {
    // Given POSIX, URL, and Windows absolute module specifiers
    const sources = [
      "import '/apps/engine/src/points/presentation.js';",
      "import 'file:///apps/engine/src/points/presentation.js';",
      "import 'C:\\\\apps\\\\engine\\\\src\\\\points\\\\presentation.js';",
    ];

    // When each source is checked against the points boundary
    const violations = sources.flatMap((source) => pointImportViolations('fixture.ts', source));

    // Then no absolute spelling is accepted as a local points import
    expect(violations).toHaveLength(sources.length);
  });

  it('allows normalized points imports and the exact engine port', () => {
    // Given static references that stay in points or name the approved engine port
    const source = [
      "import './presentation.js';",
      "export type { PersonalStats } from './nested/../presentation.js';",
      "type Stats = import('../points/presentation.js').PersonalStats;",
      "import type { EngineDb } from '../ports.js';",
    ].join('\n');
    // When the references are checked against the points boundary
    const violations = pointImportViolations('fixture.ts', source);
    // Then all approved static and type-only references remain usable
    expect(violations).toEqual([]);
  });

  it('rejects a direct Supabase client import in engine source', () => {
    // Given an engine module that constructs a Supabase client directly
    const source = "import { createClient } from '@supabase/supabase-js';";

    // When its database imports are checked
    const violations = engineDatabaseViolations('points/fixture.ts', source);

    // Then the facade bypass is reported
    expect(violations).toEqual(['points/fixture.ts -> @supabase/supabase-js']);
  });

  it('keeps production points imports within the points directory and engine port', () => {
    // Given every production TypeScript module in the points directory
    const files = productionTypeScriptFiles(POINTS_DIRECTORY);

    // When all static, dynamic, and type-only imports are checked
    const violations = files.length === 0
      ? ['no production points modules found']
      : files.flatMap((path) => pointImportViolations(
          workspacePath(POINTS_DIRECTORY, path),
          readFileSync(path, 'utf8'),
        ));

    // Then no points module bypasses the engine boundary
    expect(violations).toEqual([]);
  });

  it('keeps engine Supabase access behind the database facade', () => {
    // Given every production TypeScript module in the engine
    const files = productionTypeScriptFiles(ENGINE_SOURCE_DIRECTORY);

    // When direct clients and runtime database-facade imports are checked
    const violations = files.flatMap((path) => engineDatabaseViolations(
      workspacePath(ENGINE_SOURCE_DIRECTORY, path),
      readFileSync(path, 'utf8'),
    ));

    // Then only wiring may consume the database facade at runtime
    expect(violations).toEqual([]);
  });
});
