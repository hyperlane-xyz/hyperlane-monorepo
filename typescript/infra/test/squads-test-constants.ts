export const NON_EXECUTABLE_SQUADS_SCRIPT_FILES = Object.freeze([
  'cli-helpers.ts',
]);

export const SQUADS_SCRIPT_FILE_EXTENSIONS = Object.freeze([
  '.ts',
  '.mts',
  '.cts',
]);

export function hasAllowedSquadsScriptExtension(scriptPath: string): boolean {
  return SQUADS_SCRIPT_FILE_EXTENSIONS.some((extension) =>
    scriptPath.endsWith(extension),
  );
}

export const SQUADS_SCRIPT_PATHS = Object.freeze([
  'scripts/squads/cli-helpers.ts',
  'scripts/squads/get-pending-txs.ts',
  'scripts/squads/parse-txs.ts',
  'scripts/squads/read-proposal.ts',
  'scripts/squads/cancel-proposal.ts',
  'scripts/sealevel-helpers/update-multisig-ism-config.ts',
]);

export function isNormalizedGuardedScriptPath(scriptPath: string): boolean {
  return (
    scriptPath.startsWith('scripts/') &&
    !scriptPath.startsWith('/') &&
    !scriptPath.includes('\\') &&
    !scriptPath.split('/').includes('..')
  );
}

export function isSquadsDirectoryScriptPath(scriptPath: string): boolean {
  return (
    isNormalizedGuardedScriptPath(scriptPath) &&
    scriptPath.startsWith('scripts/squads/')
  );
}

export function isAllowlistedNonExecutableSquadsScriptPath(
  scriptPath: string,
): boolean {
  if (!isSquadsDirectoryScriptPath(scriptPath)) {
    return false;
  }
  return NON_EXECUTABLE_SQUADS_SCRIPT_FILES.some((fileName) =>
    scriptPath.endsWith(`/${fileName}`),
  );
}

export function isExecutableSquadsScriptPath(scriptPath: string): boolean {
  return (
    SQUADS_SCRIPT_PATHS.includes(scriptPath) &&
    !isAllowlistedNonExecutableSquadsScriptPath(scriptPath)
  );
}

export const EXECUTABLE_SQUADS_SCRIPT_PATHS = Object.freeze(
  SQUADS_SCRIPT_PATHS.filter((scriptPath) =>
    isExecutableSquadsScriptPath(scriptPath),
  ),
);

export const SQUADS_ERROR_FORMATTING_SCRIPT_PATHS = Object.freeze([
  ...EXECUTABLE_SQUADS_SCRIPT_PATHS,
]);
