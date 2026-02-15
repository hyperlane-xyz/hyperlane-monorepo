import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { expect } from 'chai';

type InfraPackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function expectNoRipgrepMatches(pattern: string, description: string): void {
  try {
    const output = execFileSync(
      'rg',
      [pattern, 'scripts', 'src', 'config', '--glob', '*.ts'],
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

describe('Safe migration guards', () => {
  it('prevents reintroducing infra local safe util imports', () => {
    expectNoRipgrepMatches(
      String.raw`src/utils/safe\.ts|src/utils/safe|from ['"].*utils/safe`,
      'legacy infra safe util import path usage',
    );
  });

  it('prevents direct @safe-global imports in infra source', () => {
    expectNoRipgrepMatches(
      String.raw`from ['"]@safe-global|require\(['"]@safe-global`,
      '@safe-global imports in infra sources',
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
    ];

    const safeGlobalDeps = allDependencyNames.filter((dep) =>
      dep.startsWith('@safe-global/'),
    );

    expect(safeGlobalDeps).to.deep.equal([]);
  });

  it('ensures sdk index continues exporting core safe helpers', () => {
    const sdkIndexPath = path.resolve(process.cwd(), '../sdk/src/index.ts');
    const sdkIndexText = fs.readFileSync(sdkIndexPath, 'utf8');

    const requiredExports = [
      'getSafeAndService',
      'getPendingTxsForChains',
      'createSafeDeploymentTransaction',
      'updateSafeOwner',
      'deleteSafeTx',
      'deleteAllPendingSafeTxs',
      'parseSafeTx',
      'decodeMultiSendData',
      'createSafeTransaction',
      'proposeSafeTransaction',
      'executeTx',
      'SafeTxStatus',
    ];

    for (const exportedSymbol of requiredExports) {
      expect(
        sdkIndexText.includes(exportedSymbol),
        `Expected sdk index to export ${exportedSymbol}`,
      ).to.equal(true);
    }
  });
});
