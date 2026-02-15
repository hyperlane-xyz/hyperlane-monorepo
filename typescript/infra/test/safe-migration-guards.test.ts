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

type ModuleSpecifierReference = {
  source: string;
  filePath: string;
};

type NamedExportSymbolReference = {
  symbol: string;
  isTypeOnly: boolean;
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

function hasDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some(
    (modifier: ts.Modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
  );
}

function hasDefaultExportInSourceFile(
  sourceText: string,
  filePath: string,
): boolean {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );

  return sourceFile.statements.some((statement) => {
    if (ts.isExportAssignment(statement)) {
      return !statement.isExportEquals;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        return statement.exportClause.elements.some(
          (specifier) =>
            specifier.name.text === 'default' ||
            specifier.propertyName?.text === 'default',
        );
      }
      if (ts.isNamespaceExport(statement.exportClause)) {
        return statement.exportClause.name.text === 'default';
      }
    }
    return hasExportModifier(statement) && hasDefaultModifier(statement);
  });
}

function hasDefaultReExportFromModule(
  sourceText: string,
  filePath: string,
  modulePath: string,
): boolean {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );

  const visit = (node: ts.Node): boolean => {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === modulePath &&
      node.exportClause
    ) {
      if (ts.isNamedExports(node.exportClause)) {
        return node.exportClause.elements.some(
          (specifier) =>
            specifier.name.text === 'default' ||
            specifier.propertyName?.text === 'default',
        );
      }
      if (ts.isNamespaceExport(node.exportClause)) {
        return node.exportClause.name.text === 'default';
      }
    }

    return ts.forEachChild(node, visit) ?? false;
  };

  return visit(sourceFile);
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

