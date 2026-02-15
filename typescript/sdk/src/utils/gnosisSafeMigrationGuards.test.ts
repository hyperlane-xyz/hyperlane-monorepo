import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { expect } from 'chai';

const SOURCE_FILE_GLOB = '*.{ts,tsx,js,jsx,mts,mtsx,cts,ctsx,mjs,cjs}' as const;

type SdkPackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function extractTopLevelDeclarationExports(sourceText: string): string[] {
  return [
    ...sourceText.matchAll(
      /^export\s+(?:async\s+)?(?:type\s+)?(?:const|function|enum|interface|class|type)\s+([A-Za-z0-9_]+)/gm,
    ),
  ].map(([, symbol]) => symbol);
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
  it('prevents sdk source imports from infra paths', () => {
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
    const gnosisSafeExports = extractNamedExportSymbols(
      indexText,
      './utils/gnosisSafe.js',
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

    const moduleExports = extractTopLevelDeclarationExports(gnosisSafeText);
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
