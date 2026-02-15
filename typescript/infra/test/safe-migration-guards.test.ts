import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { expect } from 'chai';

type InfraPackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const SAFE_HELPER_SYMBOLS = [
  'asHex',
  'canProposeSafeTransactions',
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
  'getPendingTxsForChains',
  'getSafe',
  'getSafeAndService',
  'getSafeDelegates',
  'getSafeService',
  'getSafeTx',
  'hasSafeServiceTransactionPayload',
  'isLegacySafeApi',
  'normalizeSafeServiceUrl',
  'getSafeTxServiceUrl',
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
] as const;

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
  it('keeps legacy infra safe utility module deleted', () => {
    const legacySafeUtilPath = path.join(process.cwd(), 'src/utils/safe.ts');
    expect(fs.existsSync(legacySafeUtilPath)).to.equal(false);
  });

  it('prevents reintroducing infra local safe util imports', () => {
    expectNoRipgrepMatches(
      String.raw`src/utils/safe\.ts|src/utils/safe|from ['"].*utils/safe`,
      'legacy infra safe util import path usage',
    );
  });

  it('ensures migrated safe helper symbols are only imported from sdk', () => {
    const rootsToScan = ['scripts', 'src', 'config'];
    const disallowedImports: string[] = [];

    const walk = (currentPath: string) => {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;

        const contents = fs.readFileSync(entryPath, 'utf8');
        const importMatches = contents.matchAll(
          /import\s*{([^}]*)}\s*from\s*['"]([^'"]+)['"]/g,
        );

        for (const [, imported, source] of importMatches) {
          const importedSymbols = imported
            .split(',')
            .map((s) => s.trim().replace(/\s+as\s+\w+$/, ''));

          for (const safeSymbol of SAFE_HELPER_SYMBOLS) {
            if (
              importedSymbols.includes(safeSymbol) &&
              source !== '@hyperlane-xyz/sdk'
            ) {
              disallowedImports.push(
                `${path.relative(process.cwd(), entryPath)} -> ${safeSymbol} from ${source}`,
              );
            }
          }
        }
      }
    };

    for (const root of rootsToScan) {
      walk(path.join(process.cwd(), root));
    }

    expect(disallowedImports).to.deep.equal([]);
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
