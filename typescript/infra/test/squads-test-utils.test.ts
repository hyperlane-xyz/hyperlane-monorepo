import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import {
  EXECUTABLE_SQUADS_SCRIPT_PATHS,
  NON_EXECUTABLE_SQUADS_SCRIPT_FILES,
  SQUADS_SCRIPT_PATHS,
} from './squads-test-constants.js';
import {
  listExecutableSquadsDirectoryScripts,
  listSquadsDirectoryScripts,
} from './squads-test-utils.js';

const INFRA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('squads test utils', () => {
  it('lists squads directory scripts in sorted order', () => {
    const squadsScripts = listSquadsDirectoryScripts(INFRA_ROOT);
    expect(squadsScripts).to.deep.equal(
      [...squadsScripts].sort(),
      'Expected squads directory scripts to be sorted',
    );

    const configuredSquadsScripts = SQUADS_SCRIPT_PATHS.filter((scriptPath) =>
      scriptPath.startsWith('scripts/squads/'),
    ).sort();
    expect(squadsScripts).to.deep.equal(configuredSquadsScripts);
  });

  it('lists executable squads scripts excluding non-executable allowlist', () => {
    const executableScripts = listExecutableSquadsDirectoryScripts(INFRA_ROOT);
    const configuredExecutableSquadsScripts = EXECUTABLE_SQUADS_SCRIPT_PATHS.filter(
      (scriptPath) => scriptPath.startsWith('scripts/squads/'),
    ).sort();
    expect(executableScripts).to.deep.equal(
      configuredExecutableSquadsScripts,
    );

    for (const nonExecutableScriptFile of NON_EXECUTABLE_SQUADS_SCRIPT_FILES) {
      expect(
        executableScripts.some((scriptPath) =>
          scriptPath.endsWith(`/${nonExecutableScriptFile}`),
        ),
      ).to.equal(false);
    }

    expect(
      executableScripts.some((scriptPath) =>
        scriptPath.includes('/sealevel-helpers/'),
      ),
      'Expected squads-directory executable helper list to remain scoped to scripts/squads',
    ).to.equal(false);
  });
});
