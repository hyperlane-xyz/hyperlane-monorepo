import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import {
  EXECUTABLE_SQUADS_SCRIPT_PATHS,
  isAllowlistedNonExecutableSquadsScriptPath,
  isExecutableSquadsScriptPath,
  isFormattingGuardedSquadsScriptPath,
  isGuardedSquadsScriptPath,
  isNormalizedGuardedScriptPath,
  isSquadsDirectoryScriptPath,
  NON_EXECUTABLE_SQUADS_SCRIPT_FILES,
  SQUADS_ERROR_FORMATTING_SCRIPT_PATHS,
  SQUADS_SCRIPT_FILE_EXTENSIONS,
  SQUADS_SCRIPT_PATHS,
} from './squads-test-constants.js';
import { listSquadsDirectoryScripts } from './squads-test-utils.js';

const INFRA_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

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
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'cache',
  '.turbo',
]);
const SQUADS_REGRESSION_TEST_PATHS = Object.freeze([
  'test/squads-cli-helpers.test.ts',
  'test/squads-scripts-help.test.ts',
  'test/squads-sdk-migration-regression.test.ts',
  'test/squads-test-utils.test.ts',
  'test/squads-test-constants.test.ts',
]);
const SQUADS_TRACKED_TEST_SUPPORT_PATHS = Object.freeze([
  'test/squads-test-constants.ts',
  'test/squads-test-utils.ts',
]);
const SQUADS_TRACKED_TEST_ASSET_PATHS = Object.freeze([
  ...SQUADS_REGRESSION_TEST_PATHS,
  ...SQUADS_TRACKED_TEST_SUPPORT_PATHS,
]);
const INFRA_SQUADS_TEST_COMMAND_PREFIX = 'mocha --config ../sdk/.mocharc.json';
const EXPECTED_INFRA_SQUADS_TEST_SCRIPT = `${INFRA_SQUADS_TEST_COMMAND_PREFIX} ${SQUADS_REGRESSION_TEST_PATHS.map((scriptPath) => `"${scriptPath}"`).join(' ')}`;
const QUOTED_SCRIPT_PATH_PATTERN = /"([^"]+)"/g;

function compareLexicographically(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function toPosixPath(relativePath: string): string {
  const normalizedByPlatformSeparator = relativePath
    .split(path.sep)
    .join(path.posix.sep);
  return normalizedByPlatformSeparator.split('\\').join(path.posix.sep);
}

function hasTrackedSourceExtension(relativePath: string): boolean {
  return SOURCE_FILE_EXTENSIONS.some((extension) =>
    relativePath.endsWith(extension),
  );
}

function shouldSkipTrackedSourceDirectory(entryName: string): boolean {
  return SKIPPED_DIRECTORIES.has(entryName);
}

function isNormalizedTrackedSourceRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath === relativePath.trim() &&
    relativePath === path.posix.normalize(relativePath) &&
    !relativePath.startsWith('.') &&
    !relativePath.startsWith('/') &&
    !relativePath.includes('\\') &&
    !relativePath.split('/').includes('..')
  );
}

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
  const entries = fs
    .readdirSync(absoluteDir, { withFileTypes: true })
    .sort((left, right) => compareLexicographically(left.name, right.name));
  const files: string[] = [];

  for (const entry of entries) {
    if (shouldSkipTrackedSourceDirectory(entry.name)) {
      continue;
    }

    const entryRelativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTrackedSourceFilesRecursively(entryRelativePath));
      continue;
    }

    const isTrackedSourceFile =
      entry.isFile() && hasTrackedSourceExtension(entry.name);
    if (isTrackedSourceFile) {
      files.push(toPosixPath(entryRelativePath));
    }
  }

  return files.sort(compareLexicographically);
}

function getTrackedSourceFileSnapshot(): readonly string[] {
  return listTrackedSourceFilesRecursively('.');
}

function getTrackedSourceFileSet(): ReadonlySet<string> {
  return new Set(getTrackedSourceFileSnapshot());
}

