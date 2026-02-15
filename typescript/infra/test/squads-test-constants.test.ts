import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import {
  EXECUTABLE_SQUADS_SCRIPT_PATHS,
  hasAllowedSquadsScriptExtension,
  isAllowlistedNonExecutableSquadsScriptPath,
  isExecutableSquadsScriptPath,
  isFormattingGuardedSquadsScriptPath,
  isGuardedSquadsScriptPath,
  isNormalizedGuardedScriptPath,
  isSquadsDirectoryScriptPath,
  NON_EXECUTABLE_SQUADS_SCRIPT_FILES,
  SQUADS_SCRIPT_FILE_EXTENSIONS,
  SQUADS_ERROR_FORMATTING_SCRIPT_PATHS,
  SQUADS_SCRIPT_PATHS,
} from './squads-test-constants.js';

const INFRA_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

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

  it('keeps expected squads script extension allowlist', () => {
    expect(SQUADS_SCRIPT_FILE_EXTENSIONS).to.deep.equal([
      '.ts',
      '.mts',
      '.cts',
    ]);
  });

  it('keeps squads script extension allowlist normalized and deduplicated', () => {
    expect(new Set(SQUADS_SCRIPT_FILE_EXTENSIONS).size).to.equal(
      SQUADS_SCRIPT_FILE_EXTENSIONS.length,
    );

    for (const extension of SQUADS_SCRIPT_FILE_EXTENSIONS) {
      expect(extension.startsWith('.')).to.equal(true);
      expect(extension).to.equal(extension.trim());
      expect(extension).to.equal(extension.toLowerCase());
      expect(extension.includes('/')).to.equal(false);
      expect(extension.includes('\\')).to.equal(false);
    }
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
    expect(Object.isFrozen(SQUADS_SCRIPT_FILE_EXTENSIONS)).to.equal(true);
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

  it('classifies formatting-guarded script paths consistently', () => {
    for (const scriptPath of SQUADS_SCRIPT_PATHS) {
      const expectedIsFormattingGuarded =
        isGuardedSquadsScriptPath(scriptPath) &&
        isExecutableSquadsScriptPath(scriptPath);
      expect(isFormattingGuardedSquadsScriptPath(scriptPath)).to.equal(
        expectedIsFormattingGuarded,
      );
    }
    expect(
      isFormattingGuardedSquadsScriptPath('scripts/squads/cli-helpers.ts'),
    ).to.equal(false);
    expect(
      isFormattingGuardedSquadsScriptPath(
        'scripts/squads/not-real-formatting-script.ts',
      ),
    ).to.equal(false);
  });

  it('keeps non-executable helper list represented in squads script paths', () => {
    for (const nonExecutableScriptFile of NON_EXECUTABLE_SQUADS_SCRIPT_FILES) {
      expect(
        SQUADS_SCRIPT_PATHS.some(
          (scriptPath) =>
            isAllowlistedNonExecutableSquadsScriptPath(scriptPath) &&
            scriptPath.endsWith(`/${nonExecutableScriptFile}`),
        ),
      ).to.equal(true);
    }
  });

  it('keeps constants free of duplicate script paths', () => {
    expect(new Set(SQUADS_SCRIPT_PATHS).size).to.equal(
      SQUADS_SCRIPT_PATHS.length,
    );
    expect(new Set(EXECUTABLE_SQUADS_SCRIPT_PATHS).size).to.equal(
      EXECUTABLE_SQUADS_SCRIPT_PATHS.length,
    );
    expect(new Set(SQUADS_ERROR_FORMATTING_SCRIPT_PATHS).size).to.equal(
      SQUADS_ERROR_FORMATTING_SCRIPT_PATHS.length,
    );
  });

  it('classifies normalized guarded script paths consistently', () => {
    for (const scriptPath of SQUADS_SCRIPT_PATHS) {
      expect(isNormalizedGuardedScriptPath(scriptPath)).to.equal(true);
    }
    for (const scriptPath of SQUADS_ERROR_FORMATTING_SCRIPT_PATHS) {
      expect(isNormalizedGuardedScriptPath(scriptPath)).to.equal(true);
    }
    expect(
      isNormalizedGuardedScriptPath('/scripts/squads/cli-helpers.ts'),
    ).to.equal(false);
    expect(
      isNormalizedGuardedScriptPath('scripts\\squads\\cli-helpers.ts'),
    ).to.equal(false);
    expect(
      isNormalizedGuardedScriptPath('scripts/squads/../cli-helpers.ts'),
    ).to.equal(false);
  });

  it('keeps exactly one squads-adjacent non-squads script path', () => {
    const nonSquadsDirectoryScriptPaths = SQUADS_SCRIPT_PATHS.filter(
      (scriptPath) => !isSquadsDirectoryScriptPath(scriptPath),
    );
    expect(nonSquadsDirectoryScriptPaths).to.deep.equal([
      'scripts/sealevel-helpers/update-multisig-ism-config.ts',
    ]);
  });

  it('keeps executable constant derived from script allowlist partition', () => {
    const derivedExecutableScriptPaths = SQUADS_SCRIPT_PATHS.filter(
      (scriptPath) => !isAllowlistedNonExecutableSquadsScriptPath(scriptPath),
    );
    expect(EXECUTABLE_SQUADS_SCRIPT_PATHS).to.deep.equal(
      derivedExecutableScriptPaths,
    );
  });

  it('keeps allowlisted non-executable squads script paths canonical', () => {
    const allowlistedScriptPaths = SQUADS_SCRIPT_PATHS.filter((scriptPath) =>
      isAllowlistedNonExecutableSquadsScriptPath(scriptPath),
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

  it('classifies allowlisted non-executable script paths consistently', () => {
    for (const scriptPath of SQUADS_SCRIPT_PATHS) {
      const expectedIsAllowlisted =
        isSquadsDirectoryScriptPath(scriptPath) &&
        NON_EXECUTABLE_SQUADS_SCRIPT_FILES.some((fileName) =>
          scriptPath.endsWith(`/${fileName}`),
        );
      expect(isAllowlistedNonExecutableSquadsScriptPath(scriptPath)).to.equal(
        expectedIsAllowlisted,
      );
    }
  });

  it('classifies executable squads script paths consistently', () => {
    for (const scriptPath of SQUADS_SCRIPT_PATHS) {
      const expectedIsExecutable =
        isGuardedSquadsScriptPath(scriptPath) &&
        !isAllowlistedNonExecutableSquadsScriptPath(scriptPath);
      expect(isExecutableSquadsScriptPath(scriptPath)).to.equal(
        expectedIsExecutable,
      );
    }
  });

  it('classifies guarded squads script paths consistently', () => {
    for (const scriptPath of SQUADS_SCRIPT_PATHS) {
      expect(isGuardedSquadsScriptPath(scriptPath)).to.equal(true);
    }

    expect(isGuardedSquadsScriptPath('scripts/squads/not-real.ts')).to.equal(
      false,
    );
    expect(
      isGuardedSquadsScriptPath(' scripts/squads/cli-helpers.ts'),
    ).to.equal(false);
    expect(
      isGuardedSquadsScriptPath('scripts/squads/cli-helpers.ts '),
    ).to.equal(false);
    expect(
      isGuardedSquadsScriptPath('scripts\\squads\\cli-helpers.ts'),
    ).to.equal(false);
    expect(
      isGuardedSquadsScriptPath(
        'scripts/sealevel-helpers/not-real-multisig-script.ts',
      ),
    ).to.equal(false);
  });

  it('classifies squads-directory script paths consistently', () => {
    for (const scriptPath of SQUADS_SCRIPT_PATHS) {
      const expectedIsSquadsDirectoryPath =
        isNormalizedGuardedScriptPath(scriptPath) &&
        scriptPath.startsWith('scripts/squads/');
      expect(isSquadsDirectoryScriptPath(scriptPath)).to.equal(
        expectedIsSquadsDirectoryPath,
      );
    }
    expect(
      isSquadsDirectoryScriptPath('scripts\\squads\\cli-helpers.ts'),
    ).to.equal(false);
  });

  it('keeps non-executable classifier scoped to scripts/squads paths', () => {
    expect(
      isAllowlistedNonExecutableSquadsScriptPath(
        'scripts/squads/cli-helpers.ts',
      ),
    ).to.equal(true);
    expect(
      isAllowlistedNonExecutableSquadsScriptPath(
        'scripts/sealevel-helpers/cli-helpers.ts',
      ),
    ).to.equal(false);
  });

  it('keeps configured squads script paths constrained to allowed extensions', () => {
    for (const scriptPath of SQUADS_SCRIPT_PATHS) {
      expect(hasAllowedSquadsScriptExtension(scriptPath)).to.equal(true);
    }

    for (const scriptPath of EXECUTABLE_SQUADS_SCRIPT_PATHS) {
      expect(hasAllowedSquadsScriptExtension(scriptPath)).to.equal(true);
    }
  });

  it('classifies allowed squads script extensions consistently', () => {
    for (const scriptPath of SQUADS_SCRIPT_PATHS) {
      const expectedIsAllowed = SQUADS_SCRIPT_FILE_EXTENSIONS.some(
        (extension) => scriptPath.endsWith(extension),
      );
      expect(hasAllowedSquadsScriptExtension(scriptPath)).to.equal(
        expectedIsAllowed,
      );
    }
  });

  it('accepts each allowlisted squads script extension suffix', () => {
    for (const extension of SQUADS_SCRIPT_FILE_EXTENSIONS) {
      expect(
        hasAllowedSquadsScriptExtension(`scripts/squads/example${extension}`),
      ).to.equal(true);
    }
  });

  it('rejects non-allowlisted squads script extensions', () => {
    expect(
      hasAllowedSquadsScriptExtension('scripts/squads/example.js'),
    ).to.equal(false);
    expect(
      hasAllowedSquadsScriptExtension('scripts/squads/example.tsx'),
    ).to.equal(false);
    expect(
      hasAllowedSquadsScriptExtension('scripts/squads/example.TS'),
    ).to.equal(false);
    expect(
      hasAllowedSquadsScriptExtension('scripts/squads/example.ts.bak'),
    ).to.equal(false);
  });

  it('rejects malformed non-executable script path candidates', () => {
    expect(
      isAllowlistedNonExecutableSquadsScriptPath(
        '../scripts/squads/cli-helpers.ts',
      ),
    ).to.equal(false);
    expect(
      isAllowlistedNonExecutableSquadsScriptPath(
        'scripts\\squads\\cli-helpers.ts',
      ),
    ).to.equal(false);
    expect(
      isAllowlistedNonExecutableSquadsScriptPath(
        '/scripts/squads/cli-helpers.ts',
      ),
    ).to.equal(false);
  });

  it('keeps executable and non-executable script partitions complete and disjoint', () => {
    const executableScriptSet = new Set(EXECUTABLE_SQUADS_SCRIPT_PATHS);
    const allowlistedScriptPaths = SQUADS_SCRIPT_PATHS.filter((scriptPath) =>
      isAllowlistedNonExecutableSquadsScriptPath(scriptPath),
    );

    expect(
      new Set(allowlistedScriptPaths).size + executableScriptSet.size,
    ).to.equal(SQUADS_SCRIPT_PATHS.length);

    for (const allowlistedPath of allowlistedScriptPaths) {
      expect(executableScriptSet.has(allowlistedPath)).to.equal(false);
    }

    for (const scriptPath of SQUADS_SCRIPT_PATHS) {
      expect(executableScriptSet.has(scriptPath)).to.equal(
        isExecutableSquadsScriptPath(scriptPath),
      );
    }
  });

  it('keeps configured squads script constants resolving to files', () => {
    const allConfiguredScriptPaths = [
      ...SQUADS_SCRIPT_PATHS,
      ...EXECUTABLE_SQUADS_SCRIPT_PATHS,
      ...SQUADS_ERROR_FORMATTING_SCRIPT_PATHS,
    ];
    for (const scriptPath of allConfiguredScriptPaths) {
      const absoluteScriptPath = path.join(INFRA_ROOT, scriptPath);
      expect(
        fs.existsSync(absoluteScriptPath),
        `Expected configured squads script path to exist: ${scriptPath}`,
      ).to.equal(true);
      expect(
        fs.statSync(absoluteScriptPath).isFile(),
        `Expected configured squads script path to resolve to file: ${scriptPath}`,
      ).to.equal(true);
    }
  });
});
