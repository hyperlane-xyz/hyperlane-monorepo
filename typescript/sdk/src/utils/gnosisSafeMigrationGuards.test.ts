import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { expect } from 'chai';

function extractNamedExportSymbols(
  sourceText: string,
  modulePath: string,
): string[] {
  const fromNeedles = [`from '${modulePath}';`, `from "${modulePath}";`];
  const fromIndex = fromNeedles
    .map((needle) => sourceText.indexOf(needle))
    .find((index) => index >= 0);
  if (fromIndex === undefined) return [];

  const exportStartIndex = sourceText.lastIndexOf('export {', fromIndex);
  if (exportStartIndex < 0) return [];

  const exportedBlock = sourceText.slice(
    exportStartIndex + 'export {'.length,
    fromIndex,
  );
  return exportedBlock
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\s+as\s+\w+$/, ''));
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
    const output = execFileSync('rg', [pattern, 'src', '--glob', '*.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
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
});