function listQuotedScriptPaths(command: string): readonly string[] {
  return [...command.matchAll(QUOTED_SCRIPT_PATH_PATTERN)].map(
    (match) => match[1],
  );
}

function getQuotedInfraSquadsRegressionPaths(): readonly string[] {
  return listQuotedScriptPaths(EXPECTED_INFRA_SQUADS_TEST_SCRIPT);
}

function countSubstringOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

function assertCanonicalCliCommandShape(
  command: string,
  commandLabel: string,
): void {
  expect(command, `Expected ${commandLabel} to be trimmed`).to.equal(
    command.trim(),
  );
  expect(
    command.includes('  '),
    `Expected ${commandLabel} to avoid duplicate spaces`,
  ).to.equal(false);
  expect(
    /[\n\r\t]/.test(command),
    `Expected ${commandLabel} to be single-line without tab/newline characters`,
  ).to.equal(false);
  expect(
    command.includes('\\'),
    `Expected ${commandLabel} to avoid backslash separators`,
  ).to.equal(false);
}

function assertTrackedSourcePathSetNormalizedAndDeduplicated(
  paths: readonly string[],
  pathSetLabel: string,
): void {
  expect(new Set(paths).size).to.equal(paths.length);
  for (const pathValue of paths) {
    expect(
      isNormalizedTrackedSourceRelativePath(pathValue),
      `Expected ${pathSetLabel} path to be normalized and relative: ${pathValue}`,
    ).to.equal(true);
    expect(
      /\s/.test(pathValue),
      `Expected ${pathSetLabel} path to avoid whitespace characters: ${pathValue}`,
    ).to.equal(false);
    expect(
      hasTrackedSourceExtension(pathValue),
      `Expected ${pathSetLabel} path to match tracked source extension policy: ${pathValue}`,
    ).to.equal(true);
  }
}

function assertTrackedSourceSetContainsPaths(
  trackedSourceFileSet: ReadonlySet<string>,
  expectedPaths: readonly string[],
  pathSetLabel: string,
): void {
  for (const expectedPath of expectedPaths) {
    expect(
      trackedSourceFileSet.has(expectedPath),
      `Expected tracked source scan to include ${pathSetLabel} path: ${expectedPath}`,
    ).to.equal(true);
  }
}

function assertRegressionTestPathShape(
  pathValue: string,
  pathLabel: string,
): void {
  expect(
    pathValue.startsWith('test/'),
    `Expected ${pathLabel} to stay test-directory scoped: ${pathValue}`,
  ).to.equal(true);
  expect(
    pathValue.startsWith('test/squads-'),
    `Expected ${pathLabel} to start with test/squads-: ${pathValue}`,
  ).to.equal(true);
  expect(
    pathValue.endsWith('.test.ts'),
    `Expected ${pathLabel} to end with .test.ts: ${pathValue}`,
  ).to.equal(true);
}

function assertSupportSourcePathShape(
  pathValue: string,
  pathLabel: string,
): void {
  expect(
    pathValue.startsWith('test/'),
    `Expected ${pathLabel} to stay test-directory scoped: ${pathValue}`,
  ).to.equal(true);
  expect(
    pathValue.startsWith('test/squads-'),
    `Expected ${pathLabel} to start with test/squads-: ${pathValue}`,
  ).to.equal(true);
  expect(
    pathValue.endsWith('.ts'),
    `Expected ${pathLabel} to end with .ts: ${pathValue}`,
  ).to.equal(true);
  expect(
    pathValue.endsWith('.test.ts'),
    `Expected ${pathLabel} to be source-only (not *.test.ts): ${pathValue}`,
  ).to.equal(false);
}

function assertInfraRegressionCommandTokenSet(
  tokenPaths: readonly string[],
  tokenSetLabel: string,
): void {
  expect(tokenPaths).to.deep.equal([...SQUADS_REGRESSION_TEST_PATHS]);
  expect(new Set(tokenPaths).size).to.equal(tokenPaths.length);
  for (const tokenPath of tokenPaths) {
    assertRegressionTestPathShape(tokenPath, `${tokenSetLabel} token path`);
  }
  assertTrackedSourcePathSetNormalizedAndDeduplicated(
    tokenPaths,
    `${tokenSetLabel} token set`,
  );
}

