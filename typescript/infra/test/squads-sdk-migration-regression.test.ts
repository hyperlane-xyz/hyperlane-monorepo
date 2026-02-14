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

const LEGACY_SQUADS_REFERENCE_PATTERN =
  /(?:from\s+['"](?:\.\.\/)+src\/(?:config|utils|tx)\/squads(?:-transaction-reader)?(?:\.js)?['"]|import\(\s*['"](?:\.\.\/)+src\/(?:config|utils|tx)\/squads(?:-transaction-reader)?(?:\.js)?['"]\s*\)|require\(\s*['"](?:\.\.\/)+src\/(?:config|utils|tx)\/squads(?:-transaction-reader)?(?:\.js)?['"]\s*\))/;
const SQDS_MULTISIG_REFERENCE_PATTERN =
  /(?:from\s+['"]@sqds\/multisig['"]|import\(\s*['"]@sqds\/multisig['"]\s*\)|require\(\s*['"]@sqds\/multisig['"]\s*\))/;
const SDK_SQUADS_IMPORT_PATTERN =
  /from\s+['"]@hyperlane-xyz\/sdk['"]/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'cache', '.turbo']);

function readInfraFile(relativePath: string): string {
  return fs.readFileSync(path.join(INFRA_ROOT, relativePath), 'utf8');
}

function assertNoForbiddenSquadsReferences(
  fileContents: string,
  relativePath: string,
): void {
  expect(
    LEGACY_SQUADS_REFERENCE_PATTERN.test(fileContents),
    `Expected file to avoid legacy infra squads references: ${relativePath}`,
  ).to.equal(false);

  expect(
    SQDS_MULTISIG_REFERENCE_PATTERN.test(fileContents),
    `Expected file to avoid direct @sqds/multisig references: ${relativePath}`,
  ).to.equal(false);
}

function listTypeScriptFilesRecursively(relativeDir: string): string[] {
  const absoluteDir = path.join(INFRA_ROOT, relativeDir);
  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const entryRelativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFilesRecursively(entryRelativePath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(entryRelativePath);
    }
  }

  return files;
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

      assertNoForbiddenSquadsReferences(scriptContents, scriptPath);
    }
  });

  it('keeps all infra typescript files free of legacy squads imports', () => {
    const typeScriptFiles = listTypeScriptFilesRecursively('.');

    for (const relativePath of typeScriptFiles) {
      const fileContents = readInfraFile(relativePath);
      assertNoForbiddenSquadsReferences(fileContents, relativePath);
    }
  });
});
