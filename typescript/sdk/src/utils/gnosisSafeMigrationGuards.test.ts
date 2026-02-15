import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';

import { expect } from 'chai';

const SOURCE_FILE_GLOB = '*.{ts,tsx,js,jsx,mts,mtsx,cts,ctsx,mjs,cjs}' as const;

type SdkPackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type ModuleSpecifierReference = {
  source: string;
  filePath: string;
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

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some(
    (modifier: ts.Modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function extractNamedExportSymbols(
  sourceText: string,
  modulePath: string,
  filePath: string,
  fallbackModuleExportSymbols: readonly string[] = [],
): string[] {
  const symbols = new Set<string>();
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );

  const visit = (node: ts.Node) => {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === modulePath &&
      node.exportClause
    ) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const exportSpecifier of node.exportClause.elements) {
          symbols.add(
            normalizeNamedSymbol(
              exportSpecifier.propertyName?.text ?? exportSpecifier.name.text,
            ),
          );
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === modulePath &&
      !node.exportClause &&
      !node.isTypeOnly
    ) {
      for (const symbol of fallbackModuleExportSymbols) {
        symbols.add(normalizeNamedSymbol(symbol));
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...symbols].filter(Boolean);
}

function extractTopLevelDeclarationExports(
  sourceText: string,
  filePath: string,
): string[] {
  const symbols = new Set<string>();
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );

  const collectBindingIdentifiers = (name: ts.BindingName): string[] => {
    if (ts.isIdentifier(name)) return [name.text];
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      return name.elements.flatMap((element) =>
        ts.isBindingElement(element)
          ? element.dotDotDotToken
            ? []
            : collectBindingIdentifiers(element.name)
          : [],
      );
    }
    return [];
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const exportSpecifier of statement.exportClause.elements) {
        symbols.add(exportSpecifier.name.text);
      }
      continue;
    }

    if (!hasExportModifier(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      symbols.add(statement.name.text);
      continue;
    }
    if (
      (ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      symbols.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const symbol of collectBindingIdentifiers(declaration.name)) {
          symbols.add(symbol);
        }
      }
    }
  }

  return [...symbols].map(normalizeNamedSymbol).filter(Boolean);
}

function getScriptKind(filePath: string): ts.ScriptKind {
  if (/\.(?:[cm]?tsx)$/.test(filePath)) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(?:[cm]?js)$/.test(filePath) || filePath.endsWith('.mjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function readModuleSourceArg(
  callExpression: ts.CallExpression,
): string | undefined {
  const [firstArg] = callExpression.arguments;
  if (firstArg && ts.isStringLiteralLike(firstArg)) return firstArg.text;
  return undefined;
}

function collectModuleSpecifierReferences(
  contents: string,
  filePath: string,
): ModuleSpecifierReference[] {
  const references: ModuleSpecifierReference[] = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );

  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      references.push({ source: node.moduleSpecifier.text, filePath });
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      references.push({
        source: node.moduleReference.expression.text,
        filePath,
      });
    }

    if (ts.isExportDeclaration(node)) {
      if (
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        references.push({ source: node.moduleSpecifier.text, filePath });
      }
    }

    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (
        ts.isLiteralTypeNode(argument) &&
        ts.isStringLiteralLike(argument.literal)
      ) {
        references.push({ source: argument.literal.text, filePath });
      }
    }

    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require'
      ) {
        const source = readModuleSourceArg(node);
        if (source) references.push({ source, filePath });
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const source = readModuleSourceArg(node);
        if (source) references.push({ source, filePath });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references;
}

function collectSdkSourceFilePaths(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const filePaths: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...collectSdkSourceFilePaths(entryPath));
      continue;
    }
    if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) continue;
    filePaths.push(entryPath);
  }
  return filePaths;
}

function isInfraModuleSpecifier(source: string): boolean {
  return (
    source === '@hyperlane-xyz/infra' ||
    source.startsWith('@hyperlane-xyz/infra/') ||
    source.includes('typescript/infra') ||
    source.includes('/infra/') ||
    source.includes('../../infra')
  );
}

