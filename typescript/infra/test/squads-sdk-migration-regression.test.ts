import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

const INFRA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REMOVED_INFRA_SQUADS_MODULES = Object.freeze([
  'src/config/squads.ts',
  'src/utils/squads.ts',
  'src/tx/squads-transaction-reader.ts',
]);

const SQUADS_SCRIPT_PATHS = Object.freeze([
  'scripts/squads/cli-helpers.ts',
  'scripts/squads/get-pending-txs.ts',
  'scripts/squads/parse-txs.ts',
  'scripts/squads/read-proposal.ts',
  'scripts/squads/cancel-proposal.ts',
]);

const LEGACY_SQUADS_IMPORT_PATTERN =
  /from\s+['"]\.\.\/\.\.\/src\/(?:config|utils|tx)\/squads(?:-transaction-reader)?(?:\.js)?['"]/;
const SQDS_MULTISIG_IMPORT_PATTERN = /from\s+['"]@sqds\/multisig['"]/;
const SDK_SQUADS_IMPORT_PATTERN =
  /from\s+['"]@hyperlane-xyz\/sdk['"]/;

function readInfraFile(relativePath: string): string {
  return fs.readFileSync(path.join(INFRA_ROOT, relativePath), 'utf8');
}

describe('squads sdk migration regression', () => {
  it('keeps removed infra squads modules deleted', () => {
    for (const removedModulePath of REMOVED_INFRA_SQUADS_MODULES) {
      const absolutePath = path.join(INFRA_ROOT, removedModulePath);
      expect(
        fs.existsSync(absolutePath),
        `Expected removed module to stay deleted: ${removedModulePath}`,
      ).to.equal(false);
    }
  });

  it('keeps squads scripts sourced from SDK and away from legacy infra modules', () => {
    for (const scriptPath of SQUADS_SCRIPT_PATHS) {
      const scriptContents = readInfraFile(scriptPath);

      expect(
        SDK_SQUADS_IMPORT_PATTERN.test(scriptContents),
        `Expected script to import squads APIs from SDK: ${scriptPath}`,
      ).to.equal(true);

      expect(
        LEGACY_SQUADS_IMPORT_PATTERN.test(scriptContents),
        `Expected script to avoid legacy infra squads imports: ${scriptPath}`,
      ).to.equal(false);

      expect(
        SQDS_MULTISIG_IMPORT_PATTERN.test(scriptContents),
        `Expected script to avoid direct @sqds/multisig imports: ${scriptPath}`,
      ).to.equal(false);
    }
  });
});
