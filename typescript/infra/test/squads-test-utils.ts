import fs from 'node:fs';
import path from 'node:path';

import { NON_EXECUTABLE_SQUADS_SCRIPT_FILES } from './squads-test-constants.js';

export function listSquadsDirectoryScripts(infraRoot: string): string[] {
  const squadsScriptsDir = path.join(infraRoot, 'scripts/squads');
  return fs
    .readdirSync(squadsScriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join('scripts/squads', entry.name))
    .sort();
}

export function listExecutableSquadsDirectoryScripts(
  infraRoot: string,
): string[] {
  return listSquadsDirectoryScripts(infraRoot).filter(
    (scriptPath) =>
      !NON_EXECUTABLE_SQUADS_SCRIPT_FILES.some((fileName) =>
        scriptPath.endsWith(`/${fileName}`),
      ),
  );
}