function expectNoRipgrepMatches(pattern: string, description: string): void {
  try {
    const output = execFileSync(
      'rg',
      [pattern, 'src', '--glob', SOURCE_FILE_GLOB],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    expect.fail(`Found disallowed ${description}:\n${output}`);
  } catch (error) {
    const commandError = error as Error & { status?: number };
    // rg exits with status 1 when no matches are found.
    if (commandError.status === 1) {
      return;
    }
    throw error;
  }
}

describe('Gnosis Safe migration guards', () => {
  it('extracts wildcard module re-exports with fallback symbols', () => {
    const source = "export * from './fixtures/guard-module.js';";
    const symbols = extractNamedExportSymbols(
      source,
      './fixtures/guard-module.js',
      'fixture.ts',
      ['getSafe', 'createSafeTransaction', 'getSafe'],
    );
    expect(symbols).to.deep.equal(['getSafe', 'createSafeTransaction']);
  });

  it('ignores type-only wildcard module re-exports for fallback symbols', () => {
    const source = "export type * from './fixtures/guard-module.js';";
    const symbols = extractNamedExportSymbols(
      source,
      './fixtures/guard-module.js',
      'fixture.ts',
      ['getSafe', 'createSafeTransaction'],
    );
    expect(symbols).to.deep.equal([]);
  });

  it('extracts local export specifier aliases from source declarations', () => {
    const source = [
      'const internalCall = 1;',
      'export { internalCall as SafeCallData };',
      'const internalStatus = 2;',
      'export { internalStatus as SafeStatus };',
    ].join('\n');
    const symbols = extractTopLevelDeclarationExports(source, 'fixture.ts');
    expect(symbols).to.deep.equal(['SafeCallData', 'SafeStatus']);
  });

  it('prevents sdk source imports from infra paths', () => {
    const sourceFilePaths = collectSdkSourceFilePaths(
      path.resolve(process.cwd(), 'src'),
    );
    const infraModuleReferences: string[] = [];
    for (const sourceFilePath of sourceFilePaths) {
      const contents = fs.readFileSync(sourceFilePath, 'utf8');
      const references = collectModuleSpecifierReferences(
        contents,
        sourceFilePath,
      );
      for (const reference of references) {
        if (!isInfraModuleSpecifier(reference.source)) continue;
        infraModuleReferences.push(
          `${path.relative(process.cwd(), reference.filePath)} -> ${reference.source}`,
        );
      }
    }
    expect(
      infraModuleReferences,
      'Found sdk module specifier references to infra paths/packages',
    ).to.deep.equal([]);

    expectNoRipgrepMatches(
      String.raw`(?:from ['"]|require\(['"]|import\(['"])(?:@hyperlane-xyz/infra|.*typescript/infra|.*\/infra\/|\.\.\/\.\.\/infra)`,
      'sdk imports that reference infra paths or packages',
    );
  });

  it('keeps gnosis safe helpers exported from sdk index', () => {
    const indexPath = path.resolve(process.cwd(), 'src/index.ts');
    const gnosisSafePath = path.resolve(
      process.cwd(),
      'src/utils/gnosisSafe.ts',
    );
    const indexText = fs.readFileSync(indexPath, 'utf8');
    const gnosisSafeText = fs.readFileSync(gnosisSafePath, 'utf8');
    const moduleExports = extractTopLevelDeclarationExports(
      gnosisSafeText,
      gnosisSafePath,
    );
    const gnosisSafeExports = extractNamedExportSymbols(
      indexText,
      './utils/gnosisSafe.js',
      indexPath,
      moduleExports,
    );
    expect(gnosisSafeExports.length).to.be.greaterThan(
      0,
      'Expected to find named exports for ./utils/gnosisSafe.js in sdk index',
    );

    const requiredExports = [
      'asHex',
      'canProposeSafeTransactions',
      'getSafeAndService',
      'getPendingTxsForChains',
      'createSafeDeploymentTransaction',
      'createSafeTransaction',
      'createSafeTransactionData',
      'DEFAULT_SAFE_DEPLOYMENT_VERSIONS',
      'decodeMultiSendData',
      'deleteAllPendingSafeTxs',
      'deleteSafeTx',
      'executeTx',
      'getKnownMultiSendAddresses',
      'getOwnerChanges',
      'getSafe',
      'getSafeDelegates',
      'getSafeService',
      'getSafeTx',
      'hasSafeServiceTransactionPayload',
      'isLegacySafeApi',
      'normalizeSafeServiceUrl',
      'ParseableSafeTx',
      'parseSafeTx',
      'proposeSafeTransaction',
      'resolveSafeSigner',
      'retrySafeApi',
      'safeApiKeyRequired',
      'updateSafeOwner',
      'SafeAndService',
      'SafeCallData',
      'SafeDeploymentConfig',
      'SafeDeploymentTransaction',
      'SafeOwnerUpdateCall',
      'SafeServiceTransaction',
      'SafeServiceTransactionWithPayload',
      'SafeStatus',
      'SafeTxStatus',
    ];

    for (const exportedSymbol of requiredExports) {
      expect(
        gnosisSafeExports.includes(exportedSymbol),
        `Expected sdk index gnosisSafe export list to include ${exportedSymbol}`,
      ).to.equal(true);
    }

    const missingExports = moduleExports.filter(
      (symbol) => !gnosisSafeExports.includes(symbol),
    );
    expect(
      missingExports,
      'Expected sdk index to re-export all top-level gnosisSafe module exports',
    ).to.deep.equal([]);
  });

  it('keeps sdk package free of infra dependency edges', () => {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    const packageJson: SdkPackageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf8'),
    );

    const allDependencyNames = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
    ];

    expect(
      allDependencyNames.includes('@hyperlane-xyz/infra'),
      'SDK package.json should not depend on @hyperlane-xyz/infra',
    ).to.equal(false);
  });
});
