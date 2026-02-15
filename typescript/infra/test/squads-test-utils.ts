import fs from 'node:fs';
import path from 'node:path';

import {
  isAllowlistedNonExecutableSquadsScriptPath,
  SQUADS_SCRIPT_FILE_EXTENSIONS,
} from './squads-test-constants.js';

export function listSquadsDirectoryScripts(infraRoot: string): string[] {
  const squadsScriptsDir = path.join(infraRoot, 'scripts/squads');
  return fs
    .readdirSync(squadsScriptsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        SQUADS_SCRIPT_FILE_EXTENSIONS.some((extension) =>
          entry.name.endsWith(extension),
        ),
    )
    .map((entry) => path.posix.join('scripts/squads', entry.name))
    .sort();
}

export function listExecutableSquadsDirectoryScripts(
  infraRoot: string,
): string[] {
  return listSquadsDirectoryScripts(infraRoot).filter(
    (scriptPath) => !isAllowlistedNonExecutableSquadsScriptPath(scriptPath),
  );
}