function partitionTrackedTestAssetsByRole(paths: readonly string[]): {
  readonly regressionPaths: readonly string[];
  readonly supportPaths: readonly string[];
} {
  const regressionPaths: string[] = [];
  const supportPaths: string[] = [];

  for (const pathValue of paths) {
    if (pathValue.endsWith('.test.ts')) {
      regressionPaths.push(pathValue);
      continue;
    }
    supportPaths.push(pathValue);
  }

  return {
    regressionPaths,
    supportPaths,
  };
}

function assertTrackedTestAssetPartitionShape(
  partitionedPaths: {
    readonly regressionPaths: readonly string[];
    readonly supportPaths: readonly string[];
  },
  partitionLabel: string,
): void {
  const { regressionPaths, supportPaths } = partitionedPaths;
  for (const regressionPath of regressionPaths) {
    assertRegressionTestPathShape(
      regressionPath,
      `${partitionLabel} regression-like asset path`,
    );
  }
  for (const supportPath of supportPaths) {
    assertSupportSourcePathShape(
      supportPath,
      `${partitionLabel} support-like asset path`,
    );
  }
  expect(regressionPaths.length).to.equal(SQUADS_REGRESSION_TEST_PATHS.length);
  expect(supportPaths.length).to.equal(
    SQUADS_TRACKED_TEST_SUPPORT_PATHS.length,
  );
}

