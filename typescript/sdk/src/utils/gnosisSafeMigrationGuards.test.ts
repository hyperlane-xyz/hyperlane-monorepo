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

type SymbolSourceReference = {
  symbol: string;
  source: string;
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
          (specifier) => specifier.name.text === 'default',
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

function unwrapInitializerExpression(expression: ts.Expression): ts.Expression {
  if (ts.isAwaitExpression(expression)) {
    return unwrapInitializerExpression(expression.expression);
  }
  if (ts.isParenthesizedExpression(expression)) {
    return unwrapInitializerExpression(expression.expression);
  }
  if (ts.isAsExpression(expression)) {
    return unwrapInitializerExpression(expression.expression);
  }
  if (ts.isTypeAssertionExpression(expression)) {
    return unwrapInitializerExpression(expression.expression);
  }
  if (ts.isNonNullExpression(expression)) {
    return unwrapInitializerExpression(expression.expression);
  }
  if (ts.isSatisfiesExpression(expression)) {
    return unwrapInitializerExpression(expression.expression);
  }
  return expression;
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

function uniqueSources(
  ...sourceGroups: readonly (readonly string[] | string | undefined)[]
): string[] {
  const sources = new Set<string>();
  for (const sourceGroup of sourceGroups) {
    if (!sourceGroup) continue;
    if (typeof sourceGroup === 'string') {
      sources.add(sourceGroup);
      continue;
    }
    for (const source of sourceGroup) {
      if (source) sources.add(source);
    }
  }
  return [...sources];
}

function resolveModuleSourceFromExpression(
  expression: ts.Expression,
  moduleAliasByIdentifier: Map<string, string[]>,
): string[] {
  const unwrapped = unwrapInitializerExpression(expression);
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return resolveModuleSourceFromExpression(
      unwrapped.right,
      moduleAliasByIdentifier,
    );
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    [
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(unwrapped.operatorToken.kind)
  ) {
    const leftSource = resolveModuleSourceFromExpression(
      unwrapped.left,
      moduleAliasByIdentifier,
    );
    const rightSource = resolveModuleSourceFromExpression(
      unwrapped.right,
      moduleAliasByIdentifier,
    );
    return uniqueSources(leftSource, rightSource);
  }
  if (ts.isConditionalExpression(unwrapped)) {
    const whenTrueSource = resolveModuleSourceFromExpression(
      unwrapped.whenTrue,
      moduleAliasByIdentifier,
    );
    const whenFalseSource = resolveModuleSourceFromExpression(
      unwrapped.whenFalse,
      moduleAliasByIdentifier,
    );
    return uniqueSources(whenTrueSource, whenFalseSource);
  }
  const directSource = readModuleSourceFromInitializer(unwrapped);
  if (directSource) return [directSource];
  if (ts.isIdentifier(unwrapped)) {
    return moduleAliasByIdentifier.get(unwrapped.text) ?? [];
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
  return [];
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
  moduleAliasByIdentifier: Map<string, string[]>,
): string[] {
  if (ts.isIdentifier(name)) {
    return moduleAliasByIdentifier.get(name.text) ?? [];
  }
  return resolveModuleSourceFromEntityName(name.left, moduleAliasByIdentifier);
}

function collectSymbolSourceReferences(
  contents: string,
  filePath: string,
): SymbolSourceReference[] {
  const references: SymbolSourceReference[] = [];
  const moduleAliasByIdentifier = new Map<string, string[]>();
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
        moduleAliasByIdentifier.set(node.importClause.name.text, [source]);
        references.push({
          symbol: normalizeNamedSymbol(node.importClause.name.text),
          source,
        });
      }
      const namedBindings = node.importClause?.namedBindings;
      if (source && namedBindings) {
        if (ts.isNamespaceImport(namedBindings)) {
          moduleAliasByIdentifier.set(namedBindings.name.text, [source]);
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
      const sources = resolveModuleSourceFromEntityName(
        node.left,
        moduleAliasByIdentifier,
      );
      for (const source of sources) {
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
      moduleAliasByIdentifier.set(node.name.text, [
        node.moduleReference.expression.text,
      ]);
      references.push({
        symbol: normalizeNamedSymbol(node.name.text),
        source: node.moduleReference.expression.text,
      });
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer
        ? unwrapInitializerExpression(node.initializer)
        : undefined;
      const sources = initializer
        ? resolveModuleSourceFromExpression(
            initializer,
            moduleAliasByIdentifier,
          )
        : [];
      if (sources.length > 0) {
        moduleAliasByIdentifier.set(node.name.text, sources);
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
      ].includes(node.operatorToken.kind) &&
      ts.isIdentifier(node.left)
    ) {
      const rightExpression = unwrapInitializerExpression(node.right);
      const sources = resolveModuleSourceFromExpression(
        rightExpression,
        moduleAliasByIdentifier,
      );
      if (sources.length > 0) {
        moduleAliasByIdentifier.set(node.left.text, sources);
      } else if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        moduleAliasByIdentifier.delete(node.left.text);
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const sources = resolveModuleSourceFromExpression(
        node.expression,
        moduleAliasByIdentifier,
      );
      for (const source of sources) {
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
      const sources = resolveModuleSourceFromExpression(
        node.expression,
        moduleAliasByIdentifier,
      );
      for (const source of sources) {
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
      const sources = initializer
        ? resolveModuleSourceFromExpression(
            initializer,
            moduleAliasByIdentifier,
          )
        : [];
      for (const source of sources) {
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
  const seenReferences = new Set<string>();
  return references.filter((reference) => {
    if (!reference.symbol.length) return false;
    const key = `${reference.symbol}@${reference.source}`;
    if (seenReferences.has(key)) return false;
    seenReferences.add(key);
    return true;
  });
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

function collectDefaultImportNamesFromSource(
  sourceText: string,
  filePath: string,
  moduleName: string,
): string[] {
  const defaultImportNames: string[] = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );

  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === moduleName &&
      node.importClause
    ) {
      if (node.importClause.name) {
        defaultImportNames.push(
          normalizeNamedSymbol(node.importClause.name.text),
        );
      }
      if (
        node.importClause.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const importSpecifier of node.importClause.namedBindings
          .elements) {
          const importedName =
            importSpecifier.propertyName?.text ?? importSpecifier.name.text;
          if (importedName !== 'default') continue;
          defaultImportNames.push(
            normalizeNamedSymbol(importSpecifier.name.text),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...new Set(defaultImportNames.filter(Boolean))];
}

function collectDefaultImportsFromModule(
  sourceFilePaths: readonly string[],
  moduleName: string,
): string[] {
  const defaultImports: string[] = [];
  for (const sourceFilePath of sourceFilePaths) {
    const contents = fs.readFileSync(sourceFilePath, 'utf8');
    const defaultImportNames = collectDefaultImportNamesFromSource(
      contents,
      sourceFilePath,
      moduleName,
    );
    for (const localName of defaultImportNames) {
      defaultImports.push(
        `${path.relative(process.cwd(), sourceFilePath)} -> ${localName}`,
      );
    }
  }
  return defaultImports;
}

function collectDefaultSymbolReferencesFromModule(
  sourceFilePaths: readonly string[],
  moduleName: string,
): string[] {
  const defaultReferences: string[] = [];
  for (const sourceFilePath of sourceFilePaths) {
    const contents = fs.readFileSync(sourceFilePath, 'utf8');
    const references = collectSymbolSourceReferences(contents, sourceFilePath);
    for (const reference of references) {
      if (reference.source !== moduleName || reference.symbol !== 'default') {
        continue;
      }
      defaultReferences.push(
        `${path.relative(process.cwd(), sourceFilePath)} -> ${reference.symbol}`,
      );
    }
  }
  return defaultReferences;
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

  it('detects type-only local default export alias declarations', () => {
    const source = [
      'type SafeType = { safe: true };',
      'export { type SafeType as default };',
    ].join('\n');
    expect(hasDefaultExportInSourceFile(source, 'fixture.ts')).to.equal(true);
  });

  it('does not treat aliased default re-exports as module default export', () => {
    const source =
      "export { default as SafeDefault } from './fixtures/guard-module.js';";
    expect(hasDefaultExportInSourceFile(source, 'fixture.ts')).to.equal(false);
  });

  it('detects direct default re-exports as module default export', () => {
    const source = "export { default } from './fixtures/guard-module.js';";
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

  it('detects type-only default re-exports from specific modules', () => {
    const source = [
      "export { type SafeType as default } from './fixtures/guard-module.js';",
      "export { type HelperType } from './fixtures/guard-module.js';",
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
      "import { SafeApiKit as SafeApiAlias } from './fixtures/guard-module.js';",
      "export { getSafe as getSafeAlias } from './fixtures/guard-module.js';",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('SafeApiKit@./fixtures/guard-module.js');
    expect(references).to.include('SafeApiAlias@./fixtures/guard-module.js');
    expect(references).to.include('getSafe@./fixtures/guard-module.js');
    expect(references).to.include('getSafeAlias@./fixtures/guard-module.js');
  });

  it('tracks default import local symbol names from module specifiers', () => {
    const source = "import SafeSdk from './fixtures/guard-module.js';";
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('SafeSdk@./fixtures/guard-module.js');
  });

  it('tracks import-equals local symbol names from module specifiers', () => {
    const source = "import getSafe = require('./fixtures/guard-module.js');";
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('getSafe@./fixtures/guard-module.js');
  });

  it('collects value and type-only default imports from source text', () => {
    const source = [
      "import SafeSdk from '@fixtures/guard-module';",
      "import type SafeType from '@fixtures/guard-module';",
      "import { default as SafeAlias } from '@fixtures/guard-module';",
      "import { type default as SafeTypeAlias } from '@fixtures/guard-module';",
      "import type { default as SafeTypeClauseAlias } from '@fixtures/guard-module';",
      "import { default } from '@fixtures/guard-module';",
      "import { getSafe } from '@fixtures/guard-module';",
      "import SafeOther from '@fixtures/other-module';",
    ].join('\n');
    const defaultImports = collectDefaultImportNamesFromSource(
      source,
      'fixture.ts',
      '@fixtures/guard-module',
    );
    expect(defaultImports).to.deep.equal([
      'SafeSdk',
      'SafeType',
      'SafeAlias',
      'SafeTypeAlias',
      'SafeTypeClauseAlias',
      'default',
    ]);
  });

  it('deduplicates default import names from repeated clauses', () => {
    const source = [
      "import SafeSdk from '@fixtures/guard-module';",
      "import { default as SafeSdk } from '@fixtures/guard-module';",
      "import type { default as SafeSdk } from '@fixtures/guard-module';",
    ].join('\n');
    const defaultImports = collectDefaultImportNamesFromSource(
      source,
      'fixture.ts',
      '@fixtures/guard-module',
    );
    expect(defaultImports).to.deep.equal(['SafeSdk']);
  });

  it('tracks default symbol references from namespace and require access', () => {
    const source = [
      "import * as infra from './fixtures/guard-module.js';",
      'const namespaceDefault = infra.default;',
      "const namespaceElementDefault = infra['default'];",
      "const requireDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references from dynamic import aliases', () => {
    const source = [
      "let infraModule: any = await import('./fixtures/guard-module.js');",
      'infraModule = infraModule;',
      'const dynamicDefault = infraModule.default;',
      "const dynamicElementDefault = infraModule['default'];",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references through assertion wrappers', () => {
    const source = [
      "import * as infra from './fixtures/guard-module.js';",
      'const asAlias = infra as unknown;',
      'const typeAssertionAlias = <unknown>infra;',
      'const nonNullAlias = asAlias!;',
      'const satisfiesAlias = infra satisfies Record<string, unknown>;',
      'const fromAsAlias = asAlias.default;',
      "const fromTypeAssertionAlias = typeAssertionAlias['default'];",
      'const fromNonNullAlias = nonNullAlias.default;',
      'const fromSatisfiesAlias = satisfiesAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references through comma operator wrappers', () => {
    const source = [
      "const commaAlias = (0, require('./fixtures/guard-module.js'));",
      'const commaDefault = commaAlias.default;',
      "const inlineCommaDefault = (0, require('./fixtures/guard-module.js'))['default'];",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references through logical wrappers', () => {
    const source = [
      'declare const maybeAlias: unknown;',
      'declare const maybeNull: unknown;',
      "const logicalOrAlias = maybeAlias || require('./fixtures/guard-module.js');",
      "const logicalAndAlias = true && require('./fixtures/guard-module.js');",
      "const nullishAlias = maybeNull ?? require('./fixtures/guard-module.js');",
      'const logicalOrDefault = logicalOrAlias.default;',
      "const logicalAndDefault = logicalAndAlias['default'];",
      'const nullishDefault = nullishAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references for mixed-source logical wrappers', () => {
    const source = [
      "import * as otherModule from './fixtures/other-module.js';",
      "const mixedAlias = otherModule || require('./fixtures/guard-module.js');",
      'const mixedDefault = mixedAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('tracks default symbol references for mixed-source conditional wrappers', () => {
    const source = [
      "import * as otherModule from './fixtures/other-module.js';",
      'declare const useOtherModule: boolean;',
      "const mixedAlias = useOtherModule ? otherModule : require('./fixtures/guard-module.js');",
      'const mixedDefault = mixedAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('tracks default symbol references through conditional wrappers', () => {
    const source = [
      'declare const useModuleAlias: boolean;',
      'declare const fallbackAlias: unknown;',
      "const conditionalAlias = useModuleAlias ? require('./fixtures/guard-module.js') : fallbackAlias;",
      'const conditionalDefault = conditionalAlias.default;',
      "const inlineConditionalDefault = (useModuleAlias ? require('./fixtures/guard-module.js') : fallbackAlias)['default'];",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references through logical assignment aliases', () => {
    const source = [
      'let alias: unknown;',
      "alias ||= require('./fixtures/guard-module.js');",
      'const orAssignmentDefault = alias.default;',
      "alias &&= require('./fixtures/guard-module.js');",
      "const andAssignmentDefault = alias['default'];",
      "alias ??= require('./fixtures/guard-module.js');",
      'const nullishAssignmentDefault = alias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references through optional chaining access', () => {
    const source = [
      "import * as infra from './fixtures/guard-module.js';",
      'const optionalDefault = infra?.default;',
      "const optionalElementDefault = infra?.['default'];",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references from template-literal specifiers', () => {
    const source = [
      'const templateAlias = require(`./fixtures/guard-module.js`);',
      'const templateDefault = templateAlias.default;',
      "const inlineTemplateDefault = require(`./fixtures/guard-module.js`)['default'];",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
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

  it('prevents default imports from infra package entrypoint', () => {
    const sourceFilePaths = collectSdkSourceFilePaths(
      path.resolve(process.cwd(), 'src'),
    );
    const defaultInfraImports = collectDefaultImportsFromModule(
      sourceFilePaths,
      '@hyperlane-xyz/infra',
    );
    expect(defaultInfraImports).to.deep.equal([]);

    expectNoRipgrepMatches(
      String.raw`(?:import\s+[A-Za-z_$][A-Za-z0-9_$]*\s+from\s+['"]@hyperlane-xyz/infra['"]|import\s+(?:type\s+)?\{\s*(?:type\s+)?default(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\}\s*from\s+['"]@hyperlane-xyz/infra['"])`,
      'default imports from @hyperlane-xyz/infra',
    );
  });

  it('prevents infra default property access via namespace aliases', () => {
    const sourceFilePaths = collectSdkSourceFilePaths(
      path.resolve(process.cwd(), 'src'),
    );
    const defaultInfraReferences = collectDefaultSymbolReferencesFromModule(
      sourceFilePaths,
      '@hyperlane-xyz/infra',
    );
    expect(defaultInfraReferences).to.deep.equal([]);

    expectNoRipgrepMatches(
      String.raw`require\(['"]@hyperlane-xyz/infra['"]\)\s*(?:\.default|\[\s*['"]default['"]\s*\])`,
      'direct default property access from @hyperlane-xyz/infra',
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
    expect(
      hasDefaultExportInSourceFile(gnosisSafeText, gnosisSafePath),
    ).to.equal(
      false,
      'Expected sdk gnosisSafe module to avoid default exports',
    );
    expect(
      hasDefaultReExportFromModule(
        indexText,
        indexPath,
        './utils/gnosisSafe.js',
      ),
    ).to.equal(
      false,
      'Expected sdk index to avoid default re-exports from gnosisSafe module',
    );

    const moduleExports = extractTopLevelDeclarationExports(
      gnosisSafeText,
      gnosisSafePath,
    );
    const gnosisSafeExportReferences = extractNamedExportSymbolReferences(
      indexText,
      './utils/gnosisSafe.js',
      indexPath,
      moduleExports,
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

    const requiredRuntimeExports = requiredExports.filter(
      (symbol) =>
        ![
          'ParseableSafeTx',
          'SafeAndService',
          'SafeCallData',
          'SafeDeploymentConfig',
          'SafeDeploymentTransaction',
          'SafeOwnerUpdateCall',
          'SafeServiceTransaction',
          'SafeServiceTransactionWithPayload',
          'SafeStatus',
        ].includes(symbol),
    );

    for (const exportedSymbol of requiredExports) {
      expect(
        gnosisSafeExports.includes(exportedSymbol),
        `Expected sdk index gnosisSafe export list to include ${exportedSymbol}`,
      ).to.equal(true);
    }

    for (const runtimeExportedSymbol of requiredRuntimeExports) {
      expect(
        hasValueExport(gnosisSafeExportReferences, runtimeExportedSymbol),
        `Expected sdk index gnosisSafe export ${runtimeExportedSymbol} to be value-exported`,
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
