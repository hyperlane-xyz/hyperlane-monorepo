import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';

import { expect } from 'chai';

type InfraPackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const REQUIRED_SAFE_HELPER_EXPORTS = [
  'createSafeDeploymentTransaction',
  'createSafeTransaction',
  'createSafeTransactionData',
  'decodeMultiSendData',
  'deleteAllPendingSafeTxs',
  'deleteSafeTx',
  'executeTx',
  'getPendingTxsForChains',
  'getSafe',
  'getSafeAndService',
  'getSafeDelegates',
  'getSafeService',
  'getSafeTx',
  'ParseableSafeTx',
  'parseSafeTx',
  'proposeSafeTransaction',
  'updateSafeOwner',
  'SafeTxStatus',
] as const;

const INFRA_SOURCE_PATHS = ['scripts', 'src', 'config'] as const;
const INFRA_SOURCE_AND_TEST_PATHS = [...INFRA_SOURCE_PATHS, 'test'] as const;
const SOURCE_FILE_GLOB = '*.{ts,tsx,js,jsx,mts,mtsx,cts,ctsx,mjs,cjs}' as const;

type SymbolSourceReference = {
  symbol: string;
  source: string;
};

function normalizeNamedSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  if (!trimmed || trimmed.startsWith('...')) return '';
  return trimmed
    .replace(/^type\s+/, '')
    .replace(/\s+as\s+\w+$/, '')
    .replace(/\s*:\s*[^:]+$/, '')
    .replace(/\s*=\s*.+$/, '')
    .trim();
}

