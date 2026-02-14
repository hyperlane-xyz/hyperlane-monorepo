import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

const INFRA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type HelpCase = {
  readonly scriptPath: string;
  readonly expectedOutput: readonly string[];
};

const SQUADS_SCRIPT_HELP_CASES: readonly HelpCase[] = Object.freeze([
  {
    scriptPath: 'scripts/squads/get-pending-txs.ts',
    expectedOutput: ['--help', '--version', '--chains'],
  },
  {
    scriptPath: 'scripts/squads/parse-txs.ts',
    expectedOutput: ['--help', '--version', '--chains'],
  },
  {
    scriptPath: 'scripts/squads/read-proposal.ts',
    expectedOutput: [
      '--help',
      '--version',
      '--chain',
      '--transactionIndex',
      '--verbose',
    ],
  },
  {
    scriptPath: 'scripts/squads/cancel-proposal.ts',
    expectedOutput: ['--help', '--version', '--chain', '--transactionIndex'],
  },
  {
    scriptPath: 'scripts/sealevel-helpers/update-multisig-ism-config.ts',
    expectedOutput: [
      '--help',
      '--version',
      '--chains',
      '--environment',
      '--context',
    ],
  },
]);

function runScriptHelp(scriptPath: string) {
  return spawnSync('pnpm', ['exec', 'tsx', scriptPath, '--help'], {
    cwd: INFRA_ROOT,
    encoding: 'utf8',
  });
}

describe('squads scripts --help smoke', function () {
  this.timeout(30_000);

  for (const { scriptPath, expectedOutput } of SQUADS_SCRIPT_HELP_CASES) {
    it(`prints help for ${scriptPath}`, () => {
      const result = runScriptHelp(scriptPath);
      if (result.error) {
        throw result.error;
      }

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(
        result.status,
        `Expected "${scriptPath} --help" to exit 0.\nOutput:\n${combinedOutput}`,
      ).to.equal(0);

      for (const expectedText of expectedOutput) {
        expect(
          combinedOutput,
          `Expected help output for "${scriptPath}" to include "${expectedText}".\nOutput:\n${combinedOutput}`,
        ).to.include(expectedText);
      }
    });
  }
});
