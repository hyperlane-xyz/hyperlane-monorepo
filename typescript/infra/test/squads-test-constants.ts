export const NON_EXECUTABLE_SQUADS_SCRIPT_FILES = Object.freeze([
  'cli-helpers.ts',
]);

export const SQUADS_SCRIPT_FILE_EXTENSIONS = Object.freeze([
  '.ts',
  '.mts',
  '.cts',
]);

export const SQUADS_SCRIPT_PATHS = Object.freeze([
  'scripts/squads/cli-helpers.ts',
  'scripts/squads/get-pending-txs.ts',
  'scripts/squads/parse-txs.ts',
  'scripts/squads/read-proposal.ts',
  'scripts/squads/cancel-proposal.ts',
  'scripts/sealevel-helpers/update-multisig-ism-config.ts',
]);

export const EXECUTABLE_SQUADS_SCRIPT_PATHS = Object.freeze(
  SQUADS_SCRIPT_PATHS.filter(
    (scriptPath) =>
      !NON_EXECUTABLE_SQUADS_SCRIPT_FILES.some((fileName) =>
        scriptPath.endsWith(`/${fileName}`),
      ),
  ),
);

export const SQUADS_ERROR_FORMATTING_SCRIPT_PATHS = Object.freeze([
  ...EXECUTABLE_SQUADS_SCRIPT_PATHS,
]);
