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

function isAmbientContextNode(node: ts.Node): boolean {
  if (node.getSourceFile().isDeclarationFile) return true;

  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.canHaveModifiers(current)) {
      const modifiers = ts.getModifiers(current);
      if (
        modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
        )
      ) {
        return true;
      }
    }
    current = current.parent;
  }

  return false;
}

function isLexicalScopeBoundary(node: ts.Node): boolean {
  const hasLexicalBindings = (declarations: ts.VariableDeclarationList) =>
    (declarations.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
  const isLexicalLoopBoundary =
    (ts.isForStatement(node) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.initializer) &&
      hasLexicalBindings(node.initializer)) ||
    ((ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      ts.isVariableDeclarationList(node.initializer) &&
      hasLexicalBindings(node.initializer));
  return (
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    isLexicalLoopBoundary
  );
}

function shouldMergeNonLexicalScopeMutations(node: ts.Node): boolean {
  return (
    !ts.isModuleBlock(node) &&
    node.kind !== ts.SyntaxKind.ClassStaticBlockDeclaration
  );
}

function collectFunctionScopeShadowedIdentifiers(node: ts.Node): string[] {
  if (!ts.isFunctionLike(node)) return [];

  const shadowed = new Set<string>();
  if ('name' in node && node.name && ts.isIdentifier(node.name)) {
    shadowed.add(normalizeNamedSymbol(node.name.text));
  }

  for (const parameter of node.parameters) {
    for (const localName of collectBindingLocalNames(parameter.name)) {
      shadowed.add(localName);
    }
  }

  return [...shadowed].filter(Boolean);
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

function stringArraysEqual(
  left: string[] | undefined,
  right: string[],
): boolean {
  if (!left || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function collectVarScopeStatementBindings(
  statement: ts.Statement,
  declaredIdentifiers: Set<string>,
): void {
  if (ts.isLabeledStatement(statement)) {
    collectVarScopeStatementBindings(statement.statement, declaredIdentifiers);
    return;
  }

  if (ts.isVariableStatement(statement)) {
    if (isAmbientContextNode(statement)) return;
    const declarationList = statement.declarationList;
    const hasLexicalBindings =
      (declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
    if (hasLexicalBindings) return;
    for (const declaration of declarationList.declarations) {
      for (const localName of collectBindingLocalNames(declaration.name)) {
        declaredIdentifiers.add(localName);
      }
    }
    return;
  }

  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return;
  }

  if (ts.isBlock(statement)) {
    for (const nestedStatement of statement.statements) {
      collectVarScopeStatementBindings(nestedStatement, declaredIdentifiers);
    }
    return;
  }

  if (ts.isIfStatement(statement)) {
    collectVarScopeStatementBindings(
      statement.thenStatement,
      declaredIdentifiers,
    );
    if (statement.elseStatement) {
      collectVarScopeStatementBindings(
        statement.elseStatement,
        declaredIdentifiers,
      );
    }
    return;
  }

  if (
    ts.isDoStatement(statement) ||
    ts.isWhileStatement(statement) ||
    ts.isWithStatement(statement)
  ) {
    collectVarScopeStatementBindings(statement.statement, declaredIdentifiers);
    return;
  }

  if (ts.isForStatement(statement)) {
    if (
      statement.initializer &&
      ts.isVariableDeclarationList(statement.initializer) &&
      (statement.initializer.flags &
        (ts.NodeFlags.Let | ts.NodeFlags.Const)) ===
        0
    ) {
      for (const declaration of statement.initializer.declarations) {
        for (const localName of collectBindingLocalNames(declaration.name)) {
          declaredIdentifiers.add(localName);
        }
      }
    }
    collectVarScopeStatementBindings(statement.statement, declaredIdentifiers);
    return;
  }

  if (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
    if (
      ts.isVariableDeclarationList(statement.initializer) &&
      (statement.initializer.flags &
        (ts.NodeFlags.Let | ts.NodeFlags.Const)) ===
        0
    ) {
      for (const declaration of statement.initializer.declarations) {
        for (const localName of collectBindingLocalNames(declaration.name)) {
          declaredIdentifiers.add(localName);
        }
      }
    }
    collectVarScopeStatementBindings(statement.statement, declaredIdentifiers);
    return;
  }

  if (ts.isSwitchStatement(statement)) {
    for (const clause of statement.caseBlock.clauses) {
      for (const nestedStatement of clause.statements) {
        collectVarScopeStatementBindings(nestedStatement, declaredIdentifiers);
      }
    }
    return;
  }

  if (ts.isTryStatement(statement)) {
    for (const nestedStatement of statement.tryBlock.statements) {
      collectVarScopeStatementBindings(nestedStatement, declaredIdentifiers);
    }
    if (statement.catchClause) {
      for (const nestedStatement of statement.catchClause.block.statements) {
        collectVarScopeStatementBindings(nestedStatement, declaredIdentifiers);
      }
    }
    if (statement.finallyBlock) {
      for (const nestedStatement of statement.finallyBlock.statements) {
        collectVarScopeStatementBindings(nestedStatement, declaredIdentifiers);
      }
    }
  }
}

function collectStatementLexicalScopeBindings(
  statement: ts.Statement,
  declaredIdentifiers: Set<string>,
  includeVarDeclarations = false,
): void {
  if (ts.isLabeledStatement(statement)) {
    collectStatementLexicalScopeBindings(
      statement.statement,
      declaredIdentifiers,
      includeVarDeclarations,
    );
    return;
  }

  if (ts.isVariableStatement(statement)) {
    if (isAmbientContextNode(statement)) return;
    const declarationList = statement.declarationList;
    const hasLexicalBindings =
      (declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
    if (!hasLexicalBindings && !includeVarDeclarations) {
      return;
    }
    for (const declaration of declarationList.declarations) {
      for (const localName of collectBindingLocalNames(declaration.name)) {
        declaredIdentifiers.add(localName);
      }
    }
    return;
  }

  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name &&
    !isAmbientContextNode(statement)
  ) {
    declaredIdentifiers.add(normalizeNamedSymbol(statement.name.text));
  }

  if (includeVarDeclarations) {
    collectVarScopeStatementBindings(statement, declaredIdentifiers);
  }
}

function collectLexicalScopeDeclaredIdentifiers(node: ts.Node): Set<string> {
  const declaredIdentifiers = new Set<string>();

  if (
    ts.isForStatement(node) &&
    node.initializer &&
    ts.isVariableDeclarationList(node.initializer) &&
    (node.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
  ) {
    for (const declaration of node.initializer.declarations) {
      for (const localName of collectBindingLocalNames(declaration.name)) {
        declaredIdentifiers.add(localName);
      }
    }
    return declaredIdentifiers;
  }

  if (
    (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    ts.isVariableDeclarationList(node.initializer) &&
    (node.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
  ) {
    for (const declaration of node.initializer.declarations) {
      for (const localName of collectBindingLocalNames(declaration.name)) {
        declaredIdentifiers.add(localName);
      }
    }
    return declaredIdentifiers;
  }

  if (ts.isCatchClause(node)) {
    const variableDeclaration = node.variableDeclaration;
    if (variableDeclaration) {
      for (const localName of collectBindingLocalNames(
        variableDeclaration.name,
      )) {
        declaredIdentifiers.add(localName);
      }
    }
    for (const statement of node.block.statements) {
      collectStatementLexicalScopeBindings(statement, declaredIdentifiers);
    }
    return declaredIdentifiers;
  }

  if (
    ts.isBlock(node) &&
    node.parent?.kind === ts.SyntaxKind.ClassStaticBlockDeclaration
  ) {
    for (const statement of node.statements) {
      collectStatementLexicalScopeBindings(
        statement,
        declaredIdentifiers,
        true,
      );
    }
    return declaredIdentifiers;
  }

  const statements = ts.isCaseBlock(node)
    ? node.clauses.flatMap((clause) => clause.statements)
    : ts.isBlock(node) || ts.isModuleBlock(node)
      ? [...node.statements]
      : [];

  for (const statement of statements) {
    collectStatementLexicalScopeBindings(statement, declaredIdentifiers);
  }

  return declaredIdentifiers;
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
          declaredIdentifiers: collectLexicalScopeDeclaredIdentifiers(node),
          mergeNonLexicalMutations: shouldMergeNonLexicalScopeMutations(node),
        }
      : undefined;
    const functionScopeSnapshot = ts.isFunctionLike(node)
      ? {
          moduleAliases: cloneStringArrayMap(moduleAliasByIdentifier),
          requireLikeIdentifiers: new Set(requireLikeIdentifiers),
        }
      : undefined;

    if (functionScopeSnapshot) {
      for (const shadowedIdentifier of collectFunctionScopeShadowedIdentifiers(
        node,
      )) {
        moduleAliasByIdentifier.delete(shadowedIdentifier);
        requireLikeIdentifiers.delete(shadowedIdentifier);
      }
    }

    if (scopeSnapshot) {
      for (const shadowedIdentifier of scopeSnapshot.declaredIdentifiers) {
        moduleAliasByIdentifier.delete(shadowedIdentifier);
        requireLikeIdentifiers.delete(shadowedIdentifier);
      }
    }

    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name &&
      !isAmbientContextNode(node)
    ) {
      const shadowedIdentifier = normalizeNamedSymbol(node.name.text);
      if (shadowedIdentifier) {
        moduleAliasByIdentifier.delete(shadowedIdentifier);
        requireLikeIdentifiers.delete(shadowedIdentifier);
      }
    }

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
      if (isAmbientContextNode(node)) {
        ts.forEachChild(node, visit);
        return;
      }
      const initializer = node.initializer
        ? unwrapInitializerExpression(node.initializer)
        : undefined;
      if (initializer) {
        if (isRequireLikeExpression(initializer, requireLikeIdentifiers)) {
          requireLikeIdentifiers.add(node.name.text);
        } else {
          requireLikeIdentifiers.delete(node.name.text);
        }
      } else {
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
      } else {
        moduleAliasByIdentifier.delete(node.name.text);
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
        } else if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
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
        if (!ts.isIdentifier(node.left)) {
          for (const localName of assignmentLocalNames) {
            requireLikeIdentifiers.delete(localName);
          }
        }
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
      for (const localName of bindingLocalNames) {
        requireLikeIdentifiers.delete(localName);
      }
      if (sources.length > 0) {
        for (const localName of bindingLocalNames) {
          moduleAliasByIdentifier.set(localName, sources);
        }
      } else {
        for (const localName of bindingLocalNames) {
          moduleAliasByIdentifier.delete(localName);
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
      const postScopeModuleAliases = cloneStringArrayMap(
        moduleAliasByIdentifier,
      );
      const postScopeRequireLikeIdentifiers = new Set(requireLikeIdentifiers);

      restoreStringArrayMap(
        moduleAliasByIdentifier,
        scopeSnapshot.moduleAliases,
      );
      restoreStringSet(
        requireLikeIdentifiers,
        scopeSnapshot.requireLikeIdentifiers,
      );

      if (scopeSnapshot.mergeNonLexicalMutations) {
        for (const [identifier, sources] of postScopeModuleAliases.entries()) {
          if (scopeSnapshot.declaredIdentifiers.has(identifier)) continue;
          const previousSources = scopeSnapshot.moduleAliases.get(identifier);
          if (!stringArraysEqual(previousSources, sources)) {
            moduleAliasByIdentifier.set(identifier, [...sources]);
          }
        }

        for (const identifier of scopeSnapshot.moduleAliases.keys()) {
          if (scopeSnapshot.declaredIdentifiers.has(identifier)) continue;
          if (!postScopeModuleAliases.has(identifier)) {
            moduleAliasByIdentifier.delete(identifier);
          }
        }

        for (const identifier of postScopeRequireLikeIdentifiers) {
          if (scopeSnapshot.declaredIdentifiers.has(identifier)) continue;
          if (!scopeSnapshot.requireLikeIdentifiers.has(identifier)) {
            requireLikeIdentifiers.add(identifier);
          }
        }

        for (const identifier of scopeSnapshot.requireLikeIdentifiers) {
          if (scopeSnapshot.declaredIdentifiers.has(identifier)) continue;
          if (!postScopeRequireLikeIdentifiers.has(identifier)) {
            requireLikeIdentifiers.delete(identifier);
          }
        }
      }
    } else if (functionScopeSnapshot) {
      restoreStringArrayMap(
        moduleAliasByIdentifier,
        functionScopeSnapshot.moduleAliases,
      );
      restoreStringSet(
        requireLikeIdentifiers,
        functionScopeSnapshot.requireLikeIdentifiers,
      );
    }

    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      !isAmbientContextNode(node)
    ) {
      const shadowedIdentifier = normalizeNamedSymbol(node.name.text);
      if (shadowedIdentifier) {
        moduleAliasByIdentifier.delete(shadowedIdentifier);
        requireLikeIdentifiers.delete(shadowedIdentifier);
      }
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
      ? {
          requireLikeIdentifiers: new Set(requireLikeIdentifiers),
          declaredIdentifiers: collectLexicalScopeDeclaredIdentifiers(node),
          mergeNonLexicalMutations: shouldMergeNonLexicalScopeMutations(node),
        }
      : undefined;
    const functionScopeSnapshot = ts.isFunctionLike(node)
      ? new Set(requireLikeIdentifiers)
      : undefined;

    if (functionScopeSnapshot) {
      for (const shadowedIdentifier of collectFunctionScopeShadowedIdentifiers(
        node,
      )) {
        requireLikeIdentifiers.delete(shadowedIdentifier);
      }
    }

    if (scopeSnapshot) {
      for (const shadowedIdentifier of scopeSnapshot.declaredIdentifiers) {
        requireLikeIdentifiers.delete(shadowedIdentifier);
      }
    }

    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name &&
      !isAmbientContextNode(node)
    ) {
      const shadowedIdentifier = normalizeNamedSymbol(node.name.text);
      if (shadowedIdentifier) {
        requireLikeIdentifiers.delete(shadowedIdentifier);
      }
    }

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
      if (isAmbientContextNode(node)) {
        ts.forEachChild(node, visit);
        return;
      }
      const initializer = node.initializer
        ? unwrapInitializerExpression(node.initializer)
        : undefined;
      if (initializer) {
        if (isRequireLikeExpression(initializer, requireLikeIdentifiers)) {
          requireLikeIdentifiers.add(node.name.text);
        } else {
          requireLikeIdentifiers.delete(node.name.text);
        }
      } else {
        requireLikeIdentifiers.delete(node.name.text);
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      (ts.isObjectBindingPattern(node.name) ||
        ts.isArrayBindingPattern(node.name))
    ) {
      for (const localName of collectBindingLocalNames(node.name)) {
        requireLikeIdentifiers.delete(localName);
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
      if (ts.isIdentifier(node.left)) {
        if (isRequireLikeExpression(rightExpression, requireLikeIdentifiers)) {
          requireLikeIdentifiers.add(node.left.text);
        } else if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          requireLikeIdentifiers.delete(node.left.text);
        }
      }

      if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        !ts.isIdentifier(node.left)
      ) {
        for (const localName of collectAssignmentPatternLocalNames(node.left)) {
          requireLikeIdentifiers.delete(localName);
        }
      }
    }

    ts.forEachChild(node, visit);

    if (scopeSnapshot) {
      const postScopeRequireLikeIdentifiers = new Set(requireLikeIdentifiers);

      restoreStringSet(
        requireLikeIdentifiers,
        scopeSnapshot.requireLikeIdentifiers,
      );

      if (scopeSnapshot.mergeNonLexicalMutations) {
        for (const identifier of postScopeRequireLikeIdentifiers) {
          if (scopeSnapshot.declaredIdentifiers.has(identifier)) continue;
          if (!scopeSnapshot.requireLikeIdentifiers.has(identifier)) {
            requireLikeIdentifiers.add(identifier);
          }
        }

        for (const identifier of scopeSnapshot.requireLikeIdentifiers) {
          if (scopeSnapshot.declaredIdentifiers.has(identifier)) continue;
          if (!postScopeRequireLikeIdentifiers.has(identifier)) {
            requireLikeIdentifiers.delete(identifier);
          }
        }
      }
    } else if (functionScopeSnapshot) {
      restoreStringSet(requireLikeIdentifiers, functionScopeSnapshot);
    }

    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      !isAmbientContextNode(node)
    ) {
      const shadowedIdentifier = normalizeNamedSymbol(node.name.text);
      if (shadowedIdentifier) {
        requireLikeIdentifiers.delete(shadowedIdentifier);
      }
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

  it('does not leak symbol-source aliases across function parameter shadows', () => {
    const source = [
      'const reqAlias = require;',
      'function run(reqAlias: any) {',
      "  return reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps function-scope type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  type reqAlias = (_value: unknown) => unknown;',
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps function-scope interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps function-scope ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare class reqAlias {}',
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps function-scope ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps function-scope ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare function reqAlias(_path: string): unknown;',
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps function-scope ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps function-scope ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps function-scope ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps function-scope ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps function-scope ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('does not leak function-scope enum alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak function-scope enum alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak function-scope class alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  class reqAlias {}',
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak function-scope class alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      'run();',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps function-scope type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  type moduleAlias = { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps function-scope interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  interface moduleAlias {',
      '    inner: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps function-scope ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps function-scope ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps function-scope ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare function moduleAlias(_path: string): unknown;',
      '  void preDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps function-scope ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare namespace moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps function-scope ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare module moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps function-scope ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare const moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps function-scope ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare let moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps function-scope ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare var moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak function-scope enum module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak function-scope enum module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak function-scope class module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak function-scope class module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'function run() {',
      '  class moduleAlias {}',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '}',
      'run();',
      'const outerDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('keeps symbol-source detection when require is ambient-declared as variable', () => {
    const source = [
      'declare const require: unknown;',
      "const ambientDeclaredDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('keeps symbol-source detection when require is ambient-declared as function', () => {
    const source = [
      'declare function require(path: string): unknown;',
      "const ambientDeclaredDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('keeps symbol-source detection when require is ambient-declared as class', () => {
    const source = [
      'declare class require {}',
      "const ambientDeclaredDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('keeps symbol-source detection when require is ambient-declared as enum', () => {
    const source = [
      'declare enum require {',
      '  Marker = 0,',
      '}',
      "const ambientDeclaredDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('keeps symbol-source detection when require is ambient-declared as namespace', () => {
    const source = [
      'declare namespace require {',
      '  const marker: unknown;',
      '}',
      "const ambientDeclaredDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('keeps symbol-source detection when require is ambient-declared as module', () => {
    const source = [
      'declare module require {',
      '  const marker: unknown;',
      '}',
      "const ambientDeclaredDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('keeps symbol-source detection when require is ambient-declared as let', () => {
    const source = [
      'declare let require: (path: string) => unknown;',
      "const ambientDeclaredDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('keeps symbol-source detection when require is ambient-declared as var', () => {
    const source = [
      'declare var require: (path: string) => unknown;',
      "const ambientDeclaredDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('keeps symbol-source detection when require has a type-alias declaration', () => {
    const source = [
      'type require = (path: string) => unknown;',
      "const ambientDeclaredDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('keeps symbol-source detection when require has an interface declaration', () => {
    const source = [
      'interface require {',
      '  (path: string): unknown;',
      '}',
      "const ambientDeclaredDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('does not treat shadowed require parameter default access as module-sourced', () => {
    const source = [
      "const outerDefault = require('./fixtures/guard-module.js').default;",
      'function run(require: any) {',
      "  return require('./fixtures/other-module.js').default;",
      '}',
      'void outerDefault;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps try-block ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare class reqAlias {}',
      '} catch {}',
      "const postTryDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps try-block ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '} catch {}',
      "const postTryDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps try-block ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare function reqAlias(path: string): unknown;',
      '} catch {}',
      "const postTryDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps try-block ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '} catch {}',
      "const postTryDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps try-block ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '} catch {}',
      "const postTryDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps try-block type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  type reqAlias = (_path: string) => unknown;',
      '} catch {}',
      "const postTryDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps try-block interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  interface reqAlias {',
      '    (_path: string): unknown;',
      '  }',
      '} catch {}',
      "const postTryDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps finally-block ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare class reqAlias {}',
      '}',
      "const postFinallyDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps finally-block ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postFinallyDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps finally-block ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare function reqAlias(path: string): unknown;',
      '}',
      "const postFinallyDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps finally-block ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postFinallyDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps finally-block ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postFinallyDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps finally-block type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  type reqAlias = (_path: string) => unknown;',
      '}',
      "const postFinallyDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps finally-block interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  interface reqAlias {',
      '    (_path: string): unknown;',
      '  }',
      '}',
      "const postFinallyDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps try-block ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare const reqAlias: (_path: string) => unknown;',
      '} catch {}',
      "const postTryDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps try-block ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare let reqAlias: (_path: string) => unknown;',
      '} catch {}',
      "const postTryDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps try-block ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare var reqAlias: (_path: string) => unknown;',
      '} catch {}',
      "const postTryDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps finally-block ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      "const postFinallyDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps finally-block ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      "const postFinallyDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps finally-block ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      "const postFinallyDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('does not leak symbol-source shadowing across catch clause scopes', () => {
    const source = [
      'try {',
      "  throw new Error('boom');",
      '} catch (require) {',
      "  require('./fixtures/other-module.js').default;",
      '}',
      "const postCatchDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak catch-block lexical alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const reqAlias = () => undefined;',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak catch-block lexical alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  const reqAlias = () => undefined;',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps catch-block type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  type reqAlias = (_value: unknown) => unknown;',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps catch-block interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps catch-block ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare class reqAlias {}',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps catch-block ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps catch-block ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare function reqAlias(_path: string): unknown;',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps catch-block ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps catch-block ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps catch-block ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare const reqAlias: (_path: string) => unknown;',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps catch-block ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare let reqAlias: (_path: string) => unknown;',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps catch-block ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare var reqAlias: (_path: string) => unknown;',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('does not leak hoisted catch-block function alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak catch-block class alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak catch-block class alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  class reqAlias {}',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak catch-block enum alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  void error;',
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak catch-block enum alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak catch binding-pattern require shadowing to outer symbol sources', () => {
    const source = [
      "const outerDefault = require('./fixtures/guard-module.js').default;",
      'try {',
      '  throw { require: () => undefined };',
      '} catch ({ require }) {',
      "  require('./fixtures/other-module.js').default;",
      '}',
      'void outerDefault;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak catch binding-pattern alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      '  throw { reqAlias: () => undefined };',
      '} catch ({ reqAlias }) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak nested catch binding-pattern require shadowing to outer symbol sources', () => {
    const source = [
      "const outerDefault = require('./fixtures/guard-module.js').default;",
      'try {',
      '  throw { nested: { require: () => undefined } };',
      '} catch ({ nested: { require } }) {',
      "  require('./fixtures/other-module.js').default;",
      '}',
      'void outerDefault;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak nested catch binding-pattern alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      '  throw { nested: { reqAlias: () => undefined } };',
      '} catch ({ nested: { reqAlias } }) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postCatchDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps module-source alias var declarations made inside catch block scopes', () => {
    const source = [
      'let moduleAlias: any;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  var moduleAlias = require('./fixtures/guard-module.js');",
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('clears module-source alias var declarations to non-module values inside catch block scopes', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  var moduleAlias = { default: 'not-a-module' };",
      '}',
      'const shadowedDefault = moduleAlias.default;',
      "const directDefault = require('./fixtures/guard-module.js').default;",
      'void shadowedDefault;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(
      references.filter(
        (reference) => reference === 'default@./fixtures/guard-module.js',
      ).length,
    ).to.equal(1);
  });

  it('does not leak catch-block lexical module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  const moduleAlias = { inner: preDeclarationSymbol };',
      '  void moduleAlias;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('keeps try-block ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '} catch {}',
      'const postTryDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps try-block ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '} catch {}',
      'const postTryDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps try-block ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare function moduleAlias(path: string): unknown;',
      '  void preDeclarationSymbol;',
      '} catch {}',
      'const postTryDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps try-block ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare namespace moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '} catch {}',
      'const postTryDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps try-block ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare module moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '} catch {}',
      'const postTryDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps try-block type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  type moduleAlias = { inner: unknown };',
      '  void preDeclarationSymbol;',
      '} catch {}',
      'const postTryDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps try-block interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  interface moduleAlias {',
      '    inner: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '} catch {}',
      'const postTryDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps finally-block ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {} finally {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '}',
      'const postFinallyDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps finally-block ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {} finally {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postFinallyDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps finally-block ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {} finally {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare function moduleAlias(path: string): unknown;',
      '  void preDeclarationSymbol;',
      '}',
      'const postFinallyDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps finally-block ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {} finally {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare namespace moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postFinallyDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps finally-block ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {} finally {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare module moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postFinallyDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps finally-block type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {} finally {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  type moduleAlias = { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postFinallyDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps finally-block interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {} finally {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  interface moduleAlias {',
      '    inner: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postFinallyDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps try-block ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare const moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '} catch {}',
      'const postTryDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps try-block ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare let moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '} catch {}',
      'const postTryDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps try-block ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare var moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '} catch {}',
      'const postTryDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps finally-block ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {} finally {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare const moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postFinallyDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps finally-block ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {} finally {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare let moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postFinallyDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps finally-block ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {} finally {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare var moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postFinallyDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps catch-block type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  type moduleAlias = { inner: unknown };',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps catch-block interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  interface moduleAlias {',
      '    inner: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps catch-block ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps catch-block ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps catch-block ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare function moduleAlias(_path: string): unknown;',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps catch-block ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare namespace moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps catch-block ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare module moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps catch-block ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare const moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps catch-block ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare let moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps catch-block ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare var moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak hoisted catch-block function module-source alias shadowing to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  function moduleAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak catch-block class module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak catch-block class module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  class moduleAlias {}',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak catch-block enum module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak catch-block enum module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '  void error;',
      '}',
      'const postCatchDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak symbol-source shadowing across lexical for-loop scopes', () => {
    const source = [
      'const reqAlias = require;',
      'for (const reqAlias of [() => undefined]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps lexical for-loop type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  type reqAlias = (_value: unknown) => unknown;',
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps lexical for-loop interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps lexical for-loop ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare class reqAlias {}',
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps lexical for-loop ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps lexical for-loop ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare function reqAlias(_path: string): unknown;',
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps lexical for-loop ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps lexical for-loop ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps lexical for-loop ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare const reqAlias: (_path: string) => unknown;',
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps lexical for-loop ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare let reqAlias: (_path: string) => unknown;',
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps lexical for-loop ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare var reqAlias: (_path: string) => unknown;',
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps while-block type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  type reqAlias = (_path: string) => unknown;',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps while-block interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps while-block ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare class reqAlias {}',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps while-block ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps while-block ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare function reqAlias(_path: string): unknown;',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps while-block ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps while-block ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps while-block ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare const reqAlias: (_path: string) => unknown;',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps while-block ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare let reqAlias: (_path: string) => unknown;',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps while-block ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare var reqAlias: (_path: string) => unknown;',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps do-while type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  type reqAlias = (_path: string) => unknown;',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps do-while interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps do-while ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare class reqAlias {}',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps do-while ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps do-while ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare function reqAlias(_path: string): unknown;',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps do-while ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps do-while ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps do-while ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare const reqAlias: (_path: string) => unknown;',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps do-while ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare let reqAlias: (_path: string) => unknown;',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps do-while ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare var reqAlias: (_path: string) => unknown;',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('does not leak direct require symbol-source shadowing across while scopes', () => {
    const source = [
      'while (true) {',
      '  const require = () => undefined;',
      "  require('./fixtures/other-module.js').default;",
      '  break;',
      '}',
      "const postWhileDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak direct require symbol-source shadowing across do-while scopes', () => {
    const source = [
      'do {',
      '  const require = () => undefined;',
      "  require('./fixtures/other-module.js').default;",
      '} while (false);',
      "const postDoWhileDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak while-block lexical alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  const reqAlias = () => undefined;',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak do-while lexical alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  const reqAlias = () => undefined;',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak direct require symbol-source shadowing across if-branch scopes', () => {
    const source = [
      'if (true) {',
      '  const require = () => undefined;',
      "  require('./fixtures/other-module.js').default;",
      '}',
      "const postIfDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak direct require symbol-source shadowing across else-branch scopes', () => {
    const source = [
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const require = () => undefined;',
      "  require('./fixtures/other-module.js').default;",
      '}',
      "const postElseDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak if-branch lexical alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  const reqAlias = () => undefined;',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak else-branch lexical alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  const reqAlias = () => undefined;',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps if-branch type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  type reqAlias = (_path: string) => unknown;',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps else-branch type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  type reqAlias = (_path: string) => unknown;',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps if-branch interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps else-branch interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps if-branch ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare class reqAlias {}',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps else-branch ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare class reqAlias {}',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps if-branch ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps else-branch ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps if-branch ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare function reqAlias(_path: string): unknown;',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps else-branch ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare function reqAlias(_path: string): unknown;',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps if-branch ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps else-branch ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps if-branch ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps else-branch ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps if-branch ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps else-branch ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps if-branch ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps else-branch ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps if-branch ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps else-branch ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps if-branch var alias declarations made inside block scopes in symbol sources', () => {
    const source = [
      'if (true) {',
      '  var reqAlias = require;',
      "  reqAlias('./fixtures/guard-module.js').default;",
      '}',
      "const postIfDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps else-branch var alias declarations made inside block scopes in symbol sources', () => {
    const source = [
      'if (false) {',
      '  void 0;',
      '} else {',
      '  var reqAlias = require;',
      "  reqAlias('./fixtures/guard-module.js').default;",
      '}',
      "const postElseDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('clears if-branch var alias declarations to non-require values inside block scopes in symbol sources', () => {
    const source = [
      'if (true) {',
      '  var reqAlias = require;',
      "  reqAlias('./fixtures/guard-module.js').default;",
      '  reqAlias = () => undefined;',
      '}',
      "const postIfDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('clears else-branch var alias declarations to non-require values inside block scopes in symbol sources', () => {
    const source = [
      'if (false) {',
      '  void 0;',
      '} else {',
      '  var reqAlias = require;',
      "  reqAlias('./fixtures/guard-module.js').default;",
      '  reqAlias = () => undefined;',
      '}',
      "const postElseDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('applies if-branch assignments to outer require aliases for symbol sources', () => {
    const source = [
      'let reqAlias: any = require;',
      'if (true) {',
      '  reqAlias = () => undefined;',
      '}',
      "reqAlias('./fixtures/other-module.js').default;",
      "const directDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('applies else-branch assignments to outer require aliases for symbol sources', () => {
    const source = [
      'let reqAlias: any = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      '  reqAlias = () => undefined;',
      '}',
      "reqAlias('./fixtures/other-module.js').default;",
      "const directDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('applies if-branch destructuring assignments to outer require aliases for symbol sources', () => {
    const source = [
      'let reqAlias: any = require;',
      'if (true) {',
      '  ({ reqAlias } = { reqAlias: () => undefined });',
      '}',
      "reqAlias('./fixtures/other-module.js').default;",
      "const directDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('applies else-branch destructuring assignments to outer require aliases for symbol sources', () => {
    const source = [
      'let reqAlias: any = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      '  ({ reqAlias } = { reqAlias: () => undefined });',
      '}',
      "reqAlias('./fixtures/other-module.js').default;",
      "const directDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('applies if-branch require assignments to outer aliases for symbol sources', () => {
    const source = [
      'let reqAlias: any;',
      'if (true) {',
      '  reqAlias = require;',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('applies else-branch require assignments to outer aliases for symbol sources', () => {
    const source = [
      'let reqAlias: any;',
      'if (false) {',
      '  void 0;',
      '} else {',
      '  reqAlias = require;',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('does not leak hoisted if-branch function alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak hoisted else-branch function alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak if-branch class alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  class reqAlias {}',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak else-branch class alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  class reqAlias {}',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak if-branch enum alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak else-branch enum alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak if-branch class alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak else-branch class alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak if-branch function alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak else-branch function alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak if-branch enum alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postIfDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak else-branch enum alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postElseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak hoisted while-block function alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak hoisted do-while function alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak while-block class alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  class reqAlias {}',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak do-while class alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  class reqAlias {}',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak while-block class alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak do-while class alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js').default;",
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak while-block function alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak do-while function alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak while-block enum alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak do-while enum alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak while-block enum alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  break;',
      '}',
      "const postWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak do-while enum alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '} while (false);',
      "const postDoWhileDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak lexical for-loop enum alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak lexical for-loop enum alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak lexical for-loop class alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  class reqAlias {}',
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak lexical for-loop class alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  void iteration;',
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps lexical for-loop type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  type moduleAlias = { inner: unknown };',
      '  void preDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps lexical for-loop interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  interface moduleAlias {',
      '    inner: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps lexical for-loop ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps lexical for-loop ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps lexical for-loop ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare function moduleAlias(_path: string): unknown;',
      '  void preDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps lexical for-loop ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare namespace moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps lexical for-loop ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare module moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps lexical for-loop ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare const moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps lexical for-loop ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare let moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps lexical for-loop ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare var moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps while-block type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  type moduleAlias = { inner: unknown };',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps while-block interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  interface moduleAlias {',
      '    inner: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps while-block ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps while-block ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps while-block ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare function moduleAlias(_path: string): unknown;',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps while-block ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare namespace moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps while-block ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare module moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps while-block ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare const moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps while-block ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare let moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps while-block ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare var moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps do-while type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  type moduleAlias = { inner: unknown };',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps do-while interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  interface moduleAlias {',
      '    inner: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps do-while ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps do-while ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps do-while ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare function moduleAlias(_path: string): unknown;',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps do-while ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare namespace moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps do-while ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare module moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps do-while ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare const moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps do-while ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare let moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps do-while ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare var moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak while-block lexical module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  const moduleAlias = { inner: preDeclarationSymbol };',
      '  void moduleAlias;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak do-while lexical module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  const moduleAlias = { inner: preDeclarationSymbol };',
      '  void moduleAlias;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak while-block class module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak do-while class module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak if-branch lexical module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  const moduleAlias = { inner: preDeclarationSymbol };',
      '  void moduleAlias;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak else-branch lexical module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  const moduleAlias = { inner: preDeclarationSymbol };',
      '  void moduleAlias;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('keeps if-branch type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  type moduleAlias = { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps else-branch type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  type moduleAlias = { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps if-branch interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  interface moduleAlias {',
      '    inner: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps else-branch interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  interface moduleAlias {',
      '    inner: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps if-branch ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps else-branch ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps if-branch ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps else-branch ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps if-branch ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare function moduleAlias(_path: string): unknown;',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps else-branch ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare function moduleAlias(_path: string): unknown;',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps if-branch ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare namespace moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps else-branch ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare namespace moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps if-branch ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare module moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps else-branch ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare module moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps if-branch ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare const moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps else-branch ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare const moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps if-branch ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare let moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps else-branch ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare let moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps if-branch ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare var moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps else-branch ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare var moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps if-branch var module-source alias declarations made inside block scopes', () => {
    const source = [
      'if (true) {',
      "  var moduleAlias: any = require('./fixtures/guard-module.js');",
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('keeps else-branch var module-source alias declarations made inside block scopes', () => {
    const source = [
      'if (false) {',
      '  void 0;',
      '} else {',
      "  var moduleAlias: any = require('./fixtures/guard-module.js');",
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('clears if-branch var module-source alias declarations to non-module values inside block scopes', () => {
    const source = [
      "const fallbackDefault = require('./fixtures/other-module.js').default;",
      'if (true) {',
      "  var moduleAlias: any = require('./fixtures/guard-module.js');",
      '  moduleAlias = { default: fallbackDefault };',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/other-module.js');
    expect(references).to.not.include('default@./fixtures/guard-module.js');
  });

  it('clears else-branch var module-source alias declarations to non-module values inside block scopes', () => {
    const source = [
      "const fallbackDefault = require('./fixtures/other-module.js').default;",
      'if (false) {',
      '  void 0;',
      '} else {',
      "  var moduleAlias: any = require('./fixtures/guard-module.js');",
      '  moduleAlias = { default: fallbackDefault };',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/other-module.js');
    expect(references).to.not.include('default@./fixtures/guard-module.js');
  });

  it('applies if-branch assignments to outer module-source aliases for symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      "const fallbackDefault = require('./fixtures/other-module.js').default;",
      'if (true) {',
      '  moduleAlias = { default: fallbackDefault };',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/other-module.js');
    expect(references).to.not.include('default@./fixtures/guard-module.js');
  });

  it('applies else-branch assignments to outer module-source aliases for symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      "const fallbackDefault = require('./fixtures/other-module.js').default;",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  moduleAlias = { default: fallbackDefault };',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/other-module.js');
    expect(references).to.not.include('default@./fixtures/guard-module.js');
  });

  it('applies if-branch destructuring assignments to outer module-source aliases for symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      "const fallbackDefault = require('./fixtures/other-module.js').default;",
      'if (true) {',
      '  ({ moduleAlias } = { moduleAlias: { default: fallbackDefault } });',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/other-module.js');
    expect(references).to.not.include('default@./fixtures/guard-module.js');
  });

  it('applies else-branch destructuring assignments to outer module-source aliases for symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      "const fallbackDefault = require('./fixtures/other-module.js').default;",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  ({ moduleAlias } = { moduleAlias: { default: fallbackDefault } });',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/other-module.js');
    expect(references).to.not.include('default@./fixtures/guard-module.js');
  });

  it('applies if-branch require assignments to outer module-source aliases for symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      "  moduleAlias = require('./fixtures/other-module.js');",
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/other-module.js');
    expect(references).to.not.include('default@./fixtures/guard-module.js');
  });

  it('applies else-branch require assignments to outer module-source aliases for symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      "  moduleAlias = require('./fixtures/other-module.js');",
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/other-module.js');
    expect(references).to.not.include('default@./fixtures/guard-module.js');
  });

  it('does not leak if-branch class module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak else-branch class module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak hoisted if-branch function module-source alias shadowing to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  function moduleAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak hoisted else-branch function module-source alias shadowing to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  function moduleAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak if-branch enum module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak else-branch enum module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak if-branch class module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  class moduleAlias {}',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak else-branch class module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  class moduleAlias {}',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak if-branch function module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  function moduleAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak else-branch function module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  function moduleAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak if-branch enum module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (true) {',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '}',
      'const postIfDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak else-branch enum module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'if (false) {',
      '  void 0;',
      '} else {',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '}',
      'const postElseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak hoisted while-block function module-source alias shadowing to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  function moduleAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak hoisted do-while function module-source alias shadowing to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  function moduleAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak while-block enum module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak do-while enum module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak while-block class module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  class moduleAlias {}',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak do-while class module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  class moduleAlias {}',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak while-block function module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  function moduleAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak do-while function module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  function moduleAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak while-block enum module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'while (true) {',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '  break;',
      '}',
      'const postWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak do-while enum module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'do {',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '} while (false);',
      'const postDoWhileDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak lexical for-loop enum module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak lexical for-loop enum module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak lexical for-loop class module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak lexical for-loop class module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'for (const iteration of [1]) {',
      '  class moduleAlias {}',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '  void iteration;',
      '}',
      'const postLoopDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak direct require symbol-source shadowing across lexical for-of scopes', () => {
    const source = [
      'for (const require of [() => undefined]) {',
      "  require('./fixtures/other-module.js').default;",
      '}',
      "const postLoopDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak direct require symbol-source shadowing across lexical for-in scopes', () => {
    const source = [
      'for (const require in { item: 1 }) {',
      "  require('./fixtures/other-module.js').default;",
      '}',
      "const postLoopDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak direct require symbol-source shadowing across lexical for scopes', () => {
    const source = [
      'for (let require = () => undefined; ; ) {',
      "  require('./fixtures/other-module.js').default;",
      '  break;',
      '}',
      "const postLoopDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not treat binding-pattern shadowed aliases as module-sourced', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      '  const { reqAlias } = { reqAlias: () => undefined };',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not treat loop binding-pattern shadowed aliases as module-sourced', () => {
    const source = [
      'const reqAlias = require;',
      'for (const { reqAlias } of [{ reqAlias: () => undefined }]) {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postLoopDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not treat assignment-pattern shadowed aliases as module-sourced', () => {
    const source = [
      'let reqAlias = require;',
      '({ reqAlias } = { reqAlias: () => undefined });',
      "reqAlias('./fixtures/other-module.js').default;",
      "const directDefault = require('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps module-source alias assignments made inside block scopes', () => {
    const source = [
      'let moduleAlias: any;',
      '{',
      "  moduleAlias = require('./fixtures/guard-module.js');",
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('keeps block type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  type reqAlias = (_value: unknown) => unknown;',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps block interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps block ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare class reqAlias {}',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps block ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps block ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare function reqAlias(_path: string): unknown;',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps block ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps block ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps block ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps block ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps block ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps block type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  type moduleAlias = { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps block interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  interface moduleAlias {',
      '    inner: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps block ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps block ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps block ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare function moduleAlias(_path: string): unknown;',
      '  void preDeclarationSymbol;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps block ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare namespace moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps block ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare module moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps block ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare const moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps block ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare let moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps block ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare var moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak block lexical module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  const moduleAlias = { inner: preDeclarationSymbol };',
      '  void moduleAlias;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak hoisted block function module-source alias shadowing to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  function moduleAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak block class module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '  void moduleAlias;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak block class module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  class moduleAlias {}',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '  void moduleAlias;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak block enum module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '  void moduleAlias;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak block enum module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '  void moduleAlias;',
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak block lexical alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  const reqAlias = () => undefined;',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak hoisted block function alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak block class alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  class reqAlias {}',
      '  void reqAlias;',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak block class alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  void reqAlias;',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak block enum alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  void reqAlias;',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak block enum alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  void reqAlias;',
      '}',
      "const postBlockDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('clears module-source alias assignments to non-module values inside block scopes', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      '{',
      "  moduleAlias = { default: 'not-a-module' };",
      '}',
      'const shadowedDefault = moduleAlias.default;',
      "const directDefault = require('./fixtures/guard-module.js').default;",
      'void shadowedDefault;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(
      references.filter(
        (reference) => reference === 'default@./fixtures/guard-module.js',
      ).length,
    ).to.equal(1);
  });

  it('keeps module-source alias var declarations made inside block scopes', () => {
    const source = [
      '{',
      "  var moduleAlias = require('./fixtures/guard-module.js');",
      '}',
      'const postBlockDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('keeps module-source alias assignments made inside switch case scopes', () => {
    const source = [
      'let moduleAlias: any;',
      'switch (1) {',
      '  case 1:',
      "    moduleAlias = require('./fixtures/guard-module.js');",
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('clears module-source alias assignments to non-module values inside switch case scopes', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      "    moduleAlias = { default: 'not-a-module' };",
      '    break;',
      '}',
      'const shadowedDefault = moduleAlias.default;',
      "const directDefault = require('./fixtures/guard-module.js').default;",
      'void shadowedDefault;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(
      references.filter(
        (reference) => reference === 'default@./fixtures/guard-module.js',
      ).length,
    ).to.equal(1);
  });

  it('does not leak switch-case lexical alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1: {',
      '    const reqAlias = () => undefined;',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    break;',
      '  }',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak switch-case lexical alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    const reqAlias = () => undefined;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps switch-case type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    type reqAlias = (_value: unknown) => unknown;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps switch-case interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    interface reqAlias {',
      '      value: string;',
      '    }',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps switch-case ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare class reqAlias {}',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps switch-case ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare enum reqAlias {',
      '      Marker = 0,',
      '    }',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps switch-case ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare function reqAlias(_path: string): unknown;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps switch-case ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare namespace reqAlias {',
      '      const marker: unknown;',
      '    }',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps switch-case ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare module reqAlias {',
      '      const marker: unknown;',
      '    }',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps switch-case ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare const reqAlias: (_path: string) => unknown;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps switch-case ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare let reqAlias: (_path: string) => unknown;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps switch-case ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare var reqAlias: (_path: string) => unknown;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('does not leak hoisted switch-case function alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    function reqAlias(_value: unknown) {',
      '      return _value;',
      '    }',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak switch-case class alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1: {',
      '    class reqAlias {}',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    break;',
      '  }',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak switch-case class alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    class reqAlias {}',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak switch-case enum alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    enum reqAlias {',
      '      Marker = 0,',
      '    }',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak switch-case enum alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1: {',
      '    enum reqAlias {',
      '      Marker = 0,',
      '    }',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    break;',
      '  }',
      '}',
      "const postCaseDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak switch-case lexical module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    const moduleAlias = { inner: preDeclarationSymbol };',
      '    void moduleAlias;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('keeps switch-case type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    type moduleAlias = { inner: unknown };',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps switch-case interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    interface moduleAlias {',
      '      inner: unknown;',
      '    }',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps switch-case ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare class moduleAlias {}',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps switch-case ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare enum moduleAlias {',
      '      Marker = 0,',
      '    }',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps switch-case ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare function moduleAlias(_path: string): unknown;',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps switch-case ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare namespace moduleAlias {',
      '      const marker: unknown;',
      '    }',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps switch-case ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare module moduleAlias {',
      '      const marker: unknown;',
      '    }',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps switch-case ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare const moduleAlias: { inner: unknown };',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps switch-case ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare let moduleAlias: { inner: unknown };',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps switch-case ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare var moduleAlias: { inner: unknown };',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak hoisted switch-case function module-source alias shadowing to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    function moduleAlias(_value: unknown) {',
      '      return _value;',
      '    }',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak switch-case class module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    class moduleAlias {}',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak switch-case class module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1: {',
      '    class moduleAlias {}',
      '    const postDeclarationSymbol = moduleAlias.inner;',
      '    void postDeclarationSymbol;',
      '    break;',
      '  }',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak switch-case enum module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1:',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    enum moduleAlias {',
      '      Marker = 0,',
      '    }',
      '    void preDeclarationSymbol;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak switch-case enum module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'switch (1) {',
      '  case 1: {',
      '    enum moduleAlias {',
      '      Marker = 0,',
      '    }',
      '    const postDeclarationSymbol = moduleAlias.inner;',
      '    void postDeclarationSymbol;',
      '    break;',
      '  }',
      '  default:',
      '    break;',
      '}',
      'const postCaseDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak class static-block lexical alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    const reqAlias = () => undefined;',
      "    reqAlias('./fixtures/other-module.js').default;",
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block function declaration alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    function reqAlias(_value: unknown) {',
      '      return _value;',
      '    }',
      "    reqAlias('./fixtures/other-module.js').default;",
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block class alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    class reqAlias {}',
      "    reqAlias('./fixtures/other-module.js').default;",
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak hoisted class static-block function alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    function reqAlias(_value: unknown) {',
      '      return _value;',
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block lexical alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    const reqAlias = () => undefined;',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block class alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    class reqAlias {}',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block enum alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    enum reqAlias {',
      '      Marker = 0,',
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block enum alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    enum reqAlias {',
      '      Marker = 0,',
      '    }',
      "    reqAlias('./fixtures/other-module.js').default;",
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps class static-block type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    type reqAlias = (_value: unknown) => unknown;',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps class static-block interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    interface reqAlias {',
      '      value: string;',
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps class static-block ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare class reqAlias {}',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps class static-block ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare enum reqAlias {',
      '      Marker = 0,',
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps class static-block ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare function reqAlias(_path: string): unknown;',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps class static-block ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare namespace reqAlias {',
      '      const marker: unknown;',
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps class static-block ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare module reqAlias {',
      '      const marker: unknown;',
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps class static-block ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare const reqAlias: (_path: string) => unknown;',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps class static-block ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare let reqAlias: (_path: string) => unknown;',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps class static-block ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js').default;",
      '    declare var reqAlias: (_path: string) => unknown;',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block var alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    var reqAlias = () => undefined;',
      "    reqAlias('./fixtures/other-module.js').default;",
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak nested class static-block var alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    if (true) {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js').default;",
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block for-of var alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    for (var reqAlias of [() => undefined]) {',
      "      reqAlias('./fixtures/other-module.js').default;",
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block for-in var alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    const aliases: Record<string, (value: unknown) => unknown> = { first: () => undefined };',
      '    for (var aliasKey in aliases) {',
      '      var reqAlias = aliases[aliasKey];',
      "      reqAlias('./fixtures/other-module.js').default;",
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block switch-case var alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    switch (1) {',
      '      case 1:',
      '        var reqAlias = () => undefined;',
      "        reqAlias('./fixtures/other-module.js').default;",
      '        break;',
      '      default:',
      '        break;',
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block for var alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    for (var i = 0; i < 1; i += 1) {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js').default;",
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block do-while var alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    do {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js').default;",
      '      break;',
      '    } while (false);',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block while var alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    while (true) {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js').default;",
      '      break;',
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block try-block var alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    try {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js').default;",
      '    } catch (error) {',
      '      void error;',
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block catch-block var alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    try {',
      "      throw new Error('boom');",
      '    } catch (error) {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js').default;",
      '      void error;',
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block finally-block var alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    try {',
      '      void 0;',
      '    } finally {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js').default;",
      '    }',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('applies class static-block assignments to outer require aliases for symbol sources', () => {
    const source = [
      "const guardDefault = require('./fixtures/guard-module.js').default;",
      'let reqAlias: any = require;',
      'class ShadowContainer {',
      '  static {',
      '    reqAlias = () => undefined;',
      '  }',
      '}',
      "const shadowedDefault = reqAlias('./fixtures/other-module.js').default;",
      'void shadowedDefault;',
      'void guardDefault;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('applies class static-block destructuring assignments to outer require aliases for symbol sources', () => {
    const source = [
      "const guardDefault = require('./fixtures/guard-module.js').default;",
      'let reqAlias: any = require;',
      'class ShadowContainer {',
      '  static {',
      '    ({ reqAlias } = { reqAlias: () => undefined });',
      '  }',
      '}',
      "const shadowedDefault = reqAlias('./fixtures/other-module.js').default;",
      'void shadowedDefault;',
      'void guardDefault;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('applies class static-block require assignments to outer aliases for symbol sources', () => {
    const source = [
      'let reqAlias: any;',
      'class ShadowContainer {',
      '  static {',
      '    reqAlias = require;',
      '  }',
      '}',
      "const postStaticDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('applies class static-block assignments to outer module-source aliases for symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      "    moduleAlias = require('./fixtures/other-module.js');",
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/other-module.js');
    expect(references).to.not.include('default@./fixtures/guard-module.js');
  });

  it('applies class static-block destructuring assignments to outer module-source aliases for symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      "    ({ moduleAlias } = { moduleAlias: require('./fixtures/other-module.js') });",
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/other-module.js');
    expect(references).to.not.include('default@./fixtures/guard-module.js');
  });

  it('applies class static-block require-call assignments to outer module-source aliases for symbol sources', () => {
    const source = [
      'let moduleAlias: any;',
      'class ShadowContainer {',
      '  static {',
      "    moduleAlias = require('./fixtures/guard-module.js');",
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('applies nested class static-block assignments to outer module-source aliases for symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    if (true) {',
      "      moduleAlias = require('./fixtures/other-module.js');",
      '    }',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/other-module.js');
    expect(references).to.not.include('default@./fixtures/guard-module.js');
  });

  it('does not leak nested class static-block var module-source aliases to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    if (true) {',
      "      var moduleAlias = require('./fixtures/other-module.js');",
      '      void moduleAlias;',
      '    }',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block var module-source aliases to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      "    var moduleAlias = require('./fixtures/other-module.js');",
      '    void moduleAlias;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block do-while var module-source aliases to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    do {',
      "      var moduleAlias = require('./fixtures/other-module.js');",
      '      void moduleAlias;',
      '      break;',
      '    } while (false);',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block while var module-source aliases to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    while (true) {',
      "      var moduleAlias = require('./fixtures/other-module.js');",
      '      void moduleAlias;',
      '      break;',
      '    }',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak class static-block lexical module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    const moduleAlias = { inner: preDeclarationSymbol };',
      '    void moduleAlias;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('keeps class static-block type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    type moduleAlias = { inner: unknown };',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps class static-block interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    interface moduleAlias {',
      '      inner: unknown;',
      '    }',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps class static-block ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare class moduleAlias {}',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps class static-block ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare enum moduleAlias {',
      '      Marker = 0,',
      '    }',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps class static-block ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare function moduleAlias(_path: string): unknown;',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps class static-block ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare namespace moduleAlias {',
      '      const marker: unknown;',
      '    }',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps class static-block ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare module moduleAlias {',
      '      const marker: unknown;',
      '    }',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps class static-block ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare const moduleAlias: { inner: unknown };',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps class static-block ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare let moduleAlias: { inner: unknown };',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps class static-block ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    declare var moduleAlias: { inner: unknown };',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak hoisted class static-block function module-source alias shadowing to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    function moduleAlias(_value: unknown) {',
      '      return _value;',
      '    }',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak class static-block class module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    class moduleAlias {}',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak class static-block class module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    class moduleAlias {}',
      '    const postDeclarationSymbol = moduleAlias.inner;',
      '    void postDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak class static-block enum module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    const preDeclarationSymbol = moduleAlias.inner;',
      '    enum moduleAlias {',
      '      Marker = 0,',
      '    }',
      '    void preDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak class static-block enum module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'class ShadowContainer {',
      '  static {',
      '    enum moduleAlias {',
      '      Marker = 0,',
      '    }',
      '    const postDeclarationSymbol = moduleAlias.inner;',
      '    void postDeclarationSymbol;',
      '  }',
      '}',
      'const postStaticDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak namespace lexical alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      '  const reqAlias = () => undefined;',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak namespace lexical alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  const reqAlias = () => undefined;',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps namespace type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  type reqAlias = (_value: unknown) => unknown;',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps namespace interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps namespace ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare class reqAlias {}',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps namespace ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps namespace ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare function reqAlias(_path: string): unknown;',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps namespace ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps namespace ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps namespace ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps namespace ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps namespace ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('does not leak hoisted namespace function alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak namespace class alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  class reqAlias {}',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak namespace class alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak namespace enum alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak namespace enum alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postNamespaceDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak namespace lexical module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  const moduleAlias = { inner: preDeclarationSymbol };',
      '  void moduleAlias;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('keeps namespace type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  type moduleAlias = { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps namespace interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  interface moduleAlias {',
      '    inner: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps namespace ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps namespace ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps namespace ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare function moduleAlias(_path: string): unknown;',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps namespace ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare namespace moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps namespace ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare module moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps namespace ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare const moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps namespace ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare let moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps namespace ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare var moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak hoisted namespace function module-source alias shadowing to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  function moduleAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak namespace class module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak namespace class module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  class moduleAlias {}',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak namespace enum module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak namespace enum module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'namespace ShadowSpace {',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '}',
      'const postNamespaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak labeled lexical alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      '  const reqAlias = () => undefined;',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak labeled lexical alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  const reqAlias = () => undefined;',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps labeled type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  type reqAlias = (_value: unknown) => unknown;',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps labeled interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps labeled ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare class reqAlias {}',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps labeled ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps labeled ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare function reqAlias(_path: string): unknown;',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps labeled ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps labeled ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps labeled ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps labeled ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps labeled ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('does not leak hoisted labeled function alias shadowing to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak labeled class alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  class reqAlias {}',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak labeled class alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak labeled enum alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js').default;",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak labeled enum alias declarations to outer symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const postLabelDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not leak labeled lexical module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  const moduleAlias = { inner: preDeclarationSymbol };',
      '  void moduleAlias;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('keeps labeled type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  type moduleAlias = { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps labeled interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  interface moduleAlias {',
      '    inner: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps labeled ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps labeled ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps labeled ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare function moduleAlias(_path: string): unknown;',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps labeled ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare namespace moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps labeled ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare module moduleAlias {',
      '    const marker: unknown;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps labeled ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare const moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps labeled ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare let moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps labeled ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  declare var moduleAlias: { inner: unknown };',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak hoisted labeled function module-source alias shadowing to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  function moduleAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak labeled class module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  class moduleAlias {}',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak labeled class module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  class moduleAlias {}',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak labeled enum module-source alias shadowing before declaration to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  const preDeclarationSymbol = moduleAlias.inner;',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  void preDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('does not leak labeled enum module-source alias declarations to outer symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'label: {',
      '  enum moduleAlias {',
      '    Marker = 0,',
      '  }',
      '  const postDeclarationSymbol = moduleAlias.inner;',
      '  void postDeclarationSymbol;',
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('inner@./fixtures/guard-module.js');
  });

  it('keeps labeled var module-source alias declarations made inside block scopes', () => {
    const source = [
      'let moduleAlias: any;',
      'label: {',
      "  var moduleAlias = require('./fixtures/guard-module.js');",
      '}',
      'const postLabelDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
  });

  it('does not treat top-level function declaration named require as module-sourced', () => {
    const source = [
      "const preShadowDefault = require('./fixtures/guard-module.js').default;",
      'function require(_value: unknown) {',
      '  return _value;',
      '}',
      "const postShadowDefault = require('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not treat top-level class declaration named require alias as module-sourced', () => {
    const source = [
      'const reqAlias = require;',
      "const preShadowDefault = reqAlias('./fixtures/guard-module.js').default;",
      'class reqAlias {}',
      "const postShadowDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('does not treat top-level enum declaration named require alias as module-sourced', () => {
    const source = [
      'const reqAlias = require;',
      "const preShadowDefault = reqAlias('./fixtures/guard-module.js').default;",
      'enum reqAlias { Primary = 1 }',
      "const postShadowDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
  });

  it('keeps top-level ambient class declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientDefault = reqAlias('./fixtures/guard-module.js').default;",
      'declare class reqAlias {}',
      "const postAmbientDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps top-level ambient enum declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientDefault = reqAlias('./fixtures/guard-module.js').default;",
      'declare enum reqAlias {',
      '  Primary = 1,',
      '}',
      "const postAmbientDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps top-level ambient function declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientDefault = reqAlias('./fixtures/guard-module.js').default;",
      'declare function reqAlias(_value: unknown): unknown;',
      "const postAmbientDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps top-level ambient const declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientDefault = reqAlias('./fixtures/guard-module.js').default;",
      'declare const reqAlias: (_value: unknown) => unknown;',
      "const postAmbientDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps top-level ambient var declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientDefault = reqAlias('./fixtures/guard-module.js').default;",
      'declare var reqAlias: (_value: unknown) => unknown;',
      "const postAmbientDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps top-level ambient let declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientDefault = reqAlias('./fixtures/guard-module.js').default;",
      'declare let reqAlias: (_value: unknown) => unknown;',
      "const postAmbientDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps top-level ambient namespace declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientDefault = reqAlias('./fixtures/guard-module.js').default;",
      'declare namespace reqAlias {',
      '  const marker: unknown;',
      '}',
      "const postAmbientDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps top-level ambient module declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientDefault = reqAlias('./fixtures/guard-module.js').default;",
      'declare module reqAlias {',
      '  const marker: unknown;',
      '}',
      "const postAmbientDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps top-level type-alias declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      "const preTypeAliasDefault = reqAlias('./fixtures/guard-module.js').default;",
      'type reqAlias = (_value: unknown) => unknown;',
      "const postTypeAliasDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps top-level interface declarations from shadowing runtime require aliases in symbol sources', () => {
    const source = [
      'const reqAlias = require;',
      "const preInterfaceDefault = reqAlias('./fixtures/guard-module.js').default;",
      'interface reqAlias {',
      '  marker: unknown;',
      '}',
      "const postInterfaceDefault = reqAlias('./fixtures/other-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('default@./fixtures/other-module.js');
  });

  it('keeps top-level ambient class declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'const preAmbientInner = moduleAlias.inner;',
      'declare class moduleAlias {}',
      'const postAmbientInner = moduleAlias.inner;',
      'void preAmbientInner;',
      'void postAmbientInner;',
      'const postAmbientDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps top-level ambient enum declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'const preAmbientInner = moduleAlias.inner;',
      'declare enum moduleAlias {',
      '  Primary = 1,',
      '}',
      'const postAmbientInner = moduleAlias.inner;',
      'void preAmbientInner;',
      'void postAmbientInner;',
      'const postAmbientDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps top-level ambient function declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'const preAmbientInner = moduleAlias.inner;',
      'declare function moduleAlias(_value: unknown): unknown;',
      'const postAmbientInner = moduleAlias.inner;',
      'void preAmbientInner;',
      'void postAmbientInner;',
      'const postAmbientDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps top-level ambient const declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'const preAmbientInner = moduleAlias.inner;',
      'declare const moduleAlias: { inner: unknown };',
      'const postAmbientInner = moduleAlias.inner;',
      'void preAmbientInner;',
      'void postAmbientInner;',
      'const postAmbientDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps top-level ambient var declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'const preAmbientInner = moduleAlias.inner;',
      'declare var moduleAlias: { inner: unknown };',
      'const postAmbientInner = moduleAlias.inner;',
      'void preAmbientInner;',
      'void postAmbientInner;',
      'const postAmbientDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps top-level ambient let declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'const preAmbientInner = moduleAlias.inner;',
      'declare let moduleAlias: { inner: unknown };',
      'const postAmbientInner = moduleAlias.inner;',
      'void preAmbientInner;',
      'void postAmbientInner;',
      'const postAmbientDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps top-level ambient namespace declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'const preAmbientInner = moduleAlias.inner;',
      'declare namespace moduleAlias {',
      '  const marker: unknown;',
      '}',
      'const postAmbientInner = moduleAlias.inner;',
      'void preAmbientInner;',
      'void postAmbientInner;',
      'const postAmbientDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps top-level ambient module declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'const preAmbientInner = moduleAlias.inner;',
      'declare module moduleAlias {',
      '  const marker: unknown;',
      '}',
      'const postAmbientInner = moduleAlias.inner;',
      'void preAmbientInner;',
      'void postAmbientInner;',
      'const postAmbientDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps top-level type-alias declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'const preTypeAliasInner = moduleAlias.inner;',
      'type moduleAlias = { inner: unknown };',
      'const postTypeAliasInner = moduleAlias.inner;',
      'void preTypeAliasInner;',
      'void postTypeAliasInner;',
      'const postTypeAliasDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('keeps top-level interface declarations from shadowing module-source aliases in symbol sources', () => {
    const source = [
      "let moduleAlias: any = require('./fixtures/guard-module.js');",
      'const preInterfaceInner = moduleAlias.inner;',
      'interface moduleAlias {',
      '  marker: unknown;',
      '}',
      'const postInterfaceInner = moduleAlias.inner;',
      'void preInterfaceInner;',
      'void postInterfaceInner;',
      'const postInterfaceDefault = moduleAlias.default;',
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.include('inner@./fixtures/guard-module.js');
  });

  it('does not treat block-scoped function shadowing of require alias as module-sourced', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      "  const innerDefault = reqAlias('./fixtures/other-module.js').default;",
      '}',
      "const outerDefault = reqAlias('./fixtures/guard-module.js').default;",
    ].join('\n');
    const references = collectSymbolSourceReferences(source, 'fixture.ts').map(
      (reference) => `${reference.symbol}@${reference.source}`,
    );
    expect(references).to.include('default@./fixtures/guard-module.js');
    expect(references).to.not.include('default@./fixtures/other-module.js');
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

  it('does not leak require aliases across function parameter shadows', () => {
    const source = [
      'const reqAlias = require;',
      'function run(reqAlias: any) {',
      "  return reqAlias('./fixtures/other-module.js');",
      '}',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps function-scope type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js');",
      '  type reqAlias = (_value: unknown) => unknown;',
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps function-scope interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js');",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps function-scope ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare class reqAlias {}',
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps function-scope ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps function-scope ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare function reqAlias(_path: string): unknown;',
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps function-scope ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps function-scope ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps function-scope ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps function-scope ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps function-scope ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
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

  it('does not leak function-scope enum alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js');",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak function-scope enum alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak function-scope class alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      "  reqAlias('./fixtures/other-module.js');",
      '  class reqAlias {}',
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak function-scope class alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'function run() {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      'run();',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps module specifier detection when require is ambient-declared as variable', () => {
    const source = [
      'declare const require: unknown;',
      "const ambientDeclaredCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('keeps module specifier detection when require is ambient-declared as function', () => {
    const source = [
      'declare function require(path: string): unknown;',
      "const ambientDeclaredCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('keeps module specifier detection when require is ambient-declared as class', () => {
    const source = [
      'declare class require {}',
      "const ambientDeclaredCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('keeps module specifier detection when require is ambient-declared as enum', () => {
    const source = [
      'declare enum require {',
      '  Marker = 0,',
      '}',
      "const ambientDeclaredCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('keeps module specifier detection when require is ambient-declared as namespace', () => {
    const source = [
      'declare namespace require {',
      '  const marker: unknown;',
      '}',
      "const ambientDeclaredCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('keeps module specifier detection when require is ambient-declared as module', () => {
    const source = [
      'declare module require {',
      '  const marker: unknown;',
      '}',
      "const ambientDeclaredCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('keeps module specifier detection when require is ambient-declared as let', () => {
    const source = [
      'declare let require: (path: string) => unknown;',
      "const ambientDeclaredCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('keeps module specifier detection when require is ambient-declared as var', () => {
    const source = [
      'declare var require: (path: string) => unknown;',
      "const ambientDeclaredCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('keeps module specifier detection when require has a type-alias declaration', () => {
    const source = [
      'type require = (path: string) => unknown;',
      "const ambientDeclaredCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('keeps module specifier detection when require has an interface declaration', () => {
    const source = [
      'interface require {',
      '  (path: string): unknown;',
      '}',
      "const ambientDeclaredCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('does not treat shadowed require parameter calls as module specifiers', () => {
    const source = [
      "const outerRequire = require('./fixtures/guard-module.js');",
      'function run(require: any) {',
      "  return require('./fixtures/other-module.js');",
      '}',
      'void outerRequire;',
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps try-block ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare class reqAlias {}',
      '} catch {}',
      "const postTryCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps try-block ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '} catch {}',
      "const postTryCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps try-block ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare function reqAlias(path: string): unknown;',
      '} catch {}',
      "const postTryCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps try-block ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '} catch {}',
      "const postTryCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps try-block ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '} catch {}',
      "const postTryCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps try-block type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js');",
      '  type reqAlias = (_path: string) => unknown;',
      '} catch {}',
      "const postTryCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps try-block interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js');",
      '  interface reqAlias {',
      '    (_path: string): unknown;',
      '  }',
      '} catch {}',
      "const postTryCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps finally-block ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare class reqAlias {}',
      '}',
      "const postFinallyCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps finally-block ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postFinallyCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps finally-block ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare function reqAlias(path: string): unknown;',
      '}',
      "const postFinallyCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps finally-block ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postFinallyCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps finally-block ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postFinallyCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps finally-block type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js');",
      '  type reqAlias = (_path: string) => unknown;',
      '}',
      "const postFinallyCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps finally-block interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js');",
      '  interface reqAlias {',
      '    (_path: string): unknown;',
      '  }',
      '}',
      "const postFinallyCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps try-block ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare const reqAlias: (_path: string) => unknown;',
      '} catch {}',
      "const postTryCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps try-block ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare let reqAlias: (_path: string) => unknown;',
      '} catch {}',
      "const postTryCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps try-block ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare var reqAlias: (_path: string) => unknown;',
      '} catch {}',
      "const postTryCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps finally-block ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      "const postFinallyCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps finally-block ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      "const postFinallyCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps finally-block ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {} finally {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      "const postFinallyCall = reqAlias('./fixtures/guard-module.js');",
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

  it('does not leak require shadowing across catch clause scopes', () => {
    const source = [
      'try {',
      "  throw new Error('boom');",
      '} catch (require) {',
      "  require('./fixtures/other-module.js');",
      '}',
      "const postCatchCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak catch-block lexical alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  const reqAlias = () => undefined;',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak catch-block lexical alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  const reqAlias = () => undefined;',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps catch-block type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  type reqAlias = (_value: unknown) => unknown;',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps catch-block interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps catch-block ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare class reqAlias {}',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps catch-block ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps catch-block ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare function reqAlias(_path: string): unknown;',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps catch-block ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps catch-block ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps catch-block ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare const reqAlias: (_path: string) => unknown;',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps catch-block ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare let reqAlias: (_path: string) => unknown;',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps catch-block ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare var reqAlias: (_path: string) => unknown;',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
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

  it('does not leak hoisted catch-block function alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak catch-block class alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak catch-block class alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  class reqAlias {}',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak catch-block enum alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  void error;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak catch-block enum alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak catch binding-pattern require shadowing to outer module specifiers', () => {
    const source = [
      "const outerRequire = require('./fixtures/guard-module.js');",
      'try {',
      '  throw { require: () => undefined };',
      '} catch ({ require }) {',
      "  require('./fixtures/other-module.js');",
      '}',
      'void outerRequire;',
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak catch binding-pattern alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      '  throw { reqAlias: () => undefined };',
      '} catch ({ reqAlias }) {',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak nested catch binding-pattern require shadowing to outer module specifiers', () => {
    const source = [
      "const outerRequire = require('./fixtures/guard-module.js');",
      'try {',
      '  throw { nested: { require: () => undefined } };',
      '} catch ({ nested: { require } }) {',
      "  require('./fixtures/other-module.js');",
      '}',
      'void outerRequire;',
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak nested catch binding-pattern alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'try {',
      '  throw { nested: { reqAlias: () => undefined } };',
      '} catch ({ nested: { reqAlias } }) {',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps require alias var declarations made inside catch block scopes', () => {
    const source = [
      'let reqAlias: any;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  var reqAlias = require;',
      '}',
      "const postCatchCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('clears require alias var declarations to non-require values inside catch block scopes', () => {
    const source = [
      'let reqAlias: any = require;',
      'try {',
      "  throw new Error('boom');",
      '} catch (error) {',
      '  var reqAlias = () => undefined;',
      '}',
      "reqAlias('./fixtures/other-module.js');",
      "const directCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak require shadowing across lexical for-loop scopes', () => {
    const source = [
      'const reqAlias = require;',
      'for (const reqAlias of [() => undefined]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps lexical for-loop type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  type reqAlias = (_value: unknown) => unknown;',
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps lexical for-loop interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps lexical for-loop ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare class reqAlias {}',
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps lexical for-loop ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps lexical for-loop ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare function reqAlias(_path: string): unknown;',
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps lexical for-loop ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps lexical for-loop ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps lexical for-loop ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare const reqAlias: (_path: string) => unknown;',
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps lexical for-loop ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare let reqAlias: (_path: string) => unknown;',
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps lexical for-loop ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare var reqAlias: (_path: string) => unknown;',
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps while-block type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  type reqAlias = (_path: string) => unknown;',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps while-block interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps while-block ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare class reqAlias {}',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps while-block ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps while-block ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare function reqAlias(_path: string): unknown;',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps while-block ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps while-block ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps while-block ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare const reqAlias: (_path: string) => unknown;',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps while-block ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare let reqAlias: (_path: string) => unknown;',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps while-block ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare var reqAlias: (_path: string) => unknown;',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps do-while type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  type reqAlias = (_path: string) => unknown;',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps do-while interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps do-while ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare class reqAlias {}',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps do-while ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps do-while ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare function reqAlias(_path: string): unknown;',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps do-while ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps do-while ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps do-while ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare const reqAlias: (_path: string) => unknown;',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps do-while ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare let reqAlias: (_path: string) => unknown;',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps do-while ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare var reqAlias: (_path: string) => unknown;',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
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

  it('does not leak direct require shadowing across while scopes', () => {
    const source = [
      'while (true) {',
      '  const require = () => undefined;',
      "  require('./fixtures/other-module.js');",
      '  break;',
      '}',
      "const postWhileCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak direct require shadowing across do-while scopes', () => {
    const source = [
      'do {',
      '  const require = () => undefined;',
      "  require('./fixtures/other-module.js');",
      '} while (false);',
      "const postDoWhileCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak while-block lexical alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  const reqAlias = () => undefined;',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak do-while lexical alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  const reqAlias = () => undefined;',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak direct require shadowing across if-branch scopes', () => {
    const source = [
      'if (true) {',
      '  const require = () => undefined;',
      "  require('./fixtures/other-module.js');",
      '}',
      "const postIfCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak direct require shadowing across else-branch scopes', () => {
    const source = [
      'if (false) {',
      '  void 0;',
      '} else {',
      '  const require = () => undefined;',
      "  require('./fixtures/other-module.js');",
      '}',
      "const postElseCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak if-branch lexical alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  const reqAlias = () => undefined;',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak else-branch lexical alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  const reqAlias = () => undefined;',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps if-branch type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  type reqAlias = (_path: string) => unknown;',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps else-branch type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  type reqAlias = (_path: string) => unknown;',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps if-branch interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps else-branch interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps if-branch ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare class reqAlias {}',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps else-branch ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare class reqAlias {}',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps if-branch ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps else-branch ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps if-branch ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare function reqAlias(_path: string): unknown;',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps else-branch ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare function reqAlias(_path: string): unknown;',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps if-branch ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps else-branch ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps if-branch ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps else-branch ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps if-branch ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps else-branch ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps if-branch ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps else-branch ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps if-branch ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps else-branch ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps if-branch var alias declarations made inside block scopes', () => {
    const source = [
      'if (true) {',
      '  var reqAlias = require;',
      "  reqAlias('./fixtures/guard-module.js');",
      '}',
      "const postIfCall = reqAlias('./fixtures/other-module.js');",
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

  it('keeps else-branch var alias declarations made inside block scopes', () => {
    const source = [
      'if (false) {',
      '  void 0;',
      '} else {',
      '  var reqAlias = require;',
      "  reqAlias('./fixtures/guard-module.js');",
      '}',
      "const postElseCall = reqAlias('./fixtures/other-module.js');",
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

  it('clears if-branch var alias declarations to non-require values inside block scopes', () => {
    const source = [
      'if (true) {',
      '  var reqAlias = require;',
      "  reqAlias('./fixtures/guard-module.js');",
      '  reqAlias = () => undefined;',
      '}',
      "const postIfCall = reqAlias('./fixtures/other-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('clears else-branch var alias declarations to non-require values inside block scopes', () => {
    const source = [
      'if (false) {',
      '  void 0;',
      '} else {',
      '  var reqAlias = require;',
      "  reqAlias('./fixtures/guard-module.js');",
      '  reqAlias = () => undefined;',
      '}',
      "const postElseCall = reqAlias('./fixtures/other-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('applies if-branch assignments to outer require aliases for module specifiers', () => {
    const source = [
      'let reqAlias: any = require;',
      'if (true) {',
      '  reqAlias = () => undefined;',
      '}',
      "reqAlias('./fixtures/other-module.js');",
      "const directCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('applies else-branch assignments to outer require aliases for module specifiers', () => {
    const source = [
      'let reqAlias: any = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      '  reqAlias = () => undefined;',
      '}',
      "reqAlias('./fixtures/other-module.js');",
      "const directCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('applies if-branch destructuring assignments to outer require aliases for module specifiers', () => {
    const source = [
      'let reqAlias: any = require;',
      'if (true) {',
      '  ({ reqAlias } = { reqAlias: () => undefined });',
      '}',
      "reqAlias('./fixtures/other-module.js');",
      "const directCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('applies else-branch destructuring assignments to outer require aliases for module specifiers', () => {
    const source = [
      'let reqAlias: any = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      '  ({ reqAlias } = { reqAlias: () => undefined });',
      '}',
      "reqAlias('./fixtures/other-module.js');",
      "const directCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('applies if-branch require assignments to outer aliases for module specifiers', () => {
    const source = [
      'let reqAlias: any;',
      'if (true) {',
      '  reqAlias = require;',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('applies else-branch require assignments to outer aliases for module specifiers', () => {
    const source = [
      'let reqAlias: any;',
      'if (false) {',
      '  void 0;',
      '} else {',
      '  reqAlias = require;',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('does not leak hoisted if-branch function alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak hoisted else-branch function alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak if-branch class alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  class reqAlias {}',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak else-branch class alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  class reqAlias {}',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak if-branch enum alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak else-branch enum alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      "  reqAlias('./fixtures/other-module.js');",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak if-branch class alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak else-branch class alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak if-branch function alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak else-branch function alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak if-branch enum alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (true) {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postIfCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak else-branch enum alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'if (false) {',
      '  void 0;',
      '} else {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postElseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak hoisted while-block function alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak hoisted do-while function alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak while-block class alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  class reqAlias {}',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak do-while class alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  class reqAlias {}',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak while-block class alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js');",
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak do-while class alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js');",
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak while-block function alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak do-while function alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak while-block enum alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak do-while enum alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      "  reqAlias('./fixtures/other-module.js');",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak while-block enum alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'while (true) {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '  break;',
      '}',
      "const postWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak do-while enum alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'do {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '} while (false);',
      "const postDoWhileCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak lexical for-loop enum alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak lexical for-loop enum alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak lexical for-loop class alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '  class reqAlias {}',
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak lexical for-loop class alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'for (const iteration of [1]) {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js');",
      '  void iteration;',
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak direct require shadowing across lexical for-of scopes', () => {
    const source = [
      'for (const require of [() => undefined]) {',
      "  require('./fixtures/other-module.js');",
      '}',
      "const postLoopCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak direct require shadowing across lexical for-in scopes', () => {
    const source = [
      'for (const require in { item: 1 }) {',
      "  require('./fixtures/other-module.js');",
      '}',
      "const postLoopCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak direct require shadowing across lexical for scopes', () => {
    const source = [
      'for (let require = () => undefined; ; ) {',
      "  require('./fixtures/other-module.js');",
      '  break;',
      '}',
      "const postLoopCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not treat binding-pattern shadowed require aliases as module specifier sources', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      '  const { reqAlias } = { reqAlias: () => undefined };',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not treat loop binding-pattern shadowed require aliases as module specifier sources', () => {
    const source = [
      'const reqAlias = require;',
      'for (const { reqAlias } of [{ reqAlias: () => undefined }]) {',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postLoopCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not treat assignment-pattern shadowed require aliases as module specifier sources', () => {
    const source = [
      'let reqAlias = require;',
      '({ reqAlias } = { reqAlias: () => undefined });',
      "reqAlias('./fixtures/other-module.js');",
      "const directCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps require alias assignments made inside block scopes', () => {
    const source = [
      'let reqAlias: any;',
      '{',
      '  reqAlias = require;',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('does not leak block lexical alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  const reqAlias = () => undefined;',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps block type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  type reqAlias = (_value: unknown) => unknown;',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps block interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps block ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare class reqAlias {}',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps block ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps block ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare function reqAlias(_path: string): unknown;',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps block ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps block ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps block ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps block ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps block ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
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

  it('does not leak hoisted block function alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak block class alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  class reqAlias {}',
      '  void reqAlias;',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak block class alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak block enum alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      "  reqAlias('./fixtures/other-module.js');",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '  void reqAlias;',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak block enum alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('clears require alias assignments to non-require values inside block scopes', () => {
    const source = [
      'let reqAlias: any = require;',
      '{',
      '  reqAlias = () => undefined;',
      '}',
      "reqAlias('./fixtures/other-module.js');",
      "const directCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps require alias var declarations made inside block scopes', () => {
    const source = [
      '{',
      '  var reqAlias = require;',
      '}',
      "const postBlockCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('keeps require alias assignments made inside switch case scopes', () => {
    const source = [
      'let reqAlias: any;',
      'switch (1) {',
      '  case 1:',
      '    reqAlias = require;',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('clears require alias assignments to non-require values inside switch case scopes', () => {
    const source = [
      'let reqAlias: any = require;',
      'switch (1) {',
      '  case 1:',
      '    reqAlias = () => undefined;',
      '    break;',
      '}',
      "reqAlias('./fixtures/other-module.js');",
      "const directCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak switch-case lexical alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1: {',
      '    const reqAlias = () => undefined;',
      "    reqAlias('./fixtures/other-module.js');",
      '    break;',
      '  }',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak switch-case lexical alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    const reqAlias = () => undefined;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps switch-case type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    type reqAlias = (_value: unknown) => unknown;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps switch-case interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    interface reqAlias {',
      '      value: string;',
      '    }',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps switch-case ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare class reqAlias {}',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps switch-case ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare enum reqAlias {',
      '      Marker = 0,',
      '    }',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps switch-case ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare function reqAlias(_path: string): unknown;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps switch-case ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare namespace reqAlias {',
      '      const marker: unknown;',
      '    }',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps switch-case ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare module reqAlias {',
      '      const marker: unknown;',
      '    }',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps switch-case ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare const reqAlias: (_path: string) => unknown;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps switch-case ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare let reqAlias: (_path: string) => unknown;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps switch-case ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare var reqAlias: (_path: string) => unknown;',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
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

  it('does not leak hoisted switch-case function alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    function reqAlias(_value: unknown) {',
      '      return _value;',
      '    }',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak switch-case class alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1: {',
      '    class reqAlias {}',
      "    reqAlias('./fixtures/other-module.js');",
      '    break;',
      '  }',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak switch-case class alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    class reqAlias {}',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak switch-case enum alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1:',
      "    reqAlias('./fixtures/other-module.js');",
      '    enum reqAlias {',
      '      Marker = 0,',
      '    }',
      '    break;',
      '  default:',
      '    break;',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak switch-case enum alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'switch (1) {',
      '  case 1: {',
      '    enum reqAlias {',
      '      Marker = 0,',
      '    }',
      "    reqAlias('./fixtures/other-module.js');",
      '    break;',
      '  }',
      '}',
      "const postCaseCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block lexical alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    const reqAlias = () => undefined;',
      "    reqAlias('./fixtures/other-module.js');",
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block function declaration alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    function reqAlias(_value: unknown) {',
      '      return _value;',
      '    }',
      "    reqAlias('./fixtures/other-module.js');",
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block class alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    class reqAlias {}',
      "    reqAlias('./fixtures/other-module.js');",
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak hoisted class static-block function alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    function reqAlias(_value: unknown) {',
      '      return _value;',
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block lexical alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    const reqAlias = () => undefined;',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block class alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    class reqAlias {}',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block enum alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    enum reqAlias {',
      '      Marker = 0,',
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block enum alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    enum reqAlias {',
      '      Marker = 0,',
      '    }',
      "    reqAlias('./fixtures/other-module.js');",
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps class static-block type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    type reqAlias = (_value: unknown) => unknown;',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps class static-block interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    interface reqAlias {',
      '      value: string;',
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps class static-block ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare class reqAlias {}',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps class static-block ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare enum reqAlias {',
      '      Marker = 0,',
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps class static-block ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare function reqAlias(_path: string): unknown;',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps class static-block ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare namespace reqAlias {',
      '      const marker: unknown;',
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps class static-block ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare module reqAlias {',
      '      const marker: unknown;',
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps class static-block ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare const reqAlias: (_path: string) => unknown;',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps class static-block ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare let reqAlias: (_path: string) => unknown;',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps class static-block ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      "    reqAlias('./fixtures/other-module.js');",
      '    declare var reqAlias: (_path: string) => unknown;',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
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

  it('does not leak class static-block var alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    var reqAlias = () => undefined;',
      "    reqAlias('./fixtures/other-module.js');",
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak nested class static-block var alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    if (true) {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js');",
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block for-of var alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    for (var reqAlias of [() => undefined]) {',
      "      reqAlias('./fixtures/other-module.js');",
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block for-in var alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    const aliases: Record<string, (value: unknown) => unknown> = { first: () => undefined };',
      '    for (var aliasKey in aliases) {',
      '      var reqAlias = aliases[aliasKey];',
      "      reqAlias('./fixtures/other-module.js');",
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block switch-case var alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    switch (1) {',
      '      case 1:',
      '        var reqAlias = () => undefined;',
      "        reqAlias('./fixtures/other-module.js');",
      '        break;',
      '      default:',
      '        break;',
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block for var alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    for (var i = 0; i < 1; i += 1) {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js');",
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block do-while var alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    do {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js');",
      '      break;',
      '    } while (false);',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block while var alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    while (true) {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js');",
      '      break;',
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block try-block var alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    try {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js');",
      '    } catch (error) {',
      '      void error;',
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block catch-block var alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    try {',
      "      throw new Error('boom');",
      '    } catch (error) {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js');",
      '      void error;',
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak class static-block finally-block var alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'class ShadowContainer {',
      '  static {',
      '    try {',
      '      void 0;',
      '    } finally {',
      '      var reqAlias = () => undefined;',
      "      reqAlias('./fixtures/other-module.js');",
      '    }',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('applies class static-block assignments to outer require aliases for module specifiers', () => {
    const source = [
      'let reqAlias: any = require;',
      'class ShadowContainer {',
      '  static {',
      '    reqAlias = () => undefined;',
      '  }',
      '}',
      "reqAlias('./fixtures/other-module.js');",
      "const directCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('applies class static-block destructuring assignments to outer require aliases for module specifiers', () => {
    const source = [
      'let reqAlias: any = require;',
      'class ShadowContainer {',
      '  static {',
      '    ({ reqAlias } = { reqAlias: () => undefined });',
      '  }',
      '}',
      "reqAlias('./fixtures/other-module.js');",
      "const directCall = require('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('applies class static-block require assignments to outer aliases for module specifiers', () => {
    const source = [
      'let reqAlias: any;',
      'class ShadowContainer {',
      '  static {',
      '    reqAlias = require;',
      '  }',
      '}',
      "const postStaticCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('does not leak namespace lexical alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      '  const reqAlias = () => undefined;',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak namespace lexical alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  const reqAlias = () => undefined;',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps namespace type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  type reqAlias = (_value: unknown) => unknown;',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps namespace interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps namespace ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare class reqAlias {}',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps namespace ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps namespace ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare function reqAlias(_path: string): unknown;',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps namespace ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps namespace ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps namespace ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps namespace ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps namespace ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
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

  it('does not leak hoisted namespace function alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak namespace class alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  class reqAlias {}',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak namespace class alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak namespace enum alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      "  reqAlias('./fixtures/other-module.js');",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak namespace enum alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'namespace ShadowSpace {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postNamespaceCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak labeled lexical alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      '  const reqAlias = () => undefined;',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak labeled lexical alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  const reqAlias = () => undefined;',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps labeled type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  type reqAlias = (_value: unknown) => unknown;',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps labeled interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  interface reqAlias {',
      '    value: string;',
      '  }',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps labeled ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare class reqAlias {}',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps labeled ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps labeled ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare function reqAlias(_path: string): unknown;',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps labeled ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare namespace reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps labeled ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare module reqAlias {',
      '    const marker: unknown;',
      '  }',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps labeled ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare const reqAlias: (_path: string) => unknown;',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps labeled ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare let reqAlias: (_path: string) => unknown;',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
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

  it('keeps labeled ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  declare var reqAlias: (_path: string) => unknown;',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
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

  it('does not leak hoisted labeled function alias shadowing to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak labeled class alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  class reqAlias {}',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak labeled class alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      '  class reqAlias {}',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak labeled enum alias shadowing before declaration to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      "  reqAlias('./fixtures/other-module.js');",
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not leak labeled enum alias declarations to outer module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      'label: {',
      '  enum reqAlias {',
      '    Marker = 0,',
      '  }',
      "  reqAlias('./fixtures/other-module.js');",
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps labeled var alias declarations made inside block scopes', () => {
    const source = [
      'let reqAlias: any;',
      'label: {',
      '  var reqAlias = require;',
      '}',
      "const postLabelCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
  });

  it('does not treat top-level function declaration named require as module specifier source', () => {
    const source = [
      "const preShadowCall = require('./fixtures/guard-module.js');",
      'function require(_value: unknown) {',
      '  return _value;',
      '}',
      "const postShadowCall = require('./fixtures/other-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not treat top-level class declaration named require alias as module specifier source', () => {
    const source = [
      'const reqAlias = require;',
      "const preShadowCall = reqAlias('./fixtures/guard-module.js');",
      'class reqAlias {}',
      "const postShadowCall = reqAlias('./fixtures/other-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('does not treat top-level enum declaration named require alias as module specifier source', () => {
    const source = [
      'const reqAlias = require;',
      "const preShadowCall = reqAlias('./fixtures/guard-module.js');",
      'enum reqAlias { Primary = 1 }',
      "const postShadowCall = reqAlias('./fixtures/other-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
    );
  });

  it('keeps top-level ambient class declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientCall = reqAlias('./fixtures/guard-module.js');",
      'declare class reqAlias {}',
      "const postAmbientCall = reqAlias('./fixtures/other-module.js');",
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

  it('keeps top-level ambient enum declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientCall = reqAlias('./fixtures/guard-module.js');",
      'declare enum reqAlias {',
      '  Primary = 1,',
      '}',
      "const postAmbientCall = reqAlias('./fixtures/other-module.js');",
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

  it('keeps top-level ambient function declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientCall = reqAlias('./fixtures/guard-module.js');",
      'declare function reqAlias(_value: unknown): unknown;',
      "const postAmbientCall = reqAlias('./fixtures/other-module.js');",
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

  it('keeps top-level ambient const declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientCall = reqAlias('./fixtures/guard-module.js');",
      'declare const reqAlias: (_value: unknown) => unknown;',
      "const postAmbientCall = reqAlias('./fixtures/other-module.js');",
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

  it('keeps top-level ambient var declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientCall = reqAlias('./fixtures/guard-module.js');",
      'declare var reqAlias: (_value: unknown) => unknown;',
      "const postAmbientCall = reqAlias('./fixtures/other-module.js');",
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

  it('keeps top-level ambient let declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientCall = reqAlias('./fixtures/guard-module.js');",
      'declare let reqAlias: (_value: unknown) => unknown;',
      "const postAmbientCall = reqAlias('./fixtures/other-module.js');",
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

  it('keeps top-level ambient namespace declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientCall = reqAlias('./fixtures/guard-module.js');",
      'declare namespace reqAlias {',
      '  const marker: unknown;',
      '}',
      "const postAmbientCall = reqAlias('./fixtures/other-module.js');",
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

  it('keeps top-level ambient module declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      "const preAmbientCall = reqAlias('./fixtures/guard-module.js');",
      'declare module reqAlias {',
      '  const marker: unknown;',
      '}',
      "const postAmbientCall = reqAlias('./fixtures/other-module.js');",
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

  it('keeps top-level type-alias declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      "const preTypeAliasCall = reqAlias('./fixtures/guard-module.js');",
      'type reqAlias = (_value: unknown) => unknown;',
      "const postTypeAliasCall = reqAlias('./fixtures/other-module.js');",
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

  it('keeps top-level interface declarations from shadowing runtime require aliases in module specifiers', () => {
    const source = [
      'const reqAlias = require;',
      "const preInterfaceCall = reqAlias('./fixtures/guard-module.js');",
      'interface reqAlias {',
      '  marker: unknown;',
      '}',
      "const postInterfaceCall = reqAlias('./fixtures/other-module.js');",
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

  it('does not treat block-scoped function shadowing of require alias as module specifier source', () => {
    const source = [
      'const reqAlias = require;',
      '{',
      '  function reqAlias(_value: unknown) {',
      '    return _value;',
      '  }',
      "  const innerCall = reqAlias('./fixtures/other-module.js');",
      '}',
      "const outerCall = reqAlias('./fixtures/guard-module.js');",
    ].join('\n');
    const moduleReferences = collectModuleSpecifierReferences(
      source,
      'fixture.ts',
    ).map((reference) => `${reference.source}@${reference.filePath}`);
    expect(moduleReferences).to.include(
      './fixtures/guard-module.js@fixture.ts',
    );
    expect(moduleReferences).to.not.include(
      './fixtures/other-module.js@fixture.ts',
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
