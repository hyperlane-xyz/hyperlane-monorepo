import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import {
  EXECUTABLE_SQUADS_SCRIPT_PATHS,
  hasAllowedSquadsScriptExtension,
  isExecutableSquadsScriptPath,
  isNormalizedGuardedScriptPath,
  isSquadsDirectoryScriptPath,
} from './squads-test-constants.js';
import { listExecutableSquadsDirectoryScripts } from './squads-test-utils.js';

const INFRA_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

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

  it('keeps help expectation lists non-empty and deduplicated', () => {
    for (const { scriptPath, expectedOutput } of SQUADS_SCRIPT_HELP_CASES) {
      const absoluteScriptPath = path.join(INFRA_ROOT, scriptPath);
      expect(scriptPath.includes('\\')).to.equal(false);
      expect(scriptPath.startsWith('scripts/')).to.equal(true);
      expect(isNormalizedGuardedScriptPath(scriptPath)).to.equal(true);
      expect(isExecutableSquadsScriptPath(scriptPath)).to.equal(true);
      expect(hasAllowedSquadsScriptExtension(scriptPath)).to.equal(true);
      expect(
        fs.existsSync(absoluteScriptPath),
        `Expected help-script path to exist: ${scriptPath}`,
      ).to.equal(true);
      expect(
        fs.statSync(absoluteScriptPath).isFile(),
        `Expected help-script path to be a file: ${scriptPath}`,
      ).to.equal(true);
      expect(
        expectedOutput.length,
        `Expected help expectation list to be non-empty: ${scriptPath}`,
      ).to.be.greaterThan(0);

      expect(
        new Set(expectedOutput).size,
        `Expected help expectation list to be deduplicated: ${scriptPath}`,
      ).to.equal(expectedOutput.length);

      expect(
        expectedOutput.includes('--help'),
        `Expected help expectation list to include --help: ${scriptPath}`,
      ).to.equal(true);
      expect(
        expectedOutput.includes('--version'),
        `Expected help expectation list to include --version: ${scriptPath}`,
      ).to.equal(true);

      for (const expectedText of expectedOutput) {
        expect(expectedText).to.equal(expectedText.trim());
        expect(expectedText.startsWith('--')).to.equal(true);
      }
    }
  });

  it('keeps help smoke cases synchronized with squads scripts directory', () => {
    const configuredScriptPaths = SQUADS_SCRIPT_HELP_CASES.map(
      ({ scriptPath }) => scriptPath,
    );
    expect(new Set(configuredScriptPaths).size).to.equal(
      configuredScriptPaths.length,
    );

    const configuredSquadsScripts = configuredScriptPaths
      .filter((scriptPath) => isSquadsDirectoryScriptPath(scriptPath))
      .sort();
    expect(configuredSquadsScripts).to.deep.equal(
      listExecutableSquadsDirectoryScripts(INFRA_ROOT),
    );

    const executableScriptPathsFromConstants = [
      ...EXECUTABLE_SQUADS_SCRIPT_PATHS,
    ].sort();
    expect(configuredScriptPaths.sort()).to.deep.equal(
      executableScriptPathsFromConstants,
    );
  });

  it('keeps help smoke case ordering aligned with executable script constants', () => {
    const configuredScriptPaths = SQUADS_SCRIPT_HELP_CASES.map(
      ({ scriptPath }) => scriptPath,
    );
    expect(configuredScriptPaths).to.deep.equal([
      ...EXECUTABLE_SQUADS_SCRIPT_PATHS,
    ]);
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
