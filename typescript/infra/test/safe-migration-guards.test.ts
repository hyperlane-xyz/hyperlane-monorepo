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

const DEFAULT_REQUIRE_LIKE_IDENTIFIERS = ['require'] as const;

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

function isRequireLikeExpression(
  expression: ts.Expression,
  requireLikeIdentifiers: ReadonlySet<string>,
): boolean {
  const callTarget = unwrapCallTargetExpression(expression);
  return (
    ts.isIdentifier(callTarget) && requireLikeIdentifiers.has(callTarget.text)
  );
}

function readModuleSourceArg(
  callExpression: ts.CallExpression,
): string | undefined {
  const [firstArg] = callExpression.arguments;
  if (firstArg && ts.isStringLiteralLike(firstArg)) return firstArg.text;
  return undefined;
}

function unwrapCallTargetExpression(expression: ts.Expression): ts.Expression {
  const unwrapped = unwrapInitializerExpression(expression);
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return unwrapCallTargetExpression(unwrapped.right);
  }
  return unwrapped;
}

function readModuleSourceFromInitializer(
  expression: ts.Expression,
  requireLikeIdentifiers: ReadonlySet<string> = new Set(
    DEFAULT_REQUIRE_LIKE_IDENTIFIERS,
  ),
): string | undefined {
  const unwrapped = unwrapInitializerExpression(expression);
  if (!ts.isCallExpression(unwrapped)) return undefined;
  const callTarget = unwrapCallTargetExpression(unwrapped.expression);

  if (
    ts.isIdentifier(callTarget) &&
    requireLikeIdentifiers.has(callTarget.text)
  ) {
    return readModuleSourceArg(unwrapped);
  }
  if (callTarget.kind === ts.SyntaxKind.ImportKeyword) {
    return readModuleSourceArg(unwrapped);
  }
  return undefined;
}

function readModuleSourceFromCallExpression(
  callExpression: ts.CallExpression,
  requireLikeIdentifiers: ReadonlySet<string> = new Set(
    DEFAULT_REQUIRE_LIKE_IDENTIFIERS,
  ),
): string | undefined {
  return readModuleSourceFromInitializer(
    callExpression,
    requireLikeIdentifiers,
  );
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
  requireLikeIdentifiers: ReadonlySet<string> = new Set(
    DEFAULT_REQUIRE_LIKE_IDENTIFIERS,
  ),
): string[] {
  const unwrapped = unwrapInitializerExpression(expression);
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return resolveModuleSourceFromExpression(
      unwrapped.right,
      moduleAliasByIdentifier,
      requireLikeIdentifiers,
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
      requireLikeIdentifiers,
    );
    const rightSource = resolveModuleSourceFromExpression(
      unwrapped.right,
      moduleAliasByIdentifier,
      requireLikeIdentifiers,
    );
    return uniqueSources(leftSource, rightSource);
  }
  if (ts.isConditionalExpression(unwrapped)) {
    const whenTrueSource = resolveModuleSourceFromExpression(
      unwrapped.whenTrue,
      moduleAliasByIdentifier,
      requireLikeIdentifiers,
    );
    const whenFalseSource = resolveModuleSourceFromExpression(
      unwrapped.whenFalse,
      moduleAliasByIdentifier,
      requireLikeIdentifiers,
    );
    return uniqueSources(whenTrueSource, whenFalseSource);
  }
  const directSource = readModuleSourceFromInitializer(
    unwrapped,
    requireLikeIdentifiers,
  );
  if (directSource) return [directSource];
  if (ts.isIdentifier(unwrapped)) {
    return moduleAliasByIdentifier.get(unwrapped.text) ?? [];
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    const sources = new Set<string>();
    for (const property of unwrapped.properties) {
      if (ts.isPropertyAssignment(property)) {
        for (const source of resolveModuleSourceFromExpression(
          property.initializer,
          moduleAliasByIdentifier,
          requireLikeIdentifiers,
        )) {
          sources.add(source);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        for (const source of moduleAliasByIdentifier.get(property.name.text) ??
          []) {
          sources.add(source);
        }
      } else if (ts.isSpreadAssignment(property)) {
        for (const source of resolveModuleSourceFromExpression(
          property.expression,
          moduleAliasByIdentifier,
          requireLikeIdentifiers,
        )) {
          sources.add(source);
        }
      }
    }
    return [...sources];
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    const sources = new Set<string>();
    for (const element of unwrapped.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isSpreadElement(element)) {
        for (const source of resolveModuleSourceFromExpression(
          element.expression,
          moduleAliasByIdentifier,
          requireLikeIdentifiers,
        )) {
          sources.add(source);
        }
        continue;
      }
      for (const source of resolveModuleSourceFromExpression(
        element,
        moduleAliasByIdentifier,
        requireLikeIdentifiers,
      )) {
        sources.add(source);
      }
    }
    return [...sources];
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return resolveModuleSourceFromExpression(
      unwrapped.expression,
      moduleAliasByIdentifier,
      requireLikeIdentifiers,
    );
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    return resolveModuleSourceFromExpression(
      unwrapped.expression,
      moduleAliasByIdentifier,
      requireLikeIdentifiers,
    );
  }
  return [];
}

