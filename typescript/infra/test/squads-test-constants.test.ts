import { expect } from 'chai';

import {
  EXECUTABLE_SQUADS_SCRIPT_PATHS,
  NON_EXECUTABLE_SQUADS_SCRIPT_FILES,
  SQUADS_ERROR_FORMATTING_SCRIPT_PATHS,
  SQUADS_SCRIPT_PATHS,
} from './squads-test-constants.js';

describe('squads test constants', () => {
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
});
