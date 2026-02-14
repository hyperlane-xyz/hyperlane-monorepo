import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import {
  NON_EXECUTABLE_SQUADS_SCRIPT_FILES,
  SQUADS_SCRIPT_PATHS,
} from './squads-test-constants.js';

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

function listSquadsScripts(): string[] {
  const squadsScriptsDir = path.join(INFRA_ROOT, 'scripts/squads');
  return fs
    .readdirSync(squadsScriptsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !NON_EXECUTABLE_SQUADS_SCRIPT_FILES.includes(entry.name),
    )
    .map((entry) => path.join('scripts/squads', entry.name))
    .sort();
}

describe('squads scripts --help smoke', function () {
  this.timeout(30_000);

  it('keeps help smoke cases synchronized with squads scripts directory', () => {
    const configuredScriptPaths = SQUADS_SCRIPT_HELP_CASES.map(
      ({ scriptPath }) => scriptPath,
    );
    expect(new Set(configuredScriptPaths).size).to.equal(
      configuredScriptPaths.length,
    );

    const configuredSquadsScripts = configuredScriptPaths
      .filter((scriptPath) => scriptPath.startsWith('scripts/squads/'))
      .sort();
    expect(configuredSquadsScripts).to.deep.equal(listSquadsScripts());

    const executableScriptPathsFromConstants = SQUADS_SCRIPT_PATHS.filter(
      (scriptPath) =>
        !NON_EXECUTABLE_SQUADS_SCRIPT_FILES.some((fileName) =>
          scriptPath.endsWith(`/${fileName}`),
        ),
    ).sort();
    expect(configuredScriptPaths.sort()).to.deep.equal(
      executableScriptPathsFromConstants,
    );
  });

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