function resolveModuleSourceFromExpression(
  expression: ts.Expression,
  moduleAliasByIdentifier: Map<string, string>,
): string | undefined {
  const unwrapped = unwrapInitializerExpression(expression);
  const directSource = readModuleSourceFromInitializer(unwrapped);
  if (directSource) return directSource;
  if (ts.isIdentifier(unwrapped)) {
    return moduleAliasByIdentifier.get(unwrapped.text);
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return resolveModuleSourceFromExpression(
      unwrapped.expression,
      moduleAliasByIdentifier,
    );
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    return resolveModuleSourceFromExpression(
      unwrapped.expression,
      moduleAliasByIdentifier,
    );
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

function readImportTypeQualifierSymbol(
  qualifier: ts.EntityName | undefined,
): string {
  if (!qualifier) return '';
  if (ts.isIdentifier(qualifier)) return qualifier.text;
  return readImportTypeQualifierSymbol(qualifier.left);
}

function resolveModuleSourceFromEntityName(
  name: ts.EntityName,
  moduleAliasByIdentifier: Map<string, string>,
): string | undefined {
  if (ts.isIdentifier(name)) return moduleAliasByIdentifier.get(name.text);
  return resolveModuleSourceFromEntityName(name.left, moduleAliasByIdentifier);
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

  const readSpecifierSymbols = (
    specifier: ts.ImportSpecifier | ts.ExportSpecifier,
  ): string[] => {
    const symbols = new Set<string>();
    symbols.add(normalizeNamedSymbol(specifier.name.text));
    if (specifier.propertyName) {
      symbols.add(normalizeNamedSymbol(specifier.propertyName.text));
    }
    return [...symbols].filter(Boolean);
  };

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
            for (const symbol of readSpecifierSymbols(importSpecifier)) {
              references.push({ symbol, source });
            }
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
          for (const symbol of readSpecifierSymbols(exportSpecifier)) {
            references.push({ symbol, source: source.text });
          }
        }
      }
    }

    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (
        ts.isLiteralTypeNode(argument) &&
        ts.isStringLiteralLike(argument.literal)
      ) {
        const symbol = normalizeNamedSymbol(
          readImportTypeQualifierSymbol(node.qualifier),
        );
        if (symbol) {
          references.push({ symbol, source: argument.literal.text });
        }
      }
    }

    if (ts.isQualifiedName(node)) {
      const source = resolveModuleSourceFromEntityName(
        node.left,
        moduleAliasByIdentifier,
      );
      if (source) {
        references.push({
          symbol: normalizeNamedSymbol(node.right.text),
          source,
        });
      }
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      moduleAliasByIdentifier.set(
        node.name.text,
        node.moduleReference.expression.text,
      );
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer
        ? unwrapInitializerExpression(node.initializer)
        : undefined;
      const source = initializer
        ? resolveModuleSourceFromExpression(
            initializer,
            moduleAliasByIdentifier,
          )
        : undefined;
      if (source) {
        moduleAliasByIdentifier.set(node.name.text, source);
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const rightExpression = unwrapInitializerExpression(node.right);
      const source = resolveModuleSourceFromExpression(
        rightExpression,
        moduleAliasByIdentifier,
      );
      if (source) {
        moduleAliasByIdentifier.set(node.left.text, source);
      } else {
        moduleAliasByIdentifier.delete(node.left.text);
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const source = resolveModuleSourceFromExpression(
        node.expression,
        moduleAliasByIdentifier,
      );
      if (source) {
        references.push({
          symbol: normalizeNamedSymbol(node.name.text),
          source,
        });
      }
    }

    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      const source = resolveModuleSourceFromExpression(
        node.expression,
        moduleAliasByIdentifier,
      );
      if (source) {
        references.push({
          symbol: normalizeNamedSymbol(node.argumentExpression.text),
          source,
        });
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const initializer = node.initializer
        ? unwrapInitializerExpression(node.initializer)
        : undefined;
      const source = initializer
        ? resolveModuleSourceFromExpression(
            initializer,
            moduleAliasByIdentifier,
          )
        : undefined;
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

function collectProjectModuleSpecifierReferences(
  paths: readonly string[],
): ModuleSpecifierReference[] {
  return collectProjectSourceFilePaths(paths).flatMap((sourceFilePath) =>
    collectModuleSpecifierReferences(
      fs.readFileSync(sourceFilePath, 'utf8'),
      sourceFilePath,
    ),
  );
}

function formatModuleSpecifierReference(
  reference: ModuleSpecifierReference,
): string {
  return `${path.relative(process.cwd(), reference.filePath)} -> ${reference.source}`;
}

function getDisallowedModuleSpecifierReferences(
  paths: readonly string[],
  isDisallowed: (source: string) => boolean,
): string[] {
  return collectProjectModuleSpecifierReferences(paths)
    .filter((reference) => isDisallowed(reference.source))
    .map(formatModuleSpecifierReference);
}

function isLegacySafeUtilSpecifier(source: string): boolean {
  return /(?:^|\/)utils\/safe(?:\.[cm]?[jt]sx?)?(?:$|\/)/.test(source);
}

function isSafeGlobalSpecifier(source: string): boolean {
  return source === '@safe-global' || source.startsWith('@safe-global/');
}

function isSdkInternalGnosisSafeSpecifier(source: string): boolean {
  if (source.startsWith('@hyperlane-xyz/sdk/')) {
    return source.includes('gnosisSafe');
  }
  return /(?:^|\/)gnosisSafe(?:\.[cm]?[jt]sx?)?$/.test(source);
}

function isSdkSubpathOrSourceSpecifier(source: string): boolean {
  return (
    source.startsWith('@hyperlane-xyz/sdk/') ||
    source.includes('/sdk/src/') ||
    source.includes('typescript/sdk/src/') ||
    source.includes('typescript/sdk/')
  );
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
  filePath: string,
  fallbackModuleExportSymbols: readonly string[] = [],
): string[] {
  return [
    ...new Set(
      extractNamedExportSymbolReferences(
        sourceText,
        modulePath,
        filePath,
        fallbackModuleExportSymbols,
      ).map((reference) => reference.symbol),
    ),
  ];
}

function extractNamedExportSymbolReferences(
  sourceText: string,
  modulePath: string,
  filePath: string,
  fallbackModuleExportSymbols: readonly string[] = [],
): NamedExportSymbolReference[] {
  const references: NamedExportSymbolReference[] = [];
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
          references.push({
            symbol: normalizeNamedSymbol(exportSpecifier.name.text),
            isTypeOnly: node.isTypeOnly || exportSpecifier.isTypeOnly,
          });
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
        references.push({
          symbol: normalizeNamedSymbol(symbol),
          isTypeOnly: false,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references.filter((reference) => reference.symbol.length > 0);
}

function hasValueExport(
  references: readonly NamedExportSymbolReference[],
  symbol: string,
): boolean {
  return references.some(
    (reference) => reference.symbol === symbol && !reference.isTypeOnly,
  );
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
      if (hasDefaultModifier(statement)) continue;
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
      if (hasDefaultModifier(statement)) continue;
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

function getSdkGnosisSafeExportReferences(): NamedExportSymbolReference[] {
  const sdkIndexPath = path.resolve(process.cwd(), '../sdk/src/index.ts');
  const sdkIndexText = fs.readFileSync(sdkIndexPath, 'utf8');
  const sdkGnosisSafePath = path.resolve(
    process.cwd(),
    '../sdk/src/utils/gnosisSafe.ts',
  );
  const sdkGnosisSafeText = fs.readFileSync(sdkGnosisSafePath, 'utf8');
  const fallbackGnosisSafeExports = extractTopLevelDeclarationExports(
    sdkGnosisSafeText,
    sdkGnosisSafePath,
  );
  return extractNamedExportSymbolReferences(
    sdkIndexText,
    './utils/gnosisSafe.js',
    sdkIndexPath,
    fallbackGnosisSafeExports,
  );
}

function getSdkGnosisSafeExports(): string[] {
  return [...new Set(getSdkGnosisSafeExportReferences().map((r) => r.symbol))];
}

describe('Safe migration guards', () => {
  it('extracts wildcard sdk module re-exports with fallback symbols', () => {
    const source = "export * from './fixtures/guard-module.js';";
    const symbols = extractNamedExportSymbols(
      source,
      './fixtures/guard-module.js',
      'fixture.ts',
      ['getSafe', 'createSafeTransaction', 'getSafe'],
    );
    expect(symbols).to.deep.equal(['getSafe', 'createSafeTransaction']);
  });

  it('tracks export aliases by their public symbol names', () => {
    const source =
      "export { internalGetSafe as getSafe } from './fixtures/guard-module.js';";
    const symbols = extractNamedExportSymbols(
      source,
      './fixtures/guard-module.js',
      'fixture.ts',
    );
    expect(symbols).to.deep.equal(['getSafe']);
  });

  it('tracks type-only named export specifiers', () => {
    const source =
      "export { type getSafe as getSafe } from './fixtures/guard-module.js';";
    const references = extractNamedExportSymbolReferences(
      source,
      './fixtures/guard-module.js',
      'fixture.ts',
    );
    expect(references).to.deep.equal([{ symbol: 'getSafe', isTypeOnly: true }]);
  });

  it('tracks mixed value and type named export specifiers', () => {
    const source =
      "export { type ParseableSafeTx, getSafe } from './fixtures/guard-module.js';";
    const references = extractNamedExportSymbolReferences(
      source,
      './fixtures/guard-module.js',
      'fixture.ts',
    );
    expect(references).to.deep.equal([
      { symbol: 'ParseableSafeTx', isTypeOnly: true },
      { symbol: 'getSafe', isTypeOnly: false },
    ]);
  });

  it('detects runtime export when symbol is exported as both type and value', () => {
    const references: NamedExportSymbolReference[] = [
      { symbol: 'getSafe', isTypeOnly: true },
      { symbol: 'getSafe', isTypeOnly: false },
    ];
    expect(hasValueExport(references, 'getSafe')).to.equal(true);
  });

  it('rejects runtime export when symbol is only type-exported', () => {
    const references: NamedExportSymbolReference[] = [
      { symbol: 'ParseableSafeTx', isTypeOnly: true },
      { symbol: 'SafeCallData', isTypeOnly: true },
    ];
    expect(hasValueExport(references, 'ParseableSafeTx')).to.equal(false);
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

  it('extracts top-level export aliases from local declarations', () => {
    const source = [
      'const internalCall = 1;',
      'export { internalCall as SafeCallData };',
      'const internalStatus = 2;',
      'export { internalStatus as SafeStatus };',
    ].join('\n');
    const symbols = extractTopLevelDeclarationExports(source, 'fixture.ts');
    expect(symbols).to.deep.equal(['SafeCallData', 'SafeStatus']);
  });

  it('ignores default exports in top-level declaration extraction', () => {
    const source = [
      'export default function internalDefault() { return 1; }',
      'export function getSafe() { return 2; }',
      'export default class InternalDefaultClass {}',
      'export class SafeStatus {}',
    ].join('\n');
    const symbols = extractTopLevelDeclarationExports(source, 'fixture.ts');
    expect(symbols).to.deep.equal(['getSafe', 'SafeStatus']);
  });

  it('detects default export assignments in source-file scan', () => {
    const source = [
      'const internalValue = 1;',
      'export default internalValue;',
    ].join('\n');
    expect(hasDefaultExportInSourceFile(source, 'fixture.ts')).to.equal(true);
  });

  it('detects local default export alias declarations', () => {
    const source = [
      'const getSafe = () => 1;',
      'export { getSafe as default };',
    ].join('\n');
    expect(hasDefaultExportInSourceFile(source, 'fixture.ts')).to.equal(true);
  });

  it('detects default re-exports from specific modules', () => {
    const source = [
      "export { default as SafeDefault } from './fixtures/guard-module.js';",
      "export { getSafe } from './fixtures/guard-module.js';",
    ].join('\n');
    expect(
      hasDefaultReExportFromModule(
        source,
        'fixture.ts',
        './fixtures/guard-module.js',
      ),
    ).to.equal(true);
    expect(
      hasDefaultReExportFromModule(source, 'fixture.ts', './fixtures/other.js'),
    ).to.equal(false);
  });

  it('detects namespace default re-exports from specific modules', () => {
    const source = [
      "export * as default from './fixtures/guard-module.js';",
      "export * as helpers from './fixtures/guard-module.js';",
    ].join('\n');
    expect(
      hasDefaultReExportFromModule(
        source,
        'fixture.ts',
        './fixtures/guard-module.js',
      ),
    ).to.equal(true);
    expect(
      hasDefaultReExportFromModule(source, 'fixture.ts', './fixtures/other.js'),
    ).to.equal(false);
  });

  it('tracks aliased named import and export symbols from module specifiers', () => {
    const source = [
      "import { default as getSafe, parseSafeTx as parseAlias } from './fixtures/guard-module.js';",
      "export { default as SafeDefault, parseAlias as parseSafeTx } from './fixtures/guard-module.js';",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include.members([
      'default@./fixtures/guard-module.js',
      'getSafe@./fixtures/guard-module.js',
      'parseSafeTx@./fixtures/guard-module.js',
      'parseAlias@./fixtures/guard-module.js',
      'SafeDefault@./fixtures/guard-module.js',
    ]);
  });

  it('keeps required runtime safe helpers value-exported from sdk index', () => {
    const runtimeRequiredExports = REQUIRED_SAFE_HELPER_EXPORTS.filter(
      (symbol) => symbol !== 'ParseableSafeTx',
    );
    const references = getSdkGnosisSafeExportReferences();
    for (const exportedSymbol of runtimeRequiredExports) {
      expect(
        hasValueExport(references, exportedSymbol),
        `Expected sdk gnosis export ${exportedSymbol} to be value-exported`,
      ).to.equal(true);
    }
  });

  it('keeps sdk gnosis module free of default exports', () => {
    const sdkIndexPath = path.resolve(process.cwd(), '../sdk/src/index.ts');
    const sdkIndexText = fs.readFileSync(sdkIndexPath, 'utf8');
    const sdkGnosisSafePath = path.resolve(
      process.cwd(),
      '../sdk/src/utils/gnosisSafe.ts',
    );
    const sdkGnosisSafeText = fs.readFileSync(sdkGnosisSafePath, 'utf8');

    expect(
      hasDefaultExportInSourceFile(sdkGnosisSafeText, sdkGnosisSafePath),
    ).to.equal(
      false,
      'Expected sdk gnosisSafe module to avoid default exports',
    );

    expect(
      hasDefaultReExportFromModule(
        sdkIndexText,
        sdkIndexPath,
        './utils/gnosisSafe.js',
      ),
    ).to.equal(
      false,
      'Expected sdk index to avoid default re-exports from gnosisSafe module',
    );
  });

  it('keeps legacy infra safe utility module deleted', () => {
    const legacySafeUtilPath = path.join(process.cwd(), 'src/utils/safe.ts');
    expect(fs.existsSync(legacySafeUtilPath)).to.equal(false);
  });

  it('prevents reintroducing infra local safe util imports', () => {
    const disallowedSpecifiers = getDisallowedModuleSpecifierReferences(
      INFRA_SOURCE_AND_TEST_PATHS,
      isLegacySafeUtilSpecifier,
    );
    expect(disallowedSpecifiers).to.deep.equal([]);

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
    const disallowedSpecifiers = getDisallowedModuleSpecifierReferences(
      INFRA_SOURCE_AND_TEST_PATHS,
      isSafeGlobalSpecifier,
    );
    expect(disallowedSpecifiers).to.deep.equal([]);

    expectNoRipgrepMatches(
      String.raw`from ['"]@safe-global|require\(['"]@safe-global|import\(['"]@safe-global`,
      '@safe-global imports in infra sources',
      INFRA_SOURCE_AND_TEST_PATHS,
    );
  });

  it('prevents imports from sdk internal gnosis safe module paths', () => {
    const disallowedSpecifiers = getDisallowedModuleSpecifierReferences(
      INFRA_SOURCE_AND_TEST_PATHS,
      isSdkInternalGnosisSafeSpecifier,
    );
    expect(disallowedSpecifiers).to.deep.equal([]);

    expectNoRipgrepMatches(
      String.raw`from ['"]@hyperlane-xyz/sdk\/.*gnosisSafe|from ['"].*\/gnosisSafe(\.js)?['"]|require\(['"]@hyperlane-xyz/sdk\/.*gnosisSafe|require\(['"].*\/gnosisSafe(\.js)?['"]|import\(['"]@hyperlane-xyz/sdk\/.*gnosisSafe|import\(['"].*\/gnosisSafe(\.js)?['"]`,
      'gnosis safe imports that bypass @hyperlane-xyz/sdk entrypoint',
      INFRA_SOURCE_AND_TEST_PATHS,
    );
  });

  it('prevents imports from sdk source or subpath entrypoints', () => {
    const disallowedSpecifiers = getDisallowedModuleSpecifierReferences(
      INFRA_SOURCE_AND_TEST_PATHS,
      isSdkSubpathOrSourceSpecifier,
    );
    expect(disallowedSpecifiers).to.deep.equal([]);

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
