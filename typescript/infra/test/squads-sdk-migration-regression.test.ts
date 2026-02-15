import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import {
  EXECUTABLE_SQUADS_SCRIPT_PATHS,
  isAllowlistedNonExecutableSquadsScriptPath,
  NON_EXECUTABLE_SQUADS_SCRIPT_FILES,
  SQUADS_ERROR_FORMATTING_SCRIPT_PATHS,
  SQUADS_SCRIPT_FILE_EXTENSIONS,
  SQUADS_SCRIPT_PATHS,
} from './squads-test-constants.js';
import { listSquadsDirectoryScripts } from './squads-test-utils.js';

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
  '.mjs',
  '.cjs',
]);

const LEGACY_SQUADS_SPECIFIER =
  '(?:(?:\\.\\.\\/)+src\\/|src\\/|@hyperlane-xyz\\/infra\\/src\\/)(?:config|utils|tx)\\/squads(?:-transaction-reader)?(?:\\.[cm]?[jt]sx?|\\.js)?';
const LEGACY_SQUADS_REFERENCE_PATTERN = new RegExp(
  `(?:from\\s+['"]${LEGACY_SQUADS_SPECIFIER}['"]|import\\(\\s*['"]${LEGACY_SQUADS_SPECIFIER}['"]\\s*\\)|require\\(\\s*['"]${LEGACY_SQUADS_SPECIFIER}['"]\\s*\\))`,
);
const SQDS_MULTISIG_REFERENCE_PATTERN =
  /(?:from\s+['"]@sqds\/multisig['"]|import\(\s*['"]@sqds\/multisig['"]\s*\)|require\(\s*['"]@sqds\/multisig['"]\s*\))/;
const SDK_DEEP_IMPORT_PATTERN =
  /(?:from\s+['"]@hyperlane-xyz\/sdk\/src\/|import\(\s*['"]@hyperlane-xyz\/sdk\/src\/|require\(\s*['"]@hyperlane-xyz\/sdk\/src\/)/;
const SDK_SUBPATH_IMPORT_PATTERN =
  /(?:from\s+['"]@hyperlane-xyz\/sdk\/|import\(\s*['"]@hyperlane-xyz\/sdk\/|require\(\s*['"]@hyperlane-xyz\/sdk\/)/;
const LOCAL_SDK_WORKSPACE_REFERENCE_PATTERN =
  /(?:from\s+['"](?:\.\.\/)+sdk\/(?:src|dist)\/|import\(\s*['"](?:\.\.\/)+sdk\/(?:src|dist)\/|require\(\s*['"](?:\.\.\/)+sdk\/(?:src|dist)\/|from\s+['"]typescript\/sdk\/(?:src|dist)\/|import\(\s*['"]typescript\/sdk\/(?:src|dist)\/|require\(\s*['"]typescript\/sdk\/(?:src|dist)\/)/;
const SDK_SQUADS_IMPORT_PATTERN =
  /(?:from\s+['"]@hyperlane-xyz\/sdk['"]|import\(\s*['"]@hyperlane-xyz\/sdk['"]\s*\)|require\(\s*['"]@hyperlane-xyz\/sdk['"]\s*\))/;
const FORMATTED_ERROR_USAGE_PATTERN = /formatScriptError\(/;
const DIRECT_ERROR_STRINGIFICATION_PATTERN =
  /(?:String\((?:error|err|e)\)|\$\{(?:error|err|e)\}|(?:error|err|e)\.message)/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'cache', '.turbo']);

function readInfraFile(relativePath: string): string {
  return fs.readFileSync(path.join(INFRA_ROOT, relativePath), 'utf8');
}

function readInfraPackageJson(): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
} {
  return JSON.parse(readInfraFile('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
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

  expect(
    SDK_DEEP_IMPORT_PATTERN.test(fileContents),
    `Expected file to avoid deep SDK source imports: ${relativePath}`,
  ).to.equal(false);

  expect(
    SDK_SUBPATH_IMPORT_PATTERN.test(fileContents),
    `Expected file to avoid SDK subpath imports and rely on package root exports: ${relativePath}`,
  ).to.equal(false);

  expect(
    LOCAL_SDK_WORKSPACE_REFERENCE_PATTERN.test(fileContents),
    `Expected file to avoid local SDK workspace-path imports: ${relativePath}`,
  ).to.equal(false);
}

function listTrackedSourceFilesRecursively(relativeDir: string): string[] {
  const absoluteDir = path.join(INFRA_ROOT, relativeDir);
  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const entryRelativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTrackedSourceFilesRecursively(entryRelativePath));
      continue;
    }

    const isTrackedSourceFile =
      entry.isFile() &&
      SOURCE_FILE_EXTENSIONS.some((extension) =>
        entry.name.endsWith(extension),
      );
    if (isTrackedSourceFile) {
      files.push(entryRelativePath);
    }
  }

  return files;
}

