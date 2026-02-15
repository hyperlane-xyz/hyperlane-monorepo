import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import {
  BUILTIN_SQUADS_ERROR_LABELS,
  DEFAULT_SQUADS_ERROR_PLACEHOLDER,
  SquadsTransactionReader,
  getSquadsChains,
  normalizeStringifiedSquadsError,
  squadsConfigs,
  stringifyUnknownSquadsError,
} from './index.js';
import { SquadsTransactionReader as DirectSquadsTransactionReader } from './transaction-reader.js';
import {
  BUILTIN_SQUADS_ERROR_LABELS as directBuiltinSquadsErrorLabels,
  DEFAULT_SQUADS_ERROR_PLACEHOLDER as directDefaultSquadsErrorPlaceholder,
  normalizeStringifiedSquadsError as directNormalizeStringifiedSquadsError,
  stringifyUnknownSquadsError as directStringifyUnknownSquadsError,
} from './error-format.js';
import {
  getSquadsChains as directGetSquadsChains,
  squadsConfigs as directSquadsConfigs,
} from './config.js';

const SDK_SQUADS_SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT_INDEX_PATH = path.resolve(
  SDK_SQUADS_SOURCE_DIR,
  '..',
  'index.ts',
);
const SQUADS_BARREL_INDEX_PATH = path.resolve(
  SDK_SQUADS_SOURCE_DIR,
  'index.ts',
);
const SDK_PACKAGE_JSON_PATH = path.resolve(
  SDK_SQUADS_SOURCE_DIR,
  '..',
  '..',
  'package.json',
);
const SDK_SQUADS_TEST_COMMAND_PREFIX = 'mocha --config .mocharc.json';
const SDK_SQUADS_TEST_GLOB = 'src/squads/*.test.ts';
const SDK_SQUADS_TEST_TOKEN_PATHS = Object.freeze([SDK_SQUADS_TEST_GLOB]);
const EXPECTED_SDK_SQUADS_TEST_SCRIPT = `${SDK_SQUADS_TEST_COMMAND_PREFIX} ${SDK_SQUADS_TEST_TOKEN_PATHS.map((tokenPath) => `'${tokenPath}'`).join(' ')}`;
const SINGLE_QUOTED_SCRIPT_TOKEN_PATTERN = /'([^']+)'/g;
function compareLexicographically(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

function listSingleQuotedTokens(command: string): readonly string[] {
  return [...command.matchAll(SINGLE_QUOTED_SCRIPT_TOKEN_PATTERN)].map(
    (match) => match[1],
  );
}

function getQuotedSdkSquadsTestTokens(): readonly string[] {
  return listSingleQuotedTokens(EXPECTED_SDK_SQUADS_TEST_SCRIPT);
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

function assertSdkSquadsTestTokenShape(
  token: string,
  tokenLabel: string,
): void {
  expect(
    token.startsWith('src/'),
    `Expected ${tokenLabel} to start with src/: ${token}`,
  ).to.equal(true);
  expect(
    token.startsWith('test/'),
    `Expected ${tokenLabel} to avoid test/ prefix: ${token}`,
  ).to.equal(false);
  expect(
    token.startsWith('/'),
    `Expected ${tokenLabel} to be relative: ${token}`,
  ).to.equal(false);
  expect(
    token.includes('..'),
    `Expected ${tokenLabel} to avoid parent traversal: ${token}`,
  ).to.equal(false);
  expect(
    token.includes('\\'),
    `Expected ${tokenLabel} to avoid backslash separators: ${token}`,
  ).to.equal(false);
  expect(token, `Expected ${tokenLabel} to be trimmed: ${token}`).to.equal(
    token.trim(),
  );
  expect(
    /\s/.test(token),
    `Expected ${tokenLabel} to avoid whitespace characters: ${token}`,
  ).to.equal(false);
  expect(
    token,
    `Expected ${tokenLabel} to remain normalized: ${token}`,
  ).to.equal(path.posix.normalize(token));
  expect(
    token.includes('/squads/'),
    `Expected ${tokenLabel} to stay squads-scoped: ${token}`,
  ).to.equal(true);
  expect(
    token.endsWith('.test.ts'),
    `Expected ${tokenLabel} to stay test-file scoped: ${token}`,
  ).to.equal(true);
}

function assertSdkSquadsTokenPathSetNormalizedAndDeduplicated(
  tokenPaths: readonly string[],
  tokenSetLabel: string,
): void {
  expect(tokenPaths).to.deep.equal(
    [...tokenPaths].sort(compareLexicographically),
  );
  expect(new Set(tokenPaths).size).to.equal(tokenPaths.length);
  for (const tokenPath of tokenPaths) {
    assertSdkSquadsTestTokenShape(tokenPath, `${tokenSetLabel} token path`);
  }
}

function assertSdkQuotedCommandTokenSet(
  tokenPaths: readonly string[],
  tokenSetLabel: string,
): void {
  expect(tokenPaths).to.deep.equal([...SDK_SQUADS_TEST_TOKEN_PATHS]);
  assertSdkSquadsTokenPathSetNormalizedAndDeduplicated(
    tokenPaths,
    tokenSetLabel,
  );
  for (const tokenPath of tokenPaths) {
    expect(
      countOccurrences(EXPECTED_SDK_SQUADS_TEST_SCRIPT, `'${tokenPath}'`),
      `Expected ${tokenSetLabel} token path to appear exactly once in command: ${tokenPath}`,
    ).to.equal(1);
  }
}

function listSdkSquadsTestFilePaths(): readonly string[] {
  const directoryEntries = fs
    .readdirSync(SDK_SQUADS_SOURCE_DIR, { withFileTypes: true })
    .sort((left, right) => compareLexicographically(left.name, right.name));
  return directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => `src/squads/${entry.name}`);
}

function listSdkSquadsNonTestSourceFilePaths(): readonly string[] {
  const directoryEntries = fs
    .readdirSync(SDK_SQUADS_SOURCE_DIR, { withFileTypes: true })
    .sort((left, right) => compareLexicographically(left.name, right.name));
  return directoryEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => `src/squads/${entry.name}`);
}