function collectBindingElementSymbols(element: ts.BindingElement): string[] {
  const symbols = new Set<string>();
  if (element.propertyName) {
    if (ts.isIdentifier(element.propertyName)) {
      symbols.add(normalizeNamedSymbol(element.propertyName.text));
    } else if (ts.isStringLiteralLike(element.propertyName)) {
      symbols.add(normalizeNamedSymbol(element.propertyName.text));
    }
  }
  if (ts.isIdentifier(element.name)) {
    symbols.add(normalizeNamedSymbol(element.name.text));
  } else if (
    ts.isObjectBindingPattern(element.name) ||
    ts.isArrayBindingPattern(element.name)
  ) {
    for (const nestedElement of element.name.elements) {
      if (!ts.isBindingElement(nestedElement) || nestedElement.dotDotDotToken) {
        continue;
      }
      for (const symbol of collectBindingElementSymbols(nestedElement)) {
        symbols.add(symbol);
      }
    }
  }
  return [...symbols].filter(Boolean);
}

function collectBindingLocalNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [normalizeNamedSymbol(name.text)].filter(Boolean);
  }
  const localNames = new Set<string>();
  for (const element of name.elements) {
    if (!ts.isBindingElement(element)) continue;
    for (const localName of collectBindingLocalNames(element.name)) {
      localNames.add(localName);
    }
  }
  return [...localNames].filter(Boolean);
}

function unwrapAssignmentTargetExpression(
  expression: ts.Expression,
): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) {
    return unwrapAssignmentTargetExpression(expression.expression);
  }
  if (ts.isAsExpression(expression)) {
    return unwrapAssignmentTargetExpression(expression.expression);
  }
  if (ts.isTypeAssertionExpression(expression)) {
    return unwrapAssignmentTargetExpression(expression.expression);
  }
  if (ts.isNonNullExpression(expression)) {
    return unwrapAssignmentTargetExpression(expression.expression);
  }
  if (ts.isSatisfiesExpression(expression)) {
    return unwrapAssignmentTargetExpression(expression.expression);
  }
  return expression;
}

function readAssignmentPropertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name)) return normalizeNamedSymbol(name.text);
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return normalizeNamedSymbol(name.text);
  }
  if (
    ts.isComputedPropertyName(name) &&
    ts.isStringLiteralLike(name.expression)
  ) {
    return normalizeNamedSymbol(name.expression.text);
  }
  return '';
}

