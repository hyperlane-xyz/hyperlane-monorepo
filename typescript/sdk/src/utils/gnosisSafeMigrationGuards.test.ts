import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { expect } from 'chai';

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
      String.raw`from ['"].*typescript/infra|from ['"].*\/infra\/|from ['"]\.\.\/\.\.\/infra`,
      'sdk imports that reference infra paths',
    );
  });

  it('keeps gnosis safe helpers exported from sdk index', () => {
    const indexPath = path.resolve(process.cwd(), 'src/index.ts');
    const indexText = fs.readFileSync(indexPath, 'utf8');

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
        indexText.includes(exportedSymbol),
        `Expected sdk index to export ${exportedSymbol}`,
      ).to.equal(true);
    }
  });
});
