import { expect } from 'chai';

import {
  EXECUTABLE_SQUADS_SCRIPT_PATHS,
  NON_EXECUTABLE_SQUADS_SCRIPT_FILES,
  SQUADS_ERROR_FORMATTING_SCRIPT_PATHS,
  SQUADS_SCRIPT_PATHS,
} from './squads-test-constants.js';

describe('squads test constants', () => {
  it('keeps expected canonical squads script paths', () => {
    expect(SQUADS_SCRIPT_PATHS).to.deep.equal([
      'scripts/squads/cli-helpers.ts',
      'scripts/squads/get-pending-txs.ts',
      'scripts/squads/parse-txs.ts',
      'scripts/squads/read-proposal.ts',
      'scripts/squads/cancel-proposal.ts',
      'scripts/sealevel-helpers/update-multisig-ism-config.ts',
    ]);
  });

  it('keeps expected non-executable squads helper allowlist', () => {
    expect(NON_EXECUTABLE_SQUADS_SCRIPT_FILES).to.deep.equal([
      'cli-helpers.ts',
    ]);
  });

  it('keeps expected canonical executable squads script paths', () => {
    expect(EXECUTABLE_SQUADS_SCRIPT_PATHS).to.deep.equal([
      'scripts/squads/get-pending-txs.ts',
      'scripts/squads/parse-txs.ts',
      'scripts/squads/read-proposal.ts',
      'scripts/squads/cancel-proposal.ts',
      'scripts/sealevel-helpers/update-multisig-ism-config.ts',
    ]);
  });

  it('exports frozen constants', () => {
    expect(Object.isFrozen(NON_EXECUTABLE_SQUADS_SCRIPT_FILES)).to.equal(true);
    expect(Object.isFrozen(SQUADS_SCRIPT_PATHS)).to.equal(true);
    expect(Object.isFrozen(EXECUTABLE_SQUADS_SCRIPT_PATHS)).to.equal(true);
    expect(Object.isFrozen(SQUADS_ERROR_FORMATTING_SCRIPT_PATHS)).to.equal(
      true,
    );
  });

  it('keeps executable scripts as subset of all squads scripts', () => {
    const allScriptSet = new Set(SQUADS_SCRIPT_PATHS);
    for (const executableScriptPath of EXECUTABLE_SQUADS_SCRIPT_PATHS) {
      expect(allScriptSet.has(executableScriptPath)).to.equal(true);
    }
  });

  it('keeps formatting scripts equal to executable squads scripts', () => {
    expect(SQUADS_ERROR_FORMATTING_SCRIPT_PATHS).to.deep.equal(
      EXECUTABLE_SQUADS_SCRIPT_PATHS,
    );
  });

  it('keeps non-executable helper list represented in squads script paths', () => {
    for (const nonExecutableScriptFile of NON_EXECUTABLE_SQUADS_SCRIPT_FILES) {
      expect(
        SQUADS_SCRIPT_PATHS.some((scriptPath) =>
          scriptPath.endsWith(`/${nonExecutableScriptFile}`),
        ),
      ).to.equal(true);
    }
  });

  it('keeps constants free of duplicate script paths', () => {
    expect(new Set(SQUADS_SCRIPT_PATHS).size).to.equal(SQUADS_SCRIPT_PATHS.length);
    expect(new Set(EXECUTABLE_SQUADS_SCRIPT_PATHS).size).to.equal(
      EXECUTABLE_SQUADS_SCRIPT_PATHS.length,
    );
    expect(new Set(SQUADS_ERROR_FORMATTING_SCRIPT_PATHS).size).to.equal(
      SQUADS_ERROR_FORMATTING_SCRIPT_PATHS.length,
    );
  });

  it('keeps exactly one squads-adjacent non-squads script path', () => {
    const nonSquadsDirectoryScriptPaths = SQUADS_SCRIPT_PATHS.filter(
      (scriptPath) => !scriptPath.startsWith('scripts/squads/'),
    );
    expect(nonSquadsDirectoryScriptPaths).to.deep.equal([
      'scripts/sealevel-helpers/update-multisig-ism-config.ts',
    ]);
  });

  it('keeps executable constant derived from script allowlist partition', () => {
    const derivedExecutableScriptPaths = SQUADS_SCRIPT_PATHS.filter(
      (scriptPath) =>
        !NON_EXECUTABLE_SQUADS_SCRIPT_FILES.some((fileName) =>
          scriptPath.endsWith(`/${fileName}`),
        ),
    );
    expect(EXECUTABLE_SQUADS_SCRIPT_PATHS).to.deep.equal(
      derivedExecutableScriptPaths,
    );
  });

  it('keeps allowlisted non-executable squads script paths canonical', () => {
    const allowlistedScriptPaths = SQUADS_SCRIPT_PATHS.filter((scriptPath) =>
      NON_EXECUTABLE_SQUADS_SCRIPT_FILES.some((fileName) =>
        scriptPath.endsWith(`/${fileName}`),
      ),
    );
    expect(allowlistedScriptPaths).to.deep.equal([
      'scripts/squads/cli-helpers.ts',
    ]);
  });

  it('keeps non-executable allowlist deduplicated and squads-scoped', () => {
    expect(new Set(NON_EXECUTABLE_SQUADS_SCRIPT_FILES).size).to.equal(
      NON_EXECUTABLE_SQUADS_SCRIPT_FILES.length,
    );

    for (const fileName of NON_EXECUTABLE_SQUADS_SCRIPT_FILES) {
      expect(fileName.endsWith('.ts')).to.equal(true);
      expect(fileName.includes('/')).to.equal(false);
      expect(
        SQUADS_SCRIPT_PATHS.some(
          (scriptPath) => scriptPath === `scripts/squads/${fileName}`,
        ),
      ).to.equal(true);
    }
  });
});