function collectAssignmentPatternSymbols(expression: ts.Expression): string[] {
  const unwrapped = unwrapAssignmentTargetExpression(expression);

  if (ts.isIdentifier(unwrapped)) {
    return [normalizeNamedSymbol(unwrapped.text)].filter(Boolean);
  }

  if (ts.isObjectLiteralExpression(unwrapped)) {
    const symbols = new Set<string>();
    for (const property of unwrapped.properties) {
      if (ts.isPropertyAssignment(property)) {
        const propertySymbol = readAssignmentPropertyName(property.name);
        if (propertySymbol) symbols.add(propertySymbol);
        for (const symbol of collectAssignmentPatternSymbols(
          property.initializer,
        )) {
          symbols.add(symbol);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        symbols.add(normalizeNamedSymbol(property.name.text));
      }
    }
    return [...symbols].filter(Boolean);
  }

  if (ts.isArrayLiteralExpression(unwrapped)) {
    const symbols = new Set<string>();
    for (const element of unwrapped.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isSpreadElement(element)) {
        for (const symbol of collectAssignmentPatternSymbols(
          element.expression,
        )) {
          symbols.add(symbol);
        }
        continue;
      }
      for (const symbol of collectAssignmentPatternSymbols(element)) {
        symbols.add(symbol);
      }
    }
    return [...symbols].filter(Boolean);
  }

  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return collectAssignmentPatternSymbols(unwrapped.left);
  }

  return [];
}

function collectAssignmentPatternLocalNames(
  expression: ts.Expression,
): string[] {
  const unwrapped = unwrapAssignmentTargetExpression(expression);

  if (ts.isIdentifier(unwrapped)) {
    return [normalizeNamedSymbol(unwrapped.text)].filter(Boolean);
  }

  if (ts.isObjectLiteralExpression(unwrapped)) {
    const localNames = new Set<string>();
    for (const property of unwrapped.properties) {
      if (ts.isPropertyAssignment(property)) {
        for (const localName of collectAssignmentPatternLocalNames(
          property.initializer,
        )) {
          localNames.add(localName);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        localNames.add(normalizeNamedSymbol(property.name.text));
      } else if (ts.isSpreadAssignment(property)) {
        for (const localName of collectAssignmentPatternLocalNames(
          property.expression,
        )) {
          localNames.add(localName);
        }
      }
    }
    return [...localNames].filter(Boolean);
  }

  if (ts.isArrayLiteralExpression(unwrapped)) {
    const localNames = new Set<string>();
    for (const element of unwrapped.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isSpreadElement(element)) {
        for (const localName of collectAssignmentPatternLocalNames(
          element.expression,
        )) {
          localNames.add(localName);
        }
        continue;
      }
      for (const localName of collectAssignmentPatternLocalNames(element)) {
        localNames.add(localName);
      }
    }
    return [...localNames].filter(Boolean);
  }

  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return collectAssignmentPatternLocalNames(unwrapped.left);
  }

  return [];
}

function readImportTypeQualifierSymbol(
  qualifier: ts.EntityName | undefined,
): string {
  if (!qualifier) return '';
  if (ts.isIdentifier(qualifier)) return qualifier.text;
  return readImportTypeQualifierSymbol(qualifier.left);
}

function isLexicalScopeBoundary(node: ts.Node): boolean {
  return ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node);
}

function cloneStringArrayMap(
  source: Map<string, string[]>,
): Map<string, string[]> {
  return new Map(
    [...source.entries()].map(([key, values]) => [key, [...values]]),
  );
}

function restoreStringArrayMap(
  target: Map<string, string[]>,
  snapshot: Map<string, string[]>,
): void {
  target.clear();
  for (const [key, values] of snapshot.entries()) {
    target.set(key, [...values]);
  }
}

