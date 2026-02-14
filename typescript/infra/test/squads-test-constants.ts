export const NON_EXECUTABLE_SQUADS_SCRIPT_FILES = Object.freeze([
  'cli-helpers.ts',
]);

export const SQUADS_SCRIPT_PATHS = Object.freeze([
  'scripts/squads/cli-helpers.ts',
  'scripts/squads/get-pending-txs.ts',
  'scripts/squads/parse-txs.ts',
  'scripts/squads/read-proposal.ts',
  'scripts/squads/cancel-proposal.ts',
  'scripts/sealevel-helpers/update-multisig-ism-config.ts',
]);

export const SQUADS_ERROR_FORMATTING_SCRIPT_PATHS = SQUADS_SCRIPT_PATHS.filter(
  (scriptPath) =>
    !NON_EXECUTABLE_SQUADS_SCRIPT_FILES.some((fileName) =>
      scriptPath.endsWith(`/${fileName}`),
    ),
);