function listSdkSquadsTestFilePathsRecursively(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string = '',
): readonly string[] {
  const directoryEntries = fs
    .readdirSync(absoluteDirectoryPath, { withFileTypes: true })
    .sort((left, right) => compareLexicographically(left.name, right.name));
  const discoveredTestPaths: string[] = [];

  for (const entry of directoryEntries) {
    const nextRelativePath =
      relativeDirectoryPath.length === 0
        ? entry.name
        : path.posix.join(relativeDirectoryPath, entry.name);
    const nextAbsolutePath = path.join(absoluteDirectoryPath, entry.name);

    if (entry.isDirectory()) {
      discoveredTestPaths.push(
        ...listSdkSquadsTestFilePathsRecursively(
          nextAbsolutePath,
          nextRelativePath,
        ),
      );
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      discoveredTestPaths.push(`src/squads/${nextRelativePath}`);
    }
  }

  return discoveredTestPaths.sort(compareLexicographically);
}

function listSdkSquadsNonTestSourceFilePathsRecursively(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string = '',
): readonly string[] {
  const directoryEntries = fs
    .readdirSync(absoluteDirectoryPath, { withFileTypes: true })
    .sort((left, right) => compareLexicographically(left.name, right.name));
  const discoveredNonTestSourcePaths: string[] = [];

  for (const entry of directoryEntries) {
    const nextRelativePath =
      relativeDirectoryPath.length === 0
        ? entry.name
        : path.posix.join(relativeDirectoryPath, entry.name);
    const nextAbsolutePath = path.join(absoluteDirectoryPath, entry.name);

    if (entry.isDirectory()) {
      discoveredNonTestSourcePaths.push(
        ...listSdkSquadsNonTestSourceFilePathsRecursively(
          nextAbsolutePath,
          nextRelativePath,
        ),
      );
      continue;
    }

    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      discoveredNonTestSourcePaths.push(`src/squads/${nextRelativePath}`);
    }
  }

  return discoveredNonTestSourcePaths.sort(compareLexicographically);
}

function matchesSingleAsteriskGlob(
  candidatePath: string,
  globPattern: string,
): boolean {
  const wildcardIndex = globPattern.indexOf('*');
  expect(
    wildcardIndex,
    `Expected sdk squads test glob to contain wildcard: ${globPattern}`,
  ).to.not.equal(-1);
  expect(
    globPattern.indexOf('*', wildcardIndex + 1),
    `Expected sdk squads test glob to contain a single wildcard: ${globPattern}`,
  ).to.equal(-1);

  const prefix = globPattern.slice(0, wildcardIndex);
  const suffix = globPattern.slice(wildcardIndex + 1);
  return (
    candidatePath.startsWith(prefix) &&
    candidatePath.endsWith(suffix) &&
    candidatePath.length >= prefix.length + suffix.length
  );
}