function restoreStringSet(target: Set<string>, snapshot: Set<string>): void {
  target.clear();
  for (const value of snapshot.values()) {
    target.add(value);
  }
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
  const requireLikeIdentifiers = new Set<string>(
    DEFAULT_REQUIRE_LIKE_IDENTIFIERS,
  );
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
    const scopeSnapshot = isLexicalScopeBoundary(node)
      ? {
          moduleAliases: cloneStringArrayMap(moduleAliasByIdentifier),
          requireLikeIdentifiers: new Set(requireLikeIdentifiers),
        }
      : undefined;

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
      if (initializer) {
        if (isRequireLikeExpression(initializer, requireLikeIdentifiers)) {
          requireLikeIdentifiers.add(node.name.text);
        } else if (node.name.text !== 'require') {
          requireLikeIdentifiers.delete(node.name.text);
        }
      } else if (node.name.text !== 'require') {
        requireLikeIdentifiers.delete(node.name.text);
      }
      const sources = initializer
        ? resolveModuleSourceFromExpression(
            initializer,
            moduleAliasByIdentifier,
            requireLikeIdentifiers,
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
      ].includes(node.operatorToken.kind)
    ) {
      const rightExpression = unwrapInitializerExpression(node.right);
      const rightIsRequireLike = isRequireLikeExpression(
        rightExpression,
        requireLikeIdentifiers,
      );
      const sources = resolveModuleSourceFromExpression(
        rightExpression,
        moduleAliasByIdentifier,
        requireLikeIdentifiers,
      );

      if (ts.isIdentifier(node.left)) {
        if (rightIsRequireLike) {
          requireLikeIdentifiers.add(node.left.text);
        } else if (
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          node.left.text !== 'require'
        ) {
          requireLikeIdentifiers.delete(node.left.text);
        }
        if (sources.length > 0) {
          moduleAliasByIdentifier.set(node.left.text, sources);
        } else if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          moduleAliasByIdentifier.delete(node.left.text);
        }
      }

      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const assignmentSymbols = collectAssignmentPatternSymbols(node.left);
        for (const source of sources) {
          for (const symbol of assignmentSymbols) {
            references.push({ symbol, source });
          }
        }

        const assignmentLocalNames = collectAssignmentPatternLocalNames(
          node.left,
        );
        if (sources.length > 0) {
          for (const localName of assignmentLocalNames) {
            moduleAliasByIdentifier.set(localName, sources);
          }
        } else {
          for (const localName of assignmentLocalNames) {
            moduleAliasByIdentifier.delete(localName);
          }
        }
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const sources = resolveModuleSourceFromExpression(
        node.expression,
        moduleAliasByIdentifier,
        requireLikeIdentifiers,
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
        requireLikeIdentifiers,
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
      (ts.isObjectBindingPattern(node.name) ||
        ts.isArrayBindingPattern(node.name))
    ) {
      const initializer = node.initializer
        ? unwrapInitializerExpression(node.initializer)
        : undefined;
      const sources = initializer
        ? resolveModuleSourceFromExpression(
            initializer,
            moduleAliasByIdentifier,
            requireLikeIdentifiers,
          )
        : [];
      const bindingLocalNames = collectBindingLocalNames(node.name);
      if (sources.length > 0) {
        for (const localName of bindingLocalNames) {
          moduleAliasByIdentifier.set(localName, sources);
        }
      }
      for (const source of sources) {
        for (const bindingElement of node.name.elements) {
          if (
            !ts.isBindingElement(bindingElement) ||
            bindingElement.dotDotDotToken
          ) {
            continue;
          }
          for (const symbol of collectBindingElementSymbols(bindingElement)) {
            references.push({
              symbol,
              source,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);

    if (scopeSnapshot) {
      restoreStringArrayMap(
        moduleAliasByIdentifier,
        scopeSnapshot.moduleAliases,
      );
      restoreStringSet(
        requireLikeIdentifiers,
        scopeSnapshot.requireLikeIdentifiers,
      );
    }
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
  const requireLikeIdentifiers = new Set<string>(
    DEFAULT_REQUIRE_LIKE_IDENTIFIERS,
  );
  const sourceFile = ts.createSourceFile(
    filePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );

  const visit = (node: ts.Node) => {
    const scopeSnapshot = isLexicalScopeBoundary(node)
      ? new Set(requireLikeIdentifiers)
      : undefined;

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
      const source = readModuleSourceFromCallExpression(
        node,
        requireLikeIdentifiers,
      );
      if (source) references.push({ source, filePath });
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer
        ? unwrapInitializerExpression(node.initializer)
        : undefined;
      if (initializer) {
        if (isRequireLikeExpression(initializer, requireLikeIdentifiers)) {
          requireLikeIdentifiers.add(node.name.text);
        } else if (node.name.text !== 'require') {
          requireLikeIdentifiers.delete(node.name.text);
        }
      } else if (node.name.text !== 'require') {
        requireLikeIdentifiers.delete(node.name.text);
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
      if (isRequireLikeExpression(rightExpression, requireLikeIdentifiers)) {
        requireLikeIdentifiers.add(node.left.text);
      } else if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.left.text !== 'require'
      ) {
        requireLikeIdentifiers.delete(node.left.text);
      }
    }

    ts.forEachChild(node, visit);

    if (scopeSnapshot) {
      restoreStringSet(requireLikeIdentifiers, scopeSnapshot);
    }
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

function collectDefaultSymbolReferencesFromModule(
  paths: readonly string[],
  moduleName: string,
): string[] {
  const defaultReferences: string[] = [];
  for (const sourceFilePath of collectProjectSourceFilePaths(paths)) {
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

function collectDefaultImportsFromModule(
  paths: readonly string[],
  moduleName: string,
): string[] {
  const defaultImports: string[] = [];
  for (const sourceFilePath of collectProjectSourceFilePaths(paths)) {
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

  it('tracks default import local symbol names from module specifiers', () => {
    const source = "import getSafe from './fixtures/guard-module.js';";
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('getSafe@./fixtures/guard-module.js');
  });

  it('tracks import-equals local symbol names from module specifiers', () => {
    const source = "import getSafe = require('./fixtures/guard-module.js');";
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('getSafe@./fixtures/guard-module.js');
  });

  it('tracks default symbol references from namespace and require access', () => {
    const source = [
      "import * as sdk from './fixtures/guard-module.js';",
      'const namespaceDefault = sdk.default;',
      "const namespaceElementDefault = sdk['default'];",
      "const requireDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references from dynamic import aliases', () => {
    const source = [
      "let sdkModule: any = await import('./fixtures/guard-module.js');",
      'sdkModule = sdkModule;',
      'const dynamicDefault = sdkModule.default;',
      "const dynamicElementDefault = sdkModule['default'];",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references through assertion wrappers', () => {
    const source = [
      "import * as sdk from './fixtures/guard-module.js';",
      'const asAlias = sdk as unknown;',
      'const typeAssertionAlias = <unknown>sdk;',
      'const nonNullAlias = asAlias!;',
      'const satisfiesAlias = sdk satisfies Record<string, unknown>;',
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

  it('tracks default symbol references through comma-wrapped require call targets', () => {
    const source = [
      "const callTargetAlias = (0, require)('./fixtures/guard-module.js');",
      'const callTargetDefault = callTargetAlias.default;',
      "const inlineCallTargetDefault = (0, require)('./fixtures/guard-module.js')['default'];",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references through aliased require call targets', () => {
    const source = [
      'let reqAlias: any = require;',
      "const aliasTarget = reqAlias('./fixtures/guard-module.js');",
      'const aliasDefault = aliasTarget.default;',
      'reqAlias = reqAlias;',
      "const wrappedAliasDefault = (0, reqAlias)('./fixtures/guard-module.js')['default'];",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references through logical-assignment require aliases', () => {
    const source = [
      'let reqAlias: any;',
      'reqAlias ||= require;',
      "const orAssignedDefault = reqAlias('./fixtures/guard-module.js').default;",
      'reqAlias &&= require;',
      "const andAssignedDefault = reqAlias('./fixtures/guard-module.js')['default'];",
      'reqAlias ??= require;',
      "const nullishAssignedDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references for aliases across shadowed scopes', () => {
    const source = [
      "import * as sdk from './fixtures/guard-module.js';",
      '{',
      "  const sdk = require('./fixtures/other-module.js');",
      '  const innerDefault = sdk.default;',
      '}',
      'const outerDefault = sdk.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
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
      "import * as sdk from './fixtures/guard-module.js';",
      'const optionalDefault = sdk?.default;',
      "const optionalElementDefault = sdk?.['default'];",
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

  it('tracks default symbol references through object-literal wrappers', () => {
    const source = [
      "const wrapped = { sdk: require('./fixtures/guard-module.js') };",
      'const wrappedAlias = wrapped.sdk;',
      'const wrappedDefault = wrappedAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references through array-literal wrappers', () => {
    const source = [
      "const wrapped = [require('./fixtures/guard-module.js')];",
      'const wrappedAlias = wrapped[0];',
      'const wrappedDefault = wrappedAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references through nested binding patterns', () => {
    const source = [
      "const { nested: { default: nestedDefault }, default: topDefault } = require('./fixtures/guard-module.js');",
      'const nestedAliasDefault = nestedDefault.default;',
      "const topAliasDefault = topDefault['default'];",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references through array binding patterns', () => {
    const source = [
      "const [{ default: arrayDefault }] = require('./fixtures/guard-module.js');",
      'const arrayAliasDefault = arrayDefault.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('tracks default symbol references through destructuring assignment patterns', () => {
    const source = [
      'let directAlias: unknown;',
      'let nestedAlias: unknown;',
      "({ default: directAlias, nested: { default: nestedAlias } } = require('./fixtures/guard-module.js'));",
      "([{ default: directAlias }] = require('./fixtures/guard-module.js'));",
      'const directAliasDefault = directAlias.default;',
      "const nestedAliasDefault = nestedAlias['default'];",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
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

  it('collects module specifiers from comma-wrapped require call targets', () => {
    const source = [
      "const directRequire = require('./fixtures/guard-module.js');",
      "const wrappedRequire = (0, require)('./fixtures/other-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('collects module specifiers from aliased require call targets', () => {
    const source = [
      'const reqAlias = require;',
      "const aliasRequire = reqAlias('./fixtures/guard-module.js');",
      'const nextAlias = reqAlias;',
      "const wrappedAliasRequire = (0, nextAlias)('./fixtures/other-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('collects module specifiers from logical-assignment require aliases', () => {
    const source = [
      'let reqAlias: any;',
      'reqAlias ||= require;',
      "const orAssignedRequire = reqAlias('./fixtures/guard-module.js');",
      'reqAlias &&= require;',
      "const andAssignedRequire = reqAlias('./fixtures/other-module.js');",
      'reqAlias ??= require;',
      "const nullishAssignedRequire = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('collects module specifiers from require aliases across shadowed scopes', () => {
    const source = [
      'let reqAlias: any = require;',
      '{',
      '  const reqAlias = () => undefined;',
      '  void reqAlias;',
      '}',
      "const postShadowRequire = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
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

  it('prevents default imports from sdk entrypoint', () => {
    const defaultSdkImports = collectDefaultImportsFromModule(
      INFRA_SOURCE_AND_TEST_PATHS,
      '@hyperlane-xyz/sdk',
    );
    expect(defaultSdkImports).to.deep.equal([]);

    expectNoRipgrepMatches(
      String.raw`(?:import\s+[A-Za-z_$][A-Za-z0-9_$]*\s+from\s+['"]@hyperlane-xyz/sdk['"]|import\s+(?:type\s+)?\{\s*(?:type\s+)?default(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\}\s*from\s+['"]@hyperlane-xyz/sdk['"])`,
      'default imports from @hyperlane-xyz/sdk',
      INFRA_SOURCE_AND_TEST_PATHS,
    );
  });

  it('prevents sdk default property access via namespace aliases', () => {
    const defaultSdkReferences = collectDefaultSymbolReferencesFromModule(
      INFRA_SOURCE_AND_TEST_PATHS,
      '@hyperlane-xyz/sdk',
    );
    expect(defaultSdkReferences).to.deep.equal([]);

    expectNoRipgrepMatches(
      String.raw`require\(['"]@hyperlane-xyz/sdk['"]\)\s*(?:\.default|\[\s*['"]default['"]\s*\])`,
      'direct default property access from @hyperlane-xyz/sdk',
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
