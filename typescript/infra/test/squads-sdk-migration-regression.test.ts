import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

const INFRA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REMOVED_INFRA_SQUADS_MODULE_BASE_PATHS = Object.freeze([
  'src/config/squads',
  'src/utils/squads',
  'src/tx/squads-transaction-reader',
]);
const SOURCE_FILE_EXTENSIONS = Object.freeze([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
]);

const SQUADS_SCRIPT_PATHS = Object.freeze([
  'scripts/squads/cli-helpers.ts',
  'scripts/squads/get-pending-txs.ts',
  'scripts/squads/parse-txs.ts',
  'scripts/squads/read-proposal.ts',
  'scripts/squads/cancel-proposal.ts',
  'scripts/sealevel-helpers/update-multisig-ism-config.ts',
]);
const SQUADS_ERROR_FORMATTING_SCRIPT_PATHS = Object.freeze([
  'scripts/squads/get-pending-txs.ts',
  'scripts/squads/parse-txs.ts',
  'scripts/squads/read-proposal.ts',
  'scripts/squads/cancel-proposal.ts',
  'scripts/sealevel-helpers/update-multisig-ism-config.ts',
]);

const LEGACY_SQUADS_SPECIFIER =
  '(?:(?:\\.\\.\\/)+src\\/|src\\/|@hyperlane-xyz\\/infra\\/src\\/)(?:config|utils|tx)\\/squads(?:-transaction-reader)?(?:\\.[cm]?[jt]sx?|\\.js)?';
const LEGACY_SQUADS_REFERENCE_PATTERN = new RegExp(
  `(?:from\\s+['"]${LEGACY_SQUADS_SPECIFIER}['"]|import\\(\\s*['"]${LEGACY_SQUADS_SPECIFIER}['"]\\s*\\)|require\\(\\s*['"]${LEGACY_SQUADS_SPECIFIER}['"]\\s*\\))`,
);
const SQDS_MULTISIG_REFERENCE_PATTERN =
  /(?:from\s+['"]@sqds\/multisig['"]|import\(\s*['"]@sqds\/multisig['"]\s*\)|require\(\s*['"]@sqds\/multisig['"]\s*\))/;
const SDK_SQUADS_IMPORT_PATTERN =
  /from\s+['"]@hyperlane-xyz\/sdk['"]/;
const FORMATTED_ERROR_USAGE_PATTERN = /formatScriptError\(/;
const DIRECT_ERROR_STRINGIFICATION_PATTERN =
  /(?:String\(error\)|\$\{error\}|error\.message)/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'cache', '.turbo']);

function readInfraFile(relativePath: string): string {
  return fs.readFileSync(path.join(INFRA_ROOT, relativePath), 'utf8');
}

function readInfraPackageJson(): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readInfraFile('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
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

    const isTypeScriptLikeFile =
      entry.isFile() &&
      ['.ts', '.tsx', '.mts', '.cts'].some((extension) =>
        entry.name.endsWith(extension),
      );
    if (isTypeScriptLikeFile) {
      files.push(entryRelativePath);
    }
  }

  return files;
}

describe('squads sdk migration regression', () => {
  it('keeps infra package explicitly depending on sdk squads surface', () => {
    const infraPackageJson = readInfraPackageJson();

    expect(infraPackageJson.dependencies?.['@hyperlane-xyz/sdk']).to.equal(
      'workspace:*',
    );
    expect(infraPackageJson.devDependencies?.['@hyperlane-xyz/sdk']).to.equal(
      undefined,
    );
  });

  it('keeps infra package free of direct @sqds/multisig dependency', () => {
    const infraPackageJson = readInfraPackageJson();

    expect(infraPackageJson.dependencies?.['@sqds/multisig']).to.equal(
      undefined,
    );
    expect(infraPackageJson.devDependencies?.['@sqds/multisig']).to.equal(
      undefined,
    );
  });

  it('keeps removed infra squads modules deleted', () => {
    for (const removedModuleBasePath of REMOVED_INFRA_SQUADS_MODULE_BASE_PATHS) {
      for (const extension of SOURCE_FILE_EXTENSIONS) {
        const removedModulePath = `${removedModuleBasePath}${extension}`;
        const absolutePath = path.join(INFRA_ROOT, removedModulePath);
        expect(
          fs.existsSync(absolutePath),
          `Expected removed module to stay deleted: ${removedModulePath}`,
        ).to.equal(false);
      }
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

  it('keeps squads-related scripts using shared formatScriptError helper', () => {
    for (const scriptPath of SQUADS_ERROR_FORMATTING_SCRIPT_PATHS) {
      const scriptContents = readInfraFile(scriptPath);

      expect(
        FORMATTED_ERROR_USAGE_PATTERN.test(scriptContents),
        `Expected script to use formatScriptError helper: ${scriptPath}`,
      ).to.equal(true);

      expect(
        DIRECT_ERROR_STRINGIFICATION_PATTERN.test(scriptContents),
        `Expected script to avoid direct error stringification: ${scriptPath}`,
      ).to.equal(false);
    }
  });
});