describe('squads barrel exports', () => {
  it('keeps sdk squads test command constants normalized and scoped', () => {
    assertCanonicalCliCommandShape(
      SDK_SQUADS_TEST_COMMAND_PREFIX,
      'sdk squads test command prefix',
    );
    expect(
      SDK_SQUADS_TEST_COMMAND_PREFIX.startsWith('mocha --config '),
    ).to.equal(true);
    expect(SDK_SQUADS_TEST_COMMAND_PREFIX.includes('.mocharc.json')).to.equal(
      true,
    );
    expect(SDK_SQUADS_TEST_COMMAND_PREFIX.endsWith(' ')).to.equal(false);
    expect(SDK_SQUADS_TEST_COMMAND_PREFIX.includes('"')).to.equal(false);
    expect(SDK_SQUADS_TEST_COMMAND_PREFIX.includes("'")).to.equal(false);
    expect(Object.isFrozen(SDK_SQUADS_TEST_TOKEN_PATHS)).to.equal(true);
    expect(SDK_SQUADS_TEST_TOKEN_PATHS).to.deep.equal([SDK_SQUADS_TEST_GLOB]);
    assertSdkSquadsTokenPathSetNormalizedAndDeduplicated(
      SDK_SQUADS_TEST_TOKEN_PATHS,
      'sdk squads test-token constant set',
    );
  });

  it('re-exports squads config/constants', () => {
    expect(squadsConfigs).to.equal(directSquadsConfigs);
    expect(getSquadsChains).to.equal(directGetSquadsChains);
  });

  it('re-exports squads transaction reader', () => {
    expect(SquadsTransactionReader).to.equal(DirectSquadsTransactionReader);
  });

  it('re-exports squads error format helpers', () => {
    expect(stringifyUnknownSquadsError).to.equal(
      directStringifyUnknownSquadsError,
    );
    expect(normalizeStringifiedSquadsError).to.equal(
      directNormalizeStringifiedSquadsError,
    );
    expect(BUILTIN_SQUADS_ERROR_LABELS).to.equal(
      directBuiltinSquadsErrorLabels,
    );
    expect(DEFAULT_SQUADS_ERROR_PLACEHOLDER).to.equal(
      directDefaultSquadsErrorPlaceholder,
    );
  });

  it('keeps squads barrel wired through sdk root index source', () => {
    const rootIndexSource = fs.readFileSync(SDK_ROOT_INDEX_PATH, 'utf8');
    const squadsExportStatement = "export * from './squads/index.js';";
    expect(rootIndexSource).to.include(squadsExportStatement);
    expect(countOccurrences(rootIndexSource, squadsExportStatement)).to.equal(
      1,
    );
  });

  it('keeps sdk root index squads exports routed only through squads barrel', () => {
    const rootIndexSource = fs.readFileSync(SDK_ROOT_INDEX_PATH, 'utf8');
    const directSquadsSubmoduleStatements = [
      "export * from './squads/config.js';",
      "export * from './squads/utils.js';",
      "export * from './squads/transaction-reader.js';",
      "export * from './squads/error-format.js';",
    ] as const;

    for (const statement of directSquadsSubmoduleStatements) {
      expect(rootIndexSource.includes(statement)).to.equal(false);
    }
  });

  it('keeps sdk root index with a single squads export statement', () => {
    const rootIndexSource = fs.readFileSync(SDK_ROOT_INDEX_PATH, 'utf8');
    const squadsExportStatements = rootIndexSource
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) => line.startsWith('export') && line.includes("from './squads/"),
      );

    expect(squadsExportStatements).to.deep.equal([
      "export * from './squads/index.js';",
    ]);
  });

  it('keeps sdk root index free of non-export squads references', () => {
    const rootIndexSource = fs.readFileSync(SDK_ROOT_INDEX_PATH, 'utf8');
    const squadsReferenceLines = rootIndexSource
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes("from './squads/"));

    expect(squadsReferenceLines).to.deep.equal([
      "export * from './squads/index.js';",
    ]);
    expect(countOccurrences(rootIndexSource, './squads/')).to.equal(1);
  });

  it('keeps expected squads submodule exports in squads barrel source', () => {
    const squadsBarrelSource = fs.readFileSync(
      SQUADS_BARREL_INDEX_PATH,
      'utf8',
    );
    const expectedSubmoduleExportStatements = [
      "export * from './config.js';",
      "export * from './utils.js';",
      "export * from './transaction-reader.js';",
      "export * from './error-format.js';",
    ] as const;

    for (const statement of expectedSubmoduleExportStatements) {
      expect(squadsBarrelSource).to.include(statement);
      expect(countOccurrences(squadsBarrelSource, statement)).to.equal(1);
    }
  });

  it('keeps squads barrel export statement set exact and ordered', () => {
    const squadsBarrelSource = fs.readFileSync(
      SQUADS_BARREL_INDEX_PATH,
      'utf8',
    );
    const exportStatements = squadsBarrelSource
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('export * from'));

    expect(exportStatements).to.deep.equal([
      "export * from './config.js';",
      "export * from './utils.js';",
      "export * from './transaction-reader.js';",
      "export * from './error-format.js';",
    ]);
  });

  it('keeps squads barrel free of non-export local references', () => {
    const squadsBarrelSource = fs.readFileSync(
      SQUADS_BARREL_INDEX_PATH,
      'utf8',
    );
    const localReferenceLines = squadsBarrelSource
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes("from './"));

    expect(localReferenceLines).to.deep.equal([
      "export * from './config.js';",
      "export * from './utils.js';",
      "export * from './transaction-reader.js';",
      "export * from './error-format.js';",
    ]);
    expect(countOccurrences(squadsBarrelSource, "from './")).to.equal(4);
  });

  it('keeps sdk package explicitly depending on @sqds/multisig', () => {
    const sdkPackageJson = JSON.parse(
      fs.readFileSync(SDK_PACKAGE_JSON_PATH, 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      exports?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(sdkPackageJson.dependencies?.['@sqds/multisig']).to.not.equal(
      undefined,
    );
    expect(sdkPackageJson.dependencies?.['@sqds/multisig']).to.equal(
      'catalog:',
    );
    expect(sdkPackageJson.devDependencies?.['@sqds/multisig']).to.equal(
      undefined,
    );
    expect(sdkPackageJson.scripts?.['test:squads']).to.equal(
      EXPECTED_SDK_SQUADS_TEST_SCRIPT,
    );
    assertCanonicalCliCommandShape(
      EXPECTED_SDK_SQUADS_TEST_SCRIPT,
      'expected sdk squads test command',
    );
    expect(
      EXPECTED_SDK_SQUADS_TEST_SCRIPT.startsWith(
        `${SDK_SQUADS_TEST_COMMAND_PREFIX} `,
      ),
    ).to.equal(true);
    expect(EXPECTED_SDK_SQUADS_TEST_SCRIPT.includes('"')).to.equal(false);
    expect(countOccurrences(EXPECTED_SDK_SQUADS_TEST_SCRIPT, "'")).to.equal(
      SDK_SQUADS_TEST_TOKEN_PATHS.length * 2,
    );
    expect(
      countOccurrences(
        EXPECTED_SDK_SQUADS_TEST_SCRIPT,
        SDK_SQUADS_TEST_COMMAND_PREFIX,
      ),
    ).to.equal(1);
    expect(
      EXPECTED_SDK_SQUADS_TEST_SCRIPT.includes('typescript/infra'),
    ).to.equal(false);
    const quotedTestTokens = getQuotedSdkSquadsTestTokens();
    assertSdkQuotedCommandTokenSet(
      quotedTestTokens,
      'quoted sdk squads test command',
    );
    expect(sdkPackageJson.exports?.['.']).to.equal('./dist/index.js');
    expect(sdkPackageJson.exports?.['./squads']).to.equal(undefined);
    expect(sdkPackageJson.exports?.['./squads/*']).to.equal(undefined);
    const sdkExportKeys = Object.keys(sdkPackageJson.exports ?? {});
    expect(sdkExportKeys).to.deep.equal(['.']);
    expect(
      sdkExportKeys.some((exportKey) => exportKey.startsWith('./squads')),
    ).to.equal(false);
  });

  it('keeps quoted sdk squads command tokens isolated from caller mutation', () => {
    const baselineQuotedTokens = getQuotedSdkSquadsTestTokens();
    assertSdkQuotedCommandTokenSet(
      baselineQuotedTokens,
      'baseline quoted sdk squads command',
    );
    const callerMutatedQuotedTokens = [...getQuotedSdkSquadsTestTokens()];
    callerMutatedQuotedTokens.pop();

    const subsequentQuotedTokens = getQuotedSdkSquadsTestTokens();
    expect(callerMutatedQuotedTokens).to.not.deep.equal(baselineQuotedTokens);
    assertSdkQuotedCommandTokenSet(
      subsequentQuotedTokens,
      'subsequent quoted sdk squads command',
    );
    expect(subsequentQuotedTokens).to.deep.equal(baselineQuotedTokens);
    expect(subsequentQuotedTokens).to.not.equal(baselineQuotedTokens);
  });

  it('keeps sdk squads token-path constants isolated from caller mutation', () => {
    const baselineTokenPaths = [...SDK_SQUADS_TEST_TOKEN_PATHS];
    assertSdkSquadsTokenPathSetNormalizedAndDeduplicated(
      baselineTokenPaths,
      'baseline sdk squads token-path constants',
    );
    const callerMutatedTokenPaths = [...SDK_SQUADS_TEST_TOKEN_PATHS];
    callerMutatedTokenPaths.pop();

    const subsequentTokenPaths = [...SDK_SQUADS_TEST_TOKEN_PATHS];
    assertSdkSquadsTokenPathSetNormalizedAndDeduplicated(
      subsequentTokenPaths,
      'subsequent sdk squads token-path constants',
    );
    expect(callerMutatedTokenPaths).to.not.deep.equal(baselineTokenPaths);
    expect(subsequentTokenPaths).to.deep.equal(baselineTokenPaths);
  });

  it('keeps sdk squads test globs aligned with discovered squads test files', () => {
    const discoveredSquadsTestPaths = listSdkSquadsTestFilePaths();
    expect(
      discoveredSquadsTestPaths.length,
      'Expected at least one discovered sdk squads test file',
    ).to.be.greaterThan(0);

    for (const discoveredPath of discoveredSquadsTestPaths) {
      assertSdkSquadsTestTokenShape(
        discoveredPath,
        'discovered sdk squads test file path',
      );
      expect(
        SDK_SQUADS_TEST_TOKEN_PATHS.some((globPattern) =>
          matchesSingleAsteriskGlob(discoveredPath, globPattern),
        ),
        `Expected discovered sdk squads test file to be covered by command glob: ${discoveredPath}`,
      ).to.equal(true);
    }

    for (const globPattern of SDK_SQUADS_TEST_TOKEN_PATHS) {
      const matchingDiscoveredPaths = discoveredSquadsTestPaths.filter(
        (pathValue) => matchesSingleAsteriskGlob(pathValue, globPattern),
      );
      expect(
        matchingDiscoveredPaths.length,
        `Expected sdk squads test glob to match at least one discovered squads test file: ${globPattern}`,
      ).to.be.greaterThan(0);
    }
  });

  it('keeps sdk squads test globs excluding non-test squads source files', () => {
    const nonTestSquadsSourcePaths = listSdkSquadsNonTestSourceFilePaths();
    expect(
      nonTestSquadsSourcePaths.length,
      'Expected at least one sdk squads non-test source file',
    ).to.be.greaterThan(0);

    for (const nonTestPath of nonTestSquadsSourcePaths) {
      expect(nonTestPath.startsWith('src/')).to.equal(true);
      expect(nonTestPath.includes('/squads/')).to.equal(true);
      expect(nonTestPath.endsWith('.ts')).to.equal(true);
      expect(nonTestPath.endsWith('.test.ts')).to.equal(false);
      expect(
        SDK_SQUADS_TEST_TOKEN_PATHS.some((globPattern) =>
          matchesSingleAsteriskGlob(nonTestPath, globPattern),
        ),
        `Expected sdk squads test command glob to exclude non-test source path: ${nonTestPath}`,
      ).to.equal(false);
    }
  });

  it('keeps sdk squads test files flat for non-recursive squads test glob', () => {
    const topLevelDiscoveredTestPaths = listSdkSquadsTestFilePaths();
    const recursivelyDiscoveredTestPaths =
      listSdkSquadsTestFilePathsRecursively(SDK_SQUADS_SOURCE_DIR);
    expect(recursivelyDiscoveredTestPaths.length).to.be.greaterThan(0);
    expect(topLevelDiscoveredTestPaths).to.deep.equal(
      recursivelyDiscoveredTestPaths,
    );
  });

  it('keeps sdk squads non-test sources flat for top-level discovery helper', () => {
    const topLevelDiscoveredNonTestSourcePaths =
      listSdkSquadsNonTestSourceFilePaths();
    const recursivelyDiscoveredNonTestSourcePaths =
      listSdkSquadsNonTestSourceFilePathsRecursively(SDK_SQUADS_SOURCE_DIR);
    expect(recursivelyDiscoveredNonTestSourcePaths.length).to.be.greaterThan(0);
    expect(topLevelDiscoveredNonTestSourcePaths).to.deep.equal(
      recursivelyDiscoveredNonTestSourcePaths,
    );
  });
});