describe('squads sdk migration regression', () => {
  it('keeps squads script constants immutable', () => {
    expect(Object.isFrozen(SQUADS_SCRIPT_PATHS)).to.equal(true);
    expect(Object.isFrozen(NON_EXECUTABLE_SQUADS_SCRIPT_FILES)).to.equal(true);
    expect(Object.isFrozen(SQUADS_SCRIPT_FILE_EXTENSIONS)).to.equal(true);
    expect(Object.isFrozen(EXECUTABLE_SQUADS_SCRIPT_PATHS)).to.equal(true);
    expect(Object.isFrozen(SQUADS_ERROR_FORMATTING_SCRIPT_PATHS)).to.equal(
      true,
    );
    expect(Object.isFrozen(SQUADS_REGRESSION_TEST_PATHS)).to.equal(true);
    expect(Object.isFrozen(SQUADS_TRACKED_TEST_SUPPORT_PATHS)).to.equal(true);
    expect(Object.isFrozen(SQUADS_TRACKED_TEST_ASSET_PATHS)).to.equal(true);
  });

  it('keeps tracked-source extension policy deduplicated and squads-compatible', () => {
    expect(new Set(SOURCE_FILE_EXTENSIONS).size).to.equal(
      SOURCE_FILE_EXTENSIONS.length,
    );
    for (const extension of SOURCE_FILE_EXTENSIONS) {
      expect(extension.startsWith('.')).to.equal(true);
      expect(extension).to.equal(extension.trim());
      expect(extension).to.equal(extension.toLowerCase());
      expect(extension.includes('/')).to.equal(false);
      expect(extension.includes('\\')).to.equal(false);
    }
    for (const squadsScriptExtension of SQUADS_SCRIPT_FILE_EXTENSIONS) {
      expect(
        SOURCE_FILE_EXTENSIONS.includes(squadsScriptExtension),
        `Expected tracked source extension policy to include squads script extension: ${squadsScriptExtension}`,
      ).to.equal(true);
    }
  });

  it('keeps tracked-source extension helper strict and suffix-based', () => {
    for (const extension of SOURCE_FILE_EXTENSIONS) {
      expect(hasTrackedSourceExtension(`src/example${extension}`)).to.equal(
        true,
      );
    }

    expect(hasTrackedSourceExtension('src/example')).to.equal(false);
    expect(hasTrackedSourceExtension('src/example.ts.bak')).to.equal(false);
    expect(hasTrackedSourceExtension('src/example.TS')).to.equal(false);
    expect(hasTrackedSourceExtension('src/example.ts ')).to.equal(false);
    expect(hasTrackedSourceExtension('src/example.jsx')).to.equal(false);
  });

  it('keeps guarded squads script paths aligned with tracked extension policy', () => {
    const guardedScriptPaths = new Set([
      ...SQUADS_SCRIPT_PATHS,
      ...SQUADS_ERROR_FORMATTING_SCRIPT_PATHS,
    ]);
    for (const scriptPath of guardedScriptPaths) {
      expect(
        hasTrackedSourceExtension(scriptPath),
        `Expected guarded squads script path to match tracked extension policy: ${scriptPath}`,
      ).to.equal(true);
    }
  });

  it('keeps skipped tracked-source directory policy normalized and deduplicated', () => {
    const skippedDirectoryNames = [...SKIPPED_DIRECTORIES];
    expect(new Set(skippedDirectoryNames).size).to.equal(
      skippedDirectoryNames.length,
    );

    for (const skippedDirectoryName of skippedDirectoryNames) {
      expect(skippedDirectoryName.length).to.be.greaterThan(0);
      expect(skippedDirectoryName).to.equal(skippedDirectoryName.trim());
      expect(skippedDirectoryName.includes('/')).to.equal(false);
      expect(skippedDirectoryName.includes('\\')).to.equal(false);
      expect(shouldSkipTrackedSourceDirectory(skippedDirectoryName)).to.equal(
        true,
      );
    }

    expect(
      shouldSkipTrackedSourceDirectory('src'),
      'Expected non-skipped source directory to remain tracked',
    ).to.equal(false);
    expect(shouldSkipTrackedSourceDirectory('node_modules ')).to.equal(false);
    expect(shouldSkipTrackedSourceDirectory('Node_modules')).to.equal(false);
    expect(shouldSkipTrackedSourceDirectory('node_modules/cache')).to.equal(
      false,
    );
  });

  it('keeps guarded squads script path lists valid and deduplicated', () => {
    expect(new Set(SQUADS_SCRIPT_PATHS).size).to.equal(
      SQUADS_SCRIPT_PATHS.length,
    );
    expect(new Set(SQUADS_ERROR_FORMATTING_SCRIPT_PATHS).size).to.equal(
      SQUADS_ERROR_FORMATTING_SCRIPT_PATHS.length,
    );

    for (const scriptPath of SQUADS_SCRIPT_PATHS) {
      const absolutePath = path.join(INFRA_ROOT, scriptPath);
      expect(
        fs.existsSync(absolutePath),
        `Expected guarded script path to exist: ${scriptPath}`,
      ).to.equal(true);
      expect(
        fs.statSync(absolutePath).isFile(),
        `Expected guarded script path to reference a file: ${scriptPath}`,
      ).to.equal(true);
    }

    const squadsScriptSet = new Set(SQUADS_SCRIPT_PATHS);
    for (const scriptPath of SQUADS_ERROR_FORMATTING_SCRIPT_PATHS) {
      expect(
        isGuardedSquadsScriptPath(scriptPath),
        `Expected formatting-guarded script to be in primary squads script list: ${scriptPath}`,
      ).to.equal(true);
    }
    expect(squadsScriptSet.size).to.equal(SQUADS_SCRIPT_PATHS.length);
  });

  it('keeps guarded squads script paths normalized and relative', () => {
    const guardedScriptPaths = new Set([
      ...SQUADS_SCRIPT_PATHS,
      ...SQUADS_ERROR_FORMATTING_SCRIPT_PATHS,
    ]);

    for (const scriptPath of guardedScriptPaths) {
      expect(isNormalizedGuardedScriptPath(scriptPath)).to.equal(true);
    }
  });

  it('keeps guarded squads script list synchronized with scripts/squads directory', () => {
    const discoveredSquadsScripts = listSquadsDirectoryScripts(INFRA_ROOT);
    const configuredSquadsScripts = SQUADS_SCRIPT_PATHS.filter((scriptPath) =>
      isSquadsDirectoryScriptPath(scriptPath),
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
        isFormattingGuardedSquadsScriptPath(scriptPath),
        `Expected formatting-guarded classifier to accept path: ${scriptPath}`,
      ).to.equal(true);
      expect(
        isExecutableSquadsScriptPath(scriptPath),
        `Expected formatting-guarded script path to be executable: ${scriptPath}`,
      ).to.equal(true);
    }
  });

  it('keeps infra squads regression script stable', () => {
    const infraPackageJson = readInfraPackageJson();

    expect(infraPackageJson.scripts?.['test:squads']).to.equal(
      EXPECTED_INFRA_SQUADS_TEST_SCRIPT,
    );
  });

  it('keeps infra squads test command prefix normalized and stable', () => {
    assertCanonicalCliCommandShape(
      INFRA_SQUADS_TEST_COMMAND_PREFIX,
      'infra squads test command prefix',
    );
    expect(
      INFRA_SQUADS_TEST_COMMAND_PREFIX.startsWith('mocha --config '),
    ).to.equal(true);
    expect(
      INFRA_SQUADS_TEST_COMMAND_PREFIX.includes('../sdk/.mocharc.json'),
    ).to.equal(true);
    expect(INFRA_SQUADS_TEST_COMMAND_PREFIX.endsWith(' ')).to.equal(false);
    expect(INFRA_SQUADS_TEST_COMMAND_PREFIX.includes('"')).to.equal(false);
    expect(INFRA_SQUADS_TEST_COMMAND_PREFIX.includes("'")).to.equal(false);
  });

  it('keeps expected infra squads test command derived from regression path list', () => {
    assertCanonicalCliCommandShape(
      EXPECTED_INFRA_SQUADS_TEST_SCRIPT,
      'expected infra squads test command',
    );
    expect(
      EXPECTED_INFRA_SQUADS_TEST_SCRIPT.startsWith(
        `${INFRA_SQUADS_TEST_COMMAND_PREFIX} `,
      ),
    ).to.equal(true);
    expect(EXPECTED_INFRA_SQUADS_TEST_SCRIPT.includes("'")).to.equal(false);
    expect(
      countSubstringOccurrences(EXPECTED_INFRA_SQUADS_TEST_SCRIPT, '"'),
    ).to.equal(SQUADS_REGRESSION_TEST_PATHS.length * 2);
    expect(
      countSubstringOccurrences(
        EXPECTED_INFRA_SQUADS_TEST_SCRIPT,
        INFRA_SQUADS_TEST_COMMAND_PREFIX,
      ),
    ).to.equal(1);
    const quotedScriptPaths = getQuotedInfraSquadsRegressionPaths();
    assertInfraRegressionCommandTokenSet(
      quotedScriptPaths,
      'quoted squads regression command',
    );
    for (const scriptPath of SQUADS_REGRESSION_TEST_PATHS) {
      const quotedScriptPath = `"${scriptPath}"`;
      expect(
        countSubstringOccurrences(
          EXPECTED_INFRA_SQUADS_TEST_SCRIPT,
          quotedScriptPath,
        ),
        `Expected squads test command to include quoted regression path exactly once: ${scriptPath}`,
      ).to.equal(1);
    }
  });

  it('keeps infra squads test command excluding support-module paths', () => {
    const quotedScriptPaths = getQuotedInfraSquadsRegressionPaths();
    assertInfraRegressionCommandTokenSet(
      quotedScriptPaths,
      'quoted squads regression command',
    );
    for (const supportPath of SQUADS_TRACKED_TEST_SUPPORT_PATHS) {
      expect(quotedScriptPaths.includes(supportPath)).to.equal(false);
    }
  });

  it('keeps quoted infra squads regression command tokens isolated from caller mutation', () => {
    const baselineQuotedScriptPaths = getQuotedInfraSquadsRegressionPaths();
    assertInfraRegressionCommandTokenSet(
      baselineQuotedScriptPaths,
      'baseline quoted squads regression command',
    );
    const callerMutatedQuotedScriptPaths = [
      ...getQuotedInfraSquadsRegressionPaths(),
    ];
    callerMutatedQuotedScriptPaths.pop();

    const subsequentQuotedScriptPaths = getQuotedInfraSquadsRegressionPaths();
    expect(callerMutatedQuotedScriptPaths).to.not.deep.equal(
      baselineQuotedScriptPaths,
    );
    assertInfraRegressionCommandTokenSet(
      subsequentQuotedScriptPaths,
      'subsequent quoted squads regression command',
    );
    expect(subsequentQuotedScriptPaths).to.deep.equal(
      baselineQuotedScriptPaths,
    );
    expect(subsequentQuotedScriptPaths).to.not.equal(baselineQuotedScriptPaths);
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
    const trackedSourceFiles = getTrackedSourceFileSnapshot();

    for (const relativePath of trackedSourceFiles) {
      const fileContents = readInfraFile(relativePath);
      assertNoForbiddenSquadsReferences(fileContents, relativePath);
    }
  });

  it('keeps guarded squads script paths included in tracked source scan', () => {
    const trackedSourceFileSet = getTrackedSourceFileSet();
    assertTrackedSourceSetContainsPaths(
      trackedSourceFileSet,
      SQUADS_SCRIPT_PATHS,
      'guarded squads script',
    );
    assertTrackedSourceSetContainsPaths(
      trackedSourceFileSet,
      SQUADS_ERROR_FORMATTING_SCRIPT_PATHS,
      'formatting-guarded squads script',
    );
  });

  it('keeps squads tracked test assets included in tracked source scan', () => {
    const trackedSourceFileSet = getTrackedSourceFileSet();
    assertTrackedSourceSetContainsPaths(
      trackedSourceFileSet,
      SQUADS_TRACKED_TEST_ASSET_PATHS,
      'squads tracked test asset',
    );
  });

  it('keeps squads regression test path set normalized and deduplicated', () => {
    assertTrackedSourcePathSetNormalizedAndDeduplicated(
      SQUADS_REGRESSION_TEST_PATHS,
      'squads regression test',
    );
  });

  it('keeps squads regression test paths constrained to squads test naming', () => {
    for (const regressionTestPath of SQUADS_REGRESSION_TEST_PATHS) {
      assertRegressionTestPathShape(
        regressionTestPath,
        'squads regression test path',
      );
    }
  });

  it('keeps squads tracked test path sets disjoint and fully represented', () => {
    const regressionTestPathSet = new Set(SQUADS_REGRESSION_TEST_PATHS);
    const supportPathSet = new Set(SQUADS_TRACKED_TEST_SUPPORT_PATHS);
    const allTestAssetPathSet = new Set(SQUADS_TRACKED_TEST_ASSET_PATHS);

    for (const regressionTestPath of regressionTestPathSet) {
      expect(supportPathSet.has(regressionTestPath)).to.equal(false);
    }
    expect(allTestAssetPathSet.size).to.equal(
      regressionTestPathSet.size + supportPathSet.size,
    );
  });

  it('keeps squads tracked test-asset ordering composed from regression then support paths', () => {
    expect(SQUADS_TRACKED_TEST_ASSET_PATHS).to.deep.equal([
      ...SQUADS_REGRESSION_TEST_PATHS,
      ...SQUADS_TRACKED_TEST_SUPPORT_PATHS,
    ]);
  });

  it('keeps squads test-support path set normalized and deduplicated', () => {
    assertTrackedSourcePathSetNormalizedAndDeduplicated(
      SQUADS_TRACKED_TEST_SUPPORT_PATHS,
      'squads test-support',
    );
  });

  it('keeps squads test-support paths source-only and squads-scoped', () => {
    for (const supportPath of SQUADS_TRACKED_TEST_SUPPORT_PATHS) {
      assertSupportSourcePathShape(supportPath, 'squads test-support path');
    }
  });

  it('keeps squads tracked test-asset path set normalized and deduplicated', () => {
    assertTrackedSourcePathSetNormalizedAndDeduplicated(
      SQUADS_TRACKED_TEST_ASSET_PATHS,
      'squads tracked test-asset',
    );
  });

  it('keeps squads tracked test assets scoped to test directory', () => {
    assertTrackedTestAssetPartitionShape(
      partitionTrackedTestAssetsByRole(SQUADS_TRACKED_TEST_ASSET_PATHS),
      'squads tracked scoped',
    );
  });

  it('keeps squads tracked test assets partitioned between regression and support path shapes', () => {
    const partitionedPaths = partitionTrackedTestAssetsByRole(
      SQUADS_TRACKED_TEST_ASSET_PATHS,
    );
    assertTrackedTestAssetPartitionShape(
      partitionedPaths,
      'squads tracked partitioned',
    );
  });

  it('keeps tracked test-asset partition helper isolated from caller mutation', () => {
    const baselinePartition = partitionTrackedTestAssetsByRole(
      SQUADS_TRACKED_TEST_ASSET_PATHS,
    );
    const callerMutatedPartition = partitionTrackedTestAssetsByRole(
      SQUADS_TRACKED_TEST_ASSET_PATHS,
    );
    const mutableRegressionPaths = [...callerMutatedPartition.regressionPaths];
    mutableRegressionPaths.pop();

    const subsequentPartition = partitionTrackedTestAssetsByRole(
      SQUADS_TRACKED_TEST_ASSET_PATHS,
    );
    assertTrackedTestAssetPartitionShape(
      baselinePartition,
      'baseline squads tracked partition',
    );
    assertTrackedTestAssetPartitionShape(
      subsequentPartition,
      'subsequent squads tracked partition',
    );
    expect(mutableRegressionPaths).to.not.deep.equal(
      baselinePartition.regressionPaths,
    );
    expect(subsequentPartition.regressionPaths).to.deep.equal(
      baselinePartition.regressionPaths,
    );
    expect(subsequentPartition.supportPaths).to.deep.equal(
      baselinePartition.supportPaths,
    );
    expect(subsequentPartition.regressionPaths).to.not.equal(
      baselinePartition.regressionPaths,
    );
    expect(subsequentPartition.supportPaths).to.not.equal(
      baselinePartition.supportPaths,
    );
  });

  it('keeps tracked infra source file scan ordering deterministic', () => {
    const trackedSourceFiles = getTrackedSourceFileSnapshot();
    expect(trackedSourceFiles).to.deep.equal(
      [...trackedSourceFiles].sort(compareLexicographically),
    );
  });

  it('keeps tracked infra source file scan stable across repeated reads', () => {
    const firstTrackedSourceFiles = getTrackedSourceFileSnapshot();
    const secondTrackedSourceFiles = getTrackedSourceFileSnapshot();

    expect(firstTrackedSourceFiles).to.not.equal(secondTrackedSourceFiles);
    expect(firstTrackedSourceFiles).to.deep.equal(secondTrackedSourceFiles);
  });

  it('keeps tracked infra source file scan isolated from caller mutation', () => {
    const baselineTrackedSourceFiles = getTrackedSourceFileSnapshot();
    const callerMutatedTrackedSourceFiles = [...getTrackedSourceFileSnapshot()];
    callerMutatedTrackedSourceFiles.pop();

    const subsequentTrackedSourceFiles = getTrackedSourceFileSnapshot();
    expect(callerMutatedTrackedSourceFiles).to.not.deep.equal(
      baselineTrackedSourceFiles,
    );
    expect(subsequentTrackedSourceFiles).to.deep.equal(
      baselineTrackedSourceFiles,
    );
  });

  it('keeps tracked infra source file scan non-empty and deduplicated', () => {
    const trackedSourceFiles = getTrackedSourceFileSnapshot();
    expect(trackedSourceFiles.length).to.be.greaterThan(0);
    expect(new Set(trackedSourceFiles).size).to.equal(
      trackedSourceFiles.length,
    );
  });

  it('keeps tracked infra source file scan entries resolvable to files', () => {
    const trackedSourceFiles = getTrackedSourceFileSnapshot();
    for (const trackedSourceFilePath of trackedSourceFiles) {
      const absoluteTrackedSourceFilePath = path.join(
        INFRA_ROOT,
        trackedSourceFilePath,
      );
      expect(
        fs.existsSync(absoluteTrackedSourceFilePath),
        `Expected tracked source file to exist: ${trackedSourceFilePath}`,
      ).to.equal(true);
      expect(
        fs.statSync(absoluteTrackedSourceFilePath).isFile(),
        `Expected tracked source path to resolve to file: ${trackedSourceFilePath}`,
      ).to.equal(true);
    }
  });

  it('keeps tracked infra source file paths normalized and relative', () => {
    const trackedSourceFiles = getTrackedSourceFileSnapshot();
    for (const trackedSourceFilePath of trackedSourceFiles) {
      expect(
        isNormalizedTrackedSourceRelativePath(trackedSourceFilePath),
        `Expected tracked source file path to be normalized and relative: ${trackedSourceFilePath}`,
      ).to.equal(true);
    }
  });

  it('rejects malformed tracked-source relative path candidates', () => {
    expect(isNormalizedTrackedSourceRelativePath('')).to.equal(false);
    expect(isNormalizedTrackedSourceRelativePath('./scripts/file.ts')).to.equal(
      false,
    );
    expect(isNormalizedTrackedSourceRelativePath('/scripts/file.ts')).to.equal(
      false,
    );
    expect(
      isNormalizedTrackedSourceRelativePath('scripts//nested/file.ts'),
    ).to.equal(false);
    expect(
      isNormalizedTrackedSourceRelativePath('scripts/../nested/file.ts'),
    ).to.equal(false);
    expect(
      isNormalizedTrackedSourceRelativePath('scripts\\nested\\file.ts'),
    ).to.equal(false);
    expect(isNormalizedTrackedSourceRelativePath(' scripts/file.ts')).to.equal(
      false,
    );
  });

  it('normalizes tracked-source paths to posix separators', () => {
    expect(toPosixPath('scripts/squads/read-proposal.ts')).to.equal(
      'scripts/squads/read-proposal.ts',
    );
    expect(toPosixPath('scripts\\squads\\read-proposal.ts')).to.equal(
      'scripts/squads/read-proposal.ts',
    );
    expect(toPosixPath('scripts/squads\\read-proposal.ts')).to.equal(
      'scripts/squads/read-proposal.ts',
    );
  });

  it('keeps tracked infra source file paths constrained to tracked extensions', () => {
    const trackedSourceFiles = getTrackedSourceFileSnapshot();
    for (const trackedSourceFilePath of trackedSourceFiles) {
      expect(
        hasTrackedSourceExtension(trackedSourceFilePath),
        `Expected tracked source file path to match tracked extension policy: ${trackedSourceFilePath}`,
      ).to.equal(true);
    }
  });

  it('keeps tracked infra source file scan excluding skipped directories', () => {
    const trackedSourceFiles = getTrackedSourceFileSnapshot();
    for (const trackedSourceFilePath of trackedSourceFiles) {
      for (const skippedDirectory of SKIPPED_DIRECTORIES) {
        const skippedSegment = `/${skippedDirectory}/`;
        expect(
          trackedSourceFilePath.includes(skippedSegment),
          `Expected tracked source scan to skip directory segment "${skippedSegment}" in: ${trackedSourceFilePath}`,
        ).to.equal(false);
        expect(
          trackedSourceFilePath.startsWith(`${skippedDirectory}/`),
          `Expected tracked source scan to skip leading directory "${skippedDirectory}" in: ${trackedSourceFilePath}`,
        ).to.equal(false);
      }
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
