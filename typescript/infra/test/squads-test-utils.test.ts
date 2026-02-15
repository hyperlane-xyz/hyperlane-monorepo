import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import {
  EXECUTABLE_SQUADS_SCRIPT_PATHS,
  hasAllowedSquadsScriptExtension,
  isAllowlistedNonExecutableSquadsScriptPath,
  isExecutableSquadsScriptPath,
  isGuardedSquadsScriptPath,
  isSquadsDirectoryScriptPath,
  NON_EXECUTABLE_SQUADS_SCRIPT_FILES,
  SQUADS_SCRIPT_PATHS,
} from './squads-test-constants.js';
import {
  listExecutableSquadsDirectoryScripts,
  listSquadsDirectoryScripts,
} from './squads-test-utils.js';

const INFRA_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

describe('squads test utils', () => {
  it('returns fresh squads script arrays per call', () => {
    const firstScripts = listSquadsDirectoryScripts(INFRA_ROOT);
    const secondScripts = listSquadsDirectoryScripts(INFRA_ROOT);
    expect(firstScripts).to.not.equal(secondScripts);
    expect(firstScripts).to.deep.equal(secondScripts);
  });

  it('isolates caller mutation from subsequent squads script reads', () => {
    const firstScripts = listSquadsDirectoryScripts(INFRA_ROOT);
    firstScripts.pop();
    const secondScripts = listSquadsDirectoryScripts(INFRA_ROOT);

    const configuredSquadsScripts = SQUADS_SCRIPT_PATHS.filter((scriptPath) =>
      isSquadsDirectoryScriptPath(scriptPath),
    ).sort();
    expect(secondScripts).to.deep.equal(configuredSquadsScripts);
  });

  it('lists squads directory scripts in sorted order', () => {
    const squadsScripts = listSquadsDirectoryScripts(INFRA_ROOT);
    expect(squadsScripts).to.deep.equal(
      [...squadsScripts].sort(),
      'Expected squads directory scripts to be sorted',
    );

    const configuredSquadsScripts = SQUADS_SCRIPT_PATHS.filter((scriptPath) =>
      isSquadsDirectoryScriptPath(scriptPath),
    ).sort();
    expect(squadsScripts).to.deep.equal(configuredSquadsScripts);
    for (const scriptPath of squadsScripts) {
      expect(scriptPath.includes('\\')).to.equal(false);
      expect(isGuardedSquadsScriptPath(scriptPath)).to.equal(true);
      expect(isSquadsDirectoryScriptPath(scriptPath)).to.equal(true);
      expect(hasAllowedSquadsScriptExtension(scriptPath)).to.equal(true);
    }
  });

  it('lists executable squads scripts excluding non-executable allowlist', () => {
    const executableScripts = listExecutableSquadsDirectoryScripts(INFRA_ROOT);
    const configuredExecutableSquadsScripts =
      EXECUTABLE_SQUADS_SCRIPT_PATHS.filter((scriptPath) =>
        isSquadsDirectoryScriptPath(scriptPath),
      ).sort();
    expect(executableScripts).to.deep.equal(configuredExecutableSquadsScripts);

    for (const nonExecutableScriptFile of NON_EXECUTABLE_SQUADS_SCRIPT_FILES) {
      expect(
        executableScripts.some((scriptPath) =>
          scriptPath.endsWith(`/${nonExecutableScriptFile}`),
        ),
      ).to.equal(false);
    }
    for (const scriptPath of executableScripts) {
      expect(isAllowlistedNonExecutableSquadsScriptPath(scriptPath)).to.equal(
        false,
      );
      expect(isGuardedSquadsScriptPath(scriptPath)).to.equal(true);
      expect(isExecutableSquadsScriptPath(scriptPath)).to.equal(true);
    }

    expect(
      executableScripts.some((scriptPath) =>
        scriptPath.includes('/sealevel-helpers/'),
      ),
      'Expected squads-directory executable helper list to remain scoped to scripts/squads',
    ).to.equal(false);
    expect(
      executableScripts.some((scriptPath) => scriptPath.includes('\\')),
    ).to.equal(false);
    for (const scriptPath of executableScripts) {
      expect(isSquadsDirectoryScriptPath(scriptPath)).to.equal(true);
    }
  });

  it('returns fresh executable squads script arrays per call', () => {
    const firstExecutableScripts =
      listExecutableSquadsDirectoryScripts(INFRA_ROOT);
    const secondExecutableScripts =
      listExecutableSquadsDirectoryScripts(INFRA_ROOT);
    expect(firstExecutableScripts).to.not.equal(secondExecutableScripts);
    expect(firstExecutableScripts).to.deep.equal(secondExecutableScripts);
  });

  it('isolates caller mutation from subsequent executable squads script reads', () => {
    const firstExecutableScripts =
      listExecutableSquadsDirectoryScripts(INFRA_ROOT);
    firstExecutableScripts.pop();
    const secondExecutableScripts =
      listExecutableSquadsDirectoryScripts(INFRA_ROOT);

    const configuredExecutableSquadsScripts =
      EXECUTABLE_SQUADS_SCRIPT_PATHS.filter((scriptPath) =>
        isSquadsDirectoryScriptPath(scriptPath),
      ).sort();
    expect(secondExecutableScripts).to.deep.equal(
      configuredExecutableSquadsScripts,
    );
  });
});