function getScriptKind(filePath: string): ts.ScriptKind {
  if (/\.(?:[cm]?tsx)$/.test(filePath)) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(?:[cm]?js)$/.test(filePath) || filePath.endsWith('.mjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function unwrapInitializerExpression(expression: ts.Expression): ts.Expression {
  if (ts.isAwaitExpression(expression)) {
    return unwrapInitializerExpression(expression.expression);
  }
  if (ts.isParenthesizedExpression(expression)) {
    return unwrapInitializerExpression(expression.expression);
  }
  return expression;
}

function readModuleSourceArg(
  callExpression: ts.CallExpression,
): string | undefined {
  const [firstArg] = callExpression.arguments;
  if (firstArg && ts.isStringLiteralLike(firstArg)) return firstArg.text;
  return undefined;
}

function readModuleSourceFromInitializer(
  expression: ts.Expression,
): string | undefined {
  const unwrapped = unwrapInitializerExpression(expression);
  if (!ts.isCallExpression(unwrapped)) return undefined;

  if (
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.expression.text === 'require'
  ) {
    return readModuleSourceArg(unwrapped);
  }
  if (unwrapped.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return readModuleSourceArg(unwrapped);
  }
  return undefined;
}

function readBindingElementSymbol(element: ts.BindingElement): string {
  if (element.propertyName) {
    if (ts.isIdentifier(element.propertyName)) return element.propertyName.text;
    if (ts.isStringLiteralLike(element.propertyName))
      return element.propertyName.text;
  }
  if (ts.isIdentifier(element.name)) return element.name.text;
  return '';
}

function collectSymbolSourceReferences(
  contents: string,
  filePath: string,
): SymbolSourceReference[] {
  const references: SymbolSourceReference[] = [];
  const moduleAliasByIdentifier = new Map<string, string>();
  const sourceFile = ts.createSourceFile(
    filePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const source = ts.isStringLiteralLike(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
      if (source && node.importClause?.name) {
        moduleAliasByIdentifier.set(node.importClause.name.text, source);
      }
      const namedBindings = node.importClause?.namedBindings;
      if (source && namedBindings) {
        if (ts.isNamespaceImport(namedBindings)) {
          moduleAliasByIdentifier.set(namedBindings.name.text, source);
        }
        if (ts.isNamedImports(namedBindings)) {
          for (const importSpecifier of namedBindings.elements) {
            references.push({
              symbol: normalizeNamedSymbol(
                importSpecifier.propertyName?.text ?? importSpecifier.name.text,
              ),
              source,
            });
          }
        }
      }
    }

    if (ts.isExportDeclaration(node)) {
      const source = node.moduleSpecifier;
      const namedExports = node.exportClause;
      if (
        source &&
        ts.isStringLiteralLike(source) &&
        namedExports &&
        ts.isNamedExports(namedExports)
      ) {
        for (const exportSpecifier of namedExports.elements) {
          references.push({
            symbol: normalizeNamedSymbol(
              exportSpecifier.propertyName?.text ?? exportSpecifier.name.text,
            ),
            source: source.text,
          });
        }
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const source = node.initializer
        ? readModuleSourceFromInitializer(node.initializer)
        : undefined;
      if (source) {
        moduleAliasByIdentifier.set(node.name.text, source);
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const directSource = node.initializer
        ? readModuleSourceFromInitializer(node.initializer)
        : undefined;
      const initializer = node.initializer
        ? unwrapInitializerExpression(node.initializer)
        : undefined;
      const aliasSource =
        initializer && ts.isIdentifier(initializer)
          ? moduleAliasByIdentifier.get(initializer.text)
          : undefined;
      const source = directSource ?? aliasSource;
      if (source) {
        for (const bindingElement of node.name.elements) {
          if (bindingElement.dotDotDotToken) continue;
          references.push({
            symbol: normalizeNamedSymbol(
              readBindingElementSymbol(bindingElement),
            ),
            source,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references.filter((reference) => reference.symbol.length > 0);
}

function collectDeclaredSymbols(contents: string, filePath: string): string[] {
  const symbols: string[] = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push(node.name.text);
    } else if (ts.isClassDeclaration(node) && node.name) {
      symbols.push(node.name.text);
    } else if (ts.isInterfaceDeclaration(node)) {
      symbols.push(node.name.text);
    } else if (ts.isTypeAliasDeclaration(node)) {
      symbols.push(node.name.text);
    } else if (ts.isEnumDeclaration(node)) {
      symbols.push(node.name.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      symbols.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return symbols.map(normalizeNamedSymbol).filter(Boolean);
}

function collectProjectSourceFilePaths(paths: readonly string[]): string[] {
  const sourceFilePaths: string[] = [];
  const walk = (currentPath: string) => {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) continue;
      sourceFilePaths.push(entryPath);
    }
  };
  for (const root of paths) {
    walk(path.join(process.cwd(), root));
  }
  return sourceFilePaths;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectNoRipgrepMatches(
  pattern: string,
  description: string,
  paths: readonly string[] = INFRA_SOURCE_PATHS,
): void {
  try {
    const output = execFileSync(
      'rg',
      [pattern, ...paths, '--glob', SOURCE_FILE_GLOB],
      {
        encoding: 'utf8',
      },
    );
    expect.fail(`Found disallowed ${description}:\n${output}`);
  } catch (error) {
    const commandError = error as Error & { status?: number };
    // rg returns exit code 1 when there are no matches.
    if (commandError.status === 1) {
      return;
    }
    throw error;
  }
}

function extractNamedExportSymbols(
  sourceText: string,
  modulePath: string,
): string[] {
  const exportClausePattern = new RegExp(
    `export(?:\\s+type)?\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapeRegExp(modulePath)}['"]\\s*;`,
    'g',
  );
  return [...sourceText.matchAll(exportClausePattern)].flatMap((match) =>
    match[1].split(',').map(normalizeNamedSymbol).filter(Boolean),
  );
}

function getSdkGnosisSafeExports(): string[] {
  const sdkIndexPath = path.resolve(process.cwd(), '../sdk/src/index.ts');
  const sdkIndexText = fs.readFileSync(sdkIndexPath, 'utf8');
  return extractNamedExportSymbols(sdkIndexText, './utils/gnosisSafe.js');
}

describe('Safe migration guards', () => {
  it('keeps legacy infra safe utility module deleted', () => {
    const legacySafeUtilPath = path.join(process.cwd(), 'src/utils/safe.ts');
    expect(fs.existsSync(legacySafeUtilPath)).to.equal(false);
  });

  it('prevents reintroducing infra local safe util imports', () => {
    expectNoRipgrepMatches(
      String.raw`(?:from ['"][^'"]*utils/safe|require\(['"][^'"]*utils/safe|import\(['"][^'"]*utils/safe)`,
      'legacy infra safe util import path usage',
      INFRA_SOURCE_AND_TEST_PATHS,
    );
  });

  it('ensures migrated safe helper symbols are only imported from sdk', () => {
    const disallowedImports: string[] = [];
    const sdkSafeHelperExports = new Set(getSdkGnosisSafeExports());
    expect(sdkSafeHelperExports.size).to.be.greaterThan(
      0,
      'Expected sdk index to export symbols from ./utils/gnosisSafe.js',
    );

    const sourceFilePaths = collectProjectSourceFilePaths(
      INFRA_SOURCE_AND_TEST_PATHS,
    );
    for (const sourceFilePath of sourceFilePaths) {
      const contents = fs.readFileSync(sourceFilePath, 'utf8');
      const symbolSourceReferences = collectSymbolSourceReferences(
        contents,
        sourceFilePath,
      );
      for (const { symbol: safeSymbol, source } of symbolSourceReferences) {
        if (
          sdkSafeHelperExports.has(safeSymbol) &&
          source !== '@hyperlane-xyz/sdk'
        ) {
          disallowedImports.push(
            `${path.relative(process.cwd(), sourceFilePath)} -> ${safeSymbol} from ${source}`,
          );
        }
      }
    }

    expect(disallowedImports).to.deep.equal([]);
  });

  it('prevents direct @safe-global imports in infra source', () => {
    expectNoRipgrepMatches(
      String.raw`from ['"]@safe-global|require\(['"]@safe-global|import\(['"]@safe-global`,
      '@safe-global imports in infra sources',
      INFRA_SOURCE_AND_TEST_PATHS,
    );
  });

  it('prevents imports from sdk internal gnosis safe module paths', () => {
    expectNoRipgrepMatches(
      String.raw`from ['"]@hyperlane-xyz/sdk\/.*gnosisSafe|from ['"].*\/gnosisSafe(\.js)?['"]|require\(['"]@hyperlane-xyz/sdk\/.*gnosisSafe|require\(['"].*\/gnosisSafe(\.js)?['"]|import\(['"]@hyperlane-xyz/sdk\/.*gnosisSafe|import\(['"].*\/gnosisSafe(\.js)?['"]`,
      'gnosis safe imports that bypass @hyperlane-xyz/sdk entrypoint',
      INFRA_SOURCE_AND_TEST_PATHS,
    );
  });

  it('prevents imports from sdk source or subpath entrypoints', () => {
    expectNoRipgrepMatches(
      String.raw`(?:from ['"]|require\(['"]|import\(['"])(?:@hyperlane-xyz/sdk\/|(?:\.\.?\/)+.*sdk\/src\/|(?:\.\.?\/)+.*typescript\/sdk\/|.*typescript\/sdk\/src\/)`,
      'sdk source-path or package subpath imports',
      INFRA_SOURCE_AND_TEST_PATHS,
    );
  });

  it('keeps @safe-global dependencies out of infra package.json', () => {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const packageJson: InfraPackageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf8'),
    );

    const allDependencyNames = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
    ];

    const safeGlobalDeps = allDependencyNames.filter((dep) =>
      dep.startsWith('@safe-global/'),
    );

    expect(safeGlobalDeps).to.deep.equal([]);
  });

  it('prevents reintroducing local safe helper implementations', () => {
    const sdkSafeHelperExports = new Set(getSdkGnosisSafeExports());
    expect(sdkSafeHelperExports.size).to.be.greaterThan(
      0,
      'Expected sdk gnosis safe export list to be non-empty',
    );
    const disallowedDeclarations: string[] = [];
    const sourceFilePaths = collectProjectSourceFilePaths(INFRA_SOURCE_PATHS);
    for (const sourceFilePath of sourceFilePaths) {
      const contents = fs.readFileSync(sourceFilePath, 'utf8');
      const declaredSymbols = collectDeclaredSymbols(contents, sourceFilePath);
      for (const declaredSymbol of declaredSymbols) {
        if (sdkSafeHelperExports.has(declaredSymbol)) {
          disallowedDeclarations.push(
            `${path.relative(process.cwd(), sourceFilePath)} -> ${declaredSymbol}`,
          );
        }
      }
    }
    expect(disallowedDeclarations).to.deep.equal([]);
  });

  it('ensures sdk index continues exporting core safe helpers', () => {
    const sdkSafeHelperExports = new Set(getSdkGnosisSafeExports());

    for (const exportedSymbol of REQUIRED_SAFE_HELPER_EXPORTS) {
      expect(
        sdkSafeHelperExports.has(exportedSymbol),
        `Expected sdk index to export ${exportedSymbol}`,
      ).to.equal(true);
    }
  });
});
