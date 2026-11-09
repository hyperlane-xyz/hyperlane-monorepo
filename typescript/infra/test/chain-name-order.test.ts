import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';
import ts from 'typescript';

const environmentsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../config/environments',
);

function parse(relativePath: string): ts.SourceFile {
  const filePath = join(environmentsDir, relativePath);
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function variableInitializer(
  source: ts.SourceFile,
  name: string,
): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) {
    throw new Error(`missing variable ${name} in ${source.fileName}`);
  }
  return found;
}

function unwrapAssertion(expression: ts.Expression): ts.Expression {
  return ts.isAsExpression(expression) ? expression.expression : expression;
}

function stringArray(expression: ts.Expression): string[] {
  const array = unwrapAssertion(expression);
  if (!ts.isArrayLiteralExpression(array)) {
    throw new Error('expected a string array literal');
  }
  return array.elements.map((element) => {
    if (!ts.isStringLiteral(element)) {
      throw new Error('expected chain names to be string literals');
    }
    return element.text;
  });
}

function objectKeys(expression: ts.Expression): string[] {
  if (!ts.isObjectLiteralExpression(expression)) {
    throw new Error('expected an object literal');
  }
  return expression.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
      throw new Error('expected chain map entries to be identifier keys');
    }
    return property.name.text;
  });
}

function assertSpreadOf(
  source: ts.SourceFile,
  name: string,
  sourceName: string,
) {
  const array = unwrapAssertion(variableInitializer(source, name));
  const element = ts.isArrayLiteralExpression(array)
    ? array.elements[0]
    : undefined;
  if (
    !ts.isArrayLiteralExpression(array) ||
    array.elements.length !== 1 ||
    !element ||
    !ts.isSpreadElement(element) ||
    !ts.isIdentifier(element.expression) ||
    element.expression.text !== sourceName
  ) {
    throw new Error(`${name} should spread ${sourceName}`);
  }
}

function validatorChainKeys(source: ts.SourceFile): string[] {
  const declaration = unwrapAssertion(
    variableInitializer(source, 'validatorChainConfig'),
  );
  if (!ts.isArrowFunction(declaration) || !declaration.body) {
    throw new Error('validatorChainConfig should be an arrow function');
  }

  let keys: string[] | undefined;
  const visit = (node: ts.Node) => {
    if (keys) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'configs' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      keys = objectKeys(node.initializer);
      return;
    }
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isObjectLiteralExpression(node.expression)
    ) {
      keys = objectKeys(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  if (!keys) {
    throw new Error('validatorChainConfig is missing its chain map');
  }
  return keys;
}

function alphabetical(names: readonly string[]): string[] {
  return [...names].sort();
}

describe('alphabetical chain name ordering', () => {
  it('reads chain map keys in source order', () => {
    const source = ts.createSourceFile(
      'sample.ts',
      'export const chainMetadataOverrides = { kyve: {}, bsc: {} };',
      ts.ScriptTarget.Latest,
      true,
    );
    const keys = objectKeys(
      variableInitializer(source, 'chainMetadataOverrides'),
    );
    expect(keys).to.deep.equal(['kyve', 'bsc']);
    expect(keys).to.not.deep.equal(alphabetical(keys));
  });

  for (const environment of [
    {
      name: 'mainnet3',
      chainNames: 'mainnet3SupportedChainNames',
    },
    {
      name: 'testnet4',
      chainNames: 'testnet4SupportedChainNames',
    },
  ]) {
    const sourceFiles = {
      chains: parse(`${environment.name}/supportedChainNames.ts`),
      metadata: parse(`${environment.name}/chains.ts`),
      validators: parse(`${environment.name}/validators.ts`),
    };

    it(`keeps ${environment.name} supportedChainNames alphabetical`, () => {
      assertSpreadOf(
        sourceFiles.chains,
        'supportedChainNames',
        environment.chainNames,
      );
      const names = stringArray(
        variableInitializer(sourceFiles.chains, environment.chainNames),
      );
      expect(names, `${environment.name} supportedChainNames`).to.not.be.empty;
      expect(names, `${environment.name} supportedChainNames`).to.deep.equal(
        alphabetical(names),
      );
    });

    it(`keeps ${environment.name} chainMetadataOverrides alphabetical`, () => {
      const names = objectKeys(
        variableInitializer(sourceFiles.metadata, 'chainMetadataOverrides'),
      );
      expect(names, `${environment.name} chainMetadataOverrides`).to.not.be
        .empty;
      expect(names, `${environment.name} chainMetadataOverrides`).to.deep.equal(
        alphabetical(names),
      );
    });

    it(`keeps ${environment.name} validatorChainConfig alphabetical`, () => {
      const names = validatorChainKeys(sourceFiles.validators);
      expect(names, `${environment.name} validatorChainConfig`).to.not.be.empty;
      expect(names, `${environment.name} validatorChainConfig`).to.deep.equal(
        alphabetical(names),
      );
    });
  }
});