describe('squads sdk migration regression', () => {
  it('keeps squads script constants immutable', () => {
    expect(Object.isFrozen(SQUADS_SCRIPT_PATHS)).to.equal(true);
    expect(Object.isFrozen(NON_EXECUTABLE_SQUADS_SCRIPT_FILES)).to.equal(true);
    expect(Object.isFrozen(SQUADS_SCRIPT_FILE_EXTENSIONS)).to.equal(true);
    expect(Object.isFrozen(EXECUTABLE_SQUADS_SCRIPT_PATHS)).to.equal(true);
    expect(Object.isFrozen(SQUADS_ERROR_FORMATTING_SCRIPT_PATHS)).to.equal(true);
  });

  it('keeps tracked-source extension policy deduplicated and squads-compatible', () => {
    expect(new Set(SOURCE_FILE_EXTENSIONS).size).to.equal(
      SOURCE_FILE_EXTENSIONS.length,
    );
    for (const squadsScriptExtension of SQUADS_SCRIPT_FILE_EXTENSIONS) {
      expect(
        SOURCE_FILE_EXTENSIONS.includes(squadsScriptExtension),
        `Expected tracked source extension policy to include squads script extension: ${squadsScriptExtension}`,
      ).to.equal(true);
    }
  });

  it('keeps guarded squads script path lists valid and deduplicated', () => {
    expect(new Set(SQUADS_SCRIPT_PATHS).size).to.equal(SQUADS_SCRIPT_PATHS.length);
    expect(new Set(SQUADS_ERROR_FORMATTING_SCRIPT_PATHS).size).to.equal(
      SQUADS_ERROR_FORMATTING_SCRIPT_PATHS.length,
    );

    for (const scriptPath of SQUADS_SCRIPT_PATHS) {
      const absolutePath = path.join(INFRA_ROOT, scriptPath);
      expect(
        fs.existsSync(absolutePath),
        `Expected guarded script path to exist: ${scriptPath}`,
      ).to.equal(true);
    }

    const squadsScriptSet = new Set(SQUADS_SCRIPT_PATHS);
    for (const scriptPath of SQUADS_ERROR_FORMATTING_SCRIPT_PATHS) {
      expect(
        squadsScriptSet.has(scriptPath),
        `Expected formatting-guarded script to be in primary squads script list: ${scriptPath}`,
      ).to.equal(true);
    }
  });

  it('keeps guarded squads script paths normalized and relative', () => {
    const guardedScriptPaths = new Set([
      ...SQUADS_SCRIPT_PATHS,
      ...SQUADS_ERROR_FORMATTING_SCRIPT_PATHS,
    ]);

    for (const scriptPath of guardedScriptPaths) {
      expect(path.isAbsolute(scriptPath)).to.equal(false);
      expect(scriptPath.includes('\\')).to.equal(false);
      expect(scriptPath.split('/').includes('..')).to.equal(false);
      expect(scriptPath.startsWith('scripts/')).to.equal(true);
    }
  });

  it('keeps guarded squads script list synchronized with scripts/squads directory', () => {
    const discoveredSquadsScripts = listSquadsDirectoryScripts(INFRA_ROOT);
    const configuredSquadsScripts = SQUADS_SCRIPT_PATHS.filter((scriptPath) =>
      scriptPath.startsWith('scripts/squads/'),
    ).sort();

    expect(configuredSquadsScripts).to.deep.equal(discoveredSquadsScripts);
  });

  it('keeps non-executable squads script allowlist synchronized with scripts/squads', () => {
    const configuredNonExecutableSquadsScripts =
      NON_EXECUTABLE_SQUADS_SCRIPT_FILES.map((fileName) =>
        path.posix.join('scripts/squads', fileName),
      ).sort();
    const discoveredSquadsScripts = listSquadsDirectoryScripts(INFRA_ROOT);
    const discoveredNonExecutableSquadsScripts = discoveredSquadsScripts.filter(
      (scriptPath) => isAllowlistedNonExecutableSquadsScriptPath(scriptPath),
    );

    expect(configuredNonExecutableSquadsScripts).to.deep.equal(
      discoveredNonExecutableSquadsScripts,
    );
  });

  it('keeps formatting-guarded script paths executable', () => {
    for (const scriptPath of SQUADS_ERROR_FORMATTING_SCRIPT_PATHS) {
      expect(
        isAllowlistedNonExecutableSquadsScriptPath(scriptPath),
        `Expected formatting-guarded script path to be executable: ${scriptPath}`,
      ).to.equal(false);
    }
  });

  it('keeps infra squads regression script stable', () => {
    const infraPackageJson = readInfraPackageJson();

    expect(infraPackageJson.scripts?.['test:squads']).to.equal(
      'mocha --config ../sdk/.mocharc.json "test/squads-cli-helpers.test.ts" "test/squads-scripts-help.test.ts" "test/squads-sdk-migration-regression.test.ts" "test/squads-test-utils.test.ts" "test/squads-test-constants.test.ts"',
    );
  });

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

  it('keeps all tracked infra source files free of legacy squads imports', () => {
    const trackedSourceFiles = listTrackedSourceFilesRecursively('.');

    for (const relativePath of trackedSourceFiles) {
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
