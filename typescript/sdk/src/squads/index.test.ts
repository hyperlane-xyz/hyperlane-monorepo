import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import {
  BUILTIN_SQUADS_ERROR_LABELS,
  DEFAULT_SQUADS_ERROR_PLACEHOLDER,
  SquadsTransactionReader,
  getSquadsChains,
  getSquadsKeysForResolvedChain,
  resolveSquadsChainName,
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
  getSquadsKeysForResolvedChain as directGetSquadsKeysForResolvedChain,
  resolveSquadsChainName as directResolveSquadsChainName,
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
const SDK_PACKAGE_ROOT = path.resolve(SDK_SQUADS_SOURCE_DIR, '..', '..');
const SDK_PACKAGE_JSON_PATH = path.resolve(
  SDK_SQUADS_SOURCE_DIR,
  '..',
  '..',
  'package.json',
);
const SDK_SQUADS_TEST_COMMAND_PREFIX = 'mocha --config .mocharc.json';
const SDK_SQUADS_TEST_GLOB = 'src/squads/*.test.ts';
const SDK_SQUADS_TEST_TOKEN_PATHS = Object.freeze([SDK_SQUADS_TEST_GLOB]);
const EXPECTED_SDK_SQUADS_TEST_FILE_PATHS = Object.freeze([
  'src/squads/config.test.ts',
  'src/squads/error-format.test.ts',
  'src/squads/index.test.ts',
  'src/squads/provider.test.ts',
  'src/squads/transaction-reader.test.ts',
  'src/squads/utils.test.ts',
]);
const EXPECTED_SDK_SQUADS_TEST_SCRIPT = `${SDK_SQUADS_TEST_COMMAND_PREFIX} ${SDK_SQUADS_TEST_TOKEN_PATHS.map((tokenPath) => `'${tokenPath}'`).join(' ')}`;
const EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS = Object.freeze([
  "export * from './config.js';",
  "export * from './utils.js';",
  "export * from './transaction-reader.js';",
  "export * from './error-format.js';",
]);
const EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS = Object.freeze([
  'src/squads/config.ts',
  'src/squads/error-format.ts',
  'src/squads/transaction-reader.ts',
  'src/squads/utils.ts',
]);
const SDK_SQUADS_INDEX_SOURCE_PATH = 'src/squads/index.ts';
const EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS = Object.freeze([
  'src/squads/provider.ts',
  'src/squads/validation.ts',
]);
const INFRA_REFERENCE_PATTERN =
  /(?:@hyperlane-xyz\/infra|typescript\/infra|(?:\.\.\/)+infra\/)/;
const FILESYSTEM_IMPORT_PATTERN =
  /(?:from\s+['"](?:node:)?(?:fs|path)(?:\/[^'"]*)?['"]|import\(\s*['"](?:node:)?(?:fs|path)(?:\/[^'"]*)?['"]\s*\)|require\(\s*['"](?:node:)?(?:fs|path)(?:\/[^'"]*)?['"]\s*\))/;
const PROCESS_ENV_REFERENCE_PATTERN = /\bprocess\.env\b/;
const PROCESS_ARGV_REFERENCE_PATTERN = /\bprocess\.argv\b/;
const PROCESS_CWD_REFERENCE_PATTERN = /\bprocess\.cwd\s*\(/;
const PROCESS_EXIT_REFERENCE_PATTERN = /\bprocess\.exit\s*\(/;
const PROCESS_STDIN_REFERENCE_PATTERN = /\bprocess\.stdin\b/;
const PROCESS_STDOUT_REFERENCE_PATTERN = /\bprocess\.stdout\b/;
const PROCESS_STDERR_REFERENCE_PATTERN = /\bprocess\.stderr\b/;
const CLI_GLUE_IMPORT_PATTERN =
  /(?:from\s+['"](?:yargs|chalk|@inquirer\/prompts|cli-table3)['"]|import\(\s*['"](?:yargs|chalk|@inquirer\/prompts|cli-table3)['"]\s*\)|require\(\s*['"](?:yargs|chalk|@inquirer\/prompts|cli-table3)['"]\s*\))/;
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

function assertSdkSquadsNonTestSourcePathShape(
  sourcePath: string,
  sourcePathLabel: string,
): void {
  expect(
    sourcePath.startsWith('src/'),
    `Expected ${sourcePathLabel} to start with src/: ${sourcePath}`,
  ).to.equal(true);
  expect(
    sourcePath.includes('/squads/'),
    `Expected ${sourcePathLabel} to stay squads-scoped: ${sourcePath}`,
  ).to.equal(true);
  expect(
    sourcePath.endsWith('.ts'),
    `Expected ${sourcePathLabel} to end with .ts: ${sourcePath}`,
  ).to.equal(true);
  expect(
    sourcePath.endsWith('.test.ts'),
    `Expected ${sourcePathLabel} to remain non-test scoped: ${sourcePath}`,
  ).to.equal(false);
  expect(
    sourcePath.startsWith('/'),
    `Expected ${sourcePathLabel} to be relative: ${sourcePath}`,
  ).to.equal(false);
  expect(
    sourcePath.includes('..'),
    `Expected ${sourcePathLabel} to avoid parent traversal: ${sourcePath}`,
  ).to.equal(false);
  expect(
    sourcePath.includes('\\'),
    `Expected ${sourcePathLabel} to avoid backslash separators: ${sourcePath}`,
  ).to.equal(false);
  expect(
    /\s/.test(sourcePath),
    `Expected ${sourcePathLabel} to avoid whitespace characters: ${sourcePath}`,
  ).to.equal(false);
  expect(
    sourcePath,
    `Expected ${sourcePathLabel} to remain normalized: ${sourcePath}`,
  ).to.equal(path.posix.normalize(sourcePath));
}

function assertSingleAsteriskGlobShape(
  globPattern: string,
  globLabel: string,
): void {
  expect(globPattern, `Expected ${globLabel} to be trimmed`).to.equal(
    globPattern.trim(),
  );
  expect(
    globPattern.includes('\\'),
    `Expected ${globLabel} to avoid backslash separators: ${globPattern}`,
  ).to.equal(false);
  expect(
    /\s/.test(globPattern),
    `Expected ${globLabel} to avoid whitespace characters: ${globPattern}`,
  ).to.equal(false);
  const wildcardIndex = globPattern.indexOf('*');
  expect(
    wildcardIndex,
    `Expected ${globLabel} to include wildcard segment: ${globPattern}`,
  ).to.not.equal(-1);
  expect(
    globPattern.indexOf('*', wildcardIndex + 1),
    `Expected ${globLabel} to include a single wildcard segment: ${globPattern}`,
  ).to.equal(-1);
  const prefix = globPattern.slice(0, wildcardIndex);
  const suffix = globPattern.slice(wildcardIndex + 1);
  expect(
    prefix.startsWith('src/'),
    `Expected ${globLabel} prefix to stay src-scoped: ${globPattern}`,
  ).to.equal(true);
  expect(
    prefix.includes('/squads/'),
    `Expected ${globLabel} prefix to stay squads-scoped: ${globPattern}`,
  ).to.equal(true);
  expect(
    suffix.endsWith('.test.ts'),
    `Expected ${globLabel} suffix to remain test-file scoped: ${globPattern}`,
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

function listSdkSquadsDirectoryEntries(
  absoluteDirectoryPath: string,
): readonly fs.Dirent[] {
  return fs
    .readdirSync(absoluteDirectoryPath, { withFileTypes: true })
    .sort((left, right) => compareLexicographically(left.name, right.name));
}

function listSdkSquadsSubdirectoryPathsRecursively(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string = '',
): readonly string[] {
  const discoveredSubdirectories: string[] = [];
  for (const entry of listSdkSquadsDirectoryEntries(absoluteDirectoryPath)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const nextRelativePath =
      relativeDirectoryPath.length === 0
        ? entry.name
        : path.posix.join(relativeDirectoryPath, entry.name);
    const nextAbsolutePath = path.join(absoluteDirectoryPath, entry.name);
    discoveredSubdirectories.push(`src/squads/${nextRelativePath}`);
    discoveredSubdirectories.push(
      ...listSdkSquadsSubdirectoryPathsRecursively(
        nextAbsolutePath,
        nextRelativePath,
      ),
    );
  }
  return discoveredSubdirectories.sort(compareLexicographically);
}

function listSdkSquadsTestFilePaths(): readonly string[] {
  return listSdkSquadsDirectoryEntries(SDK_SQUADS_SOURCE_DIR)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => `src/squads/${entry.name}`);
}

function listSdkSquadsNonTestSourceFilePaths(): readonly string[] {
  return listSdkSquadsDirectoryEntries(SDK_SQUADS_SOURCE_DIR)
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
  return listSdkSquadsPathsRecursively(
    absoluteDirectoryPath,
    relativeDirectoryPath,
    (entryName) => entryName.endsWith('.test.ts'),
  );
}

function listSdkSquadsNonTestSourceFilePathsRecursively(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string = '',
): readonly string[] {
  return listSdkSquadsPathsRecursively(
    absoluteDirectoryPath,
    relativeDirectoryPath,
    (entryName) => entryName.endsWith('.ts') && !entryName.endsWith('.test.ts'),
  );
}

function listSdkSquadsTypeScriptPathsRecursively(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string = '',
): readonly string[] {
  return listSdkSquadsPathsRecursively(
    absoluteDirectoryPath,
    relativeDirectoryPath,
    (entryName) => entryName.endsWith('.ts'),
  );
}

function listSdkSquadsPathsRecursively(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string,
  shouldIncludeFileName: (entryName: string) => boolean,
): readonly string[] {
  const discoveredPaths: string[] = [];

  for (const entry of listSdkSquadsDirectoryEntries(absoluteDirectoryPath)) {
    const nextRelativePath =
      relativeDirectoryPath.length === 0
        ? entry.name
        : path.posix.join(relativeDirectoryPath, entry.name);
    const nextAbsolutePath = path.join(absoluteDirectoryPath, entry.name);

    if (entry.isDirectory()) {
      discoveredPaths.push(
        ...listSdkSquadsPathsRecursively(
          nextAbsolutePath,
          nextRelativePath,
          shouldIncludeFileName,
        ),
      );
      continue;
    }

    if (entry.isFile() && shouldIncludeFileName(entry.name)) {
      discoveredPaths.push(`src/squads/${nextRelativePath}`);
    }
  }

  return discoveredPaths.sort(compareLexicographically);
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

function assertRelativePathsResolveToFiles(
  relativePaths: readonly string[],
  pathSetLabel: string,
): void {
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(SDK_PACKAGE_ROOT, relativePath);
    expect(
      fs.existsSync(absolutePath),
      `Expected ${pathSetLabel} path to exist: ${relativePath}`,
    ).to.equal(true);
    expect(
      fs.statSync(absolutePath).isFile(),
      `Expected ${pathSetLabel} path to resolve to file: ${relativePath}`,
    ).to.equal(true);
  }
}

function listSquadsBarrelExportedSourcePaths(): readonly string[] {
  const squadsBarrelSource = fs.readFileSync(SQUADS_BARREL_INDEX_PATH, 'utf8');
  const exportStatements = squadsBarrelSource
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('export * from'));
  const exportedSourcePaths: string[] = [];

  for (const exportStatement of exportStatements) {
    const exportMatch = /^export \* from '\.\/(.+)\.js';$/.exec(
      exportStatement,
    );
    expect(
      exportMatch,
      `Expected squads barrel export statement to follow canonical .js re-export shape: ${exportStatement}`,
    ).to.not.equal(null);
    if (!exportMatch) {
      continue;
    }
    exportedSourcePaths.push(`src/squads/${exportMatch[1]}.ts`);
  }

  return exportedSourcePaths.sort(compareLexicographically);
}

function assertPathSnapshotIsolation(
  listPaths: () => readonly string[],
  pathSetLabel: string,
): void {
  const baselinePaths = listPaths();
  const callerMutableSnapshot = [...listPaths()];
  callerMutableSnapshot.pop();
  const subsequentPaths = listPaths();

  expect(callerMutableSnapshot).to.not.deep.equal(baselinePaths);
  expect(subsequentPaths).to.deep.equal(baselinePaths);
  expect(subsequentPaths).to.not.equal(baselinePaths);
}

describe('squads barrel exports', () => {
  it('keeps canonical sdk squads path-constant relationships', () => {
    expect(path.relative(SDK_PACKAGE_ROOT, SDK_SQUADS_SOURCE_DIR)).to.equal(
      'src/squads',
    );
    expect(path.relative(SDK_PACKAGE_ROOT, SDK_ROOT_INDEX_PATH)).to.equal(
      'src/index.ts',
    );
    expect(path.relative(SDK_PACKAGE_ROOT, SQUADS_BARREL_INDEX_PATH)).to.equal(
      'src/squads/index.ts',
    );
    expect(path.relative(SDK_PACKAGE_ROOT, SDK_PACKAGE_JSON_PATH)).to.equal(
      'package.json',
    );
  });

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
    for (const tokenPath of SDK_SQUADS_TEST_TOKEN_PATHS) {
      assertSingleAsteriskGlobShape(
        tokenPath,
        'sdk squads test-token constant glob',
      );
    }
  });

  it('keeps expected canonical sdk squads test command prefix', () => {
    expect(SDK_SQUADS_TEST_COMMAND_PREFIX).to.equal(
      'mocha --config .mocharc.json',
    );
  });

  it('keeps expected canonical sdk squads test glob', () => {
    expect(SDK_SQUADS_TEST_GLOB).to.equal('src/squads/*.test.ts');
  });

  it('keeps expected canonical sdk squads test command', () => {
    expect(EXPECTED_SDK_SQUADS_TEST_SCRIPT).to.equal(
      "mocha --config .mocharc.json 'src/squads/*.test.ts'",
    );
  });

  it('re-exports squads config/constants', () => {
    expect(squadsConfigs).to.equal(directSquadsConfigs);
    expect(getSquadsChains).to.equal(directGetSquadsChains);
    expect(getSquadsKeysForResolvedChain).to.equal(
      directGetSquadsKeysForResolvedChain,
    );
    expect(resolveSquadsChainName).to.equal(directResolveSquadsChainName);
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
    for (const statement of EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS) {
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
      ...EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS,
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
      ...EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS,
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

  it('keeps sdk squads command token order canonical', () => {
    const quotedTestTokens = getQuotedSdkSquadsTestTokens();
    expect(quotedTestTokens).to.deep.equal([...SDK_SQUADS_TEST_TOKEN_PATHS]);
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

  it('keeps expected canonical sdk squads test file paths', () => {
    expect(EXPECTED_SDK_SQUADS_TEST_FILE_PATHS).to.deep.equal([
      'src/squads/config.test.ts',
      'src/squads/error-format.test.ts',
      'src/squads/index.test.ts',
      'src/squads/provider.test.ts',
      'src/squads/transaction-reader.test.ts',
      'src/squads/utils.test.ts',
    ]);
  });

  it('keeps sdk squads test-file path constants normalized and immutable', () => {
    expect(Object.isFrozen(EXPECTED_SDK_SQUADS_TEST_FILE_PATHS)).to.equal(true);
    expect(new Set(EXPECTED_SDK_SQUADS_TEST_FILE_PATHS).size).to.equal(
      EXPECTED_SDK_SQUADS_TEST_FILE_PATHS.length,
    );
    expect(
      [...EXPECTED_SDK_SQUADS_TEST_FILE_PATHS].sort(compareLexicographically),
    ).to.deep.equal([...EXPECTED_SDK_SQUADS_TEST_FILE_PATHS]);
    for (const testPath of EXPECTED_SDK_SQUADS_TEST_FILE_PATHS) {
      assertSdkSquadsTestTokenShape(testPath, 'expected sdk squads test path');
    }
    assertRelativePathsResolveToFiles(
      EXPECTED_SDK_SQUADS_TEST_FILE_PATHS,
      'expected sdk squads test path constant',
    );
  });

  it('keeps sdk discovered squads test files aligned with canonical test file paths', () => {
    const discoveredSquadsTestPaths = listSdkSquadsTestFilePaths();
    expect(discoveredSquadsTestPaths).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_TEST_FILE_PATHS,
    ]);
  });

  it('keeps sdk squads test globs excluding non-test squads source files', () => {
    const nonTestSquadsSourcePaths = listSdkSquadsNonTestSourceFilePaths();
    expect(
      nonTestSquadsSourcePaths.length,
      'Expected at least one sdk squads non-test source file',
    ).to.be.greaterThan(0);

    for (const nonTestPath of nonTestSquadsSourcePaths) {
      assertSdkSquadsNonTestSourcePathShape(
        nonTestPath,
        'discovered sdk squads non-test source path',
      );
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

  it('keeps sdk squads TypeScript discovery partitioned into test and non-test sets', () => {
    const recursivelyDiscoveredTestPaths = [
      ...listSdkSquadsTestFilePathsRecursively(SDK_SQUADS_SOURCE_DIR),
    ];
    const recursivelyDiscoveredNonTestSourcePaths = [
      ...listSdkSquadsNonTestSourceFilePathsRecursively(SDK_SQUADS_SOURCE_DIR),
    ];
    const recursivelyDiscoveredTypeScriptPaths = [
      ...listSdkSquadsTypeScriptPathsRecursively(SDK_SQUADS_SOURCE_DIR),
    ];

    expect(
      recursivelyDiscoveredTestPaths.length,
      'Expected at least one recursively discovered sdk squads test path',
    ).to.be.greaterThan(0);
    expect(
      recursivelyDiscoveredNonTestSourcePaths.length,
      'Expected at least one recursively discovered sdk squads non-test path',
    ).to.be.greaterThan(0);

    const testPathSet = new Set(recursivelyDiscoveredTestPaths);
    const nonTestPathSet = new Set(recursivelyDiscoveredNonTestSourcePaths);

    for (const nonTestPath of nonTestPathSet) {
      assertSdkSquadsNonTestSourcePathShape(
        nonTestPath,
        'recursively discovered sdk squads non-test source path',
      );
    }
    for (const testPath of testPathSet) {
      expect(nonTestPathSet.has(testPath)).to.equal(false);
    }

    expect(new Set(recursivelyDiscoveredTypeScriptPaths).size).to.equal(
      recursivelyDiscoveredTypeScriptPaths.length,
    );
    expect(recursivelyDiscoveredTypeScriptPaths).to.deep.equal(
      [...recursivelyDiscoveredTypeScriptPaths].sort(compareLexicographically),
    );
    expect(
      [
        ...recursivelyDiscoveredTestPaths,
        ...recursivelyDiscoveredNonTestSourcePaths,
      ].sort(compareLexicographically),
    ).to.deep.equal(recursivelyDiscoveredTypeScriptPaths);
  });

  it('keeps sdk discovered squads file paths resolving to files', () => {
    const discoveredTestPaths = listSdkSquadsTestFilePaths();
    const discoveredNonTestSourcePaths = listSdkSquadsNonTestSourceFilePaths();
    const discoveredAllTypeScriptPaths =
      listSdkSquadsTypeScriptPathsRecursively(SDK_SQUADS_SOURCE_DIR);

    assertRelativePathsResolveToFiles(
      discoveredTestPaths,
      'discovered sdk squads test',
    );
    assertRelativePathsResolveToFiles(
      discoveredNonTestSourcePaths,
      'discovered sdk squads non-test source',
    );
    assertRelativePathsResolveToFiles(
      discoveredAllTypeScriptPaths,
      'discovered sdk squads TypeScript',
    );
  });

  it('keeps sdk squads non-test sources partitioned between barrel exports and internal modules', () => {
    const discoveredNonTestSourcePaths = listSdkSquadsNonTestSourceFilePaths();
    const barrelExportedSourcePaths = listSquadsBarrelExportedSourcePaths();
    assertRelativePathsResolveToFiles(
      discoveredNonTestSourcePaths,
      'discovered sdk squads non-test source',
    );
    assertRelativePathsResolveToFiles(
      barrelExportedSourcePaths,
      'barrel-exported sdk squads source',
    );
    expect(new Set(barrelExportedSourcePaths).size).to.equal(
      barrelExportedSourcePaths.length,
    );
    expect(barrelExportedSourcePaths).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS,
    ]);
    for (const barrelExportedSourcePath of barrelExportedSourcePaths) {
      assertSdkSquadsNonTestSourcePathShape(
        barrelExportedSourcePath,
        'sdk squads barrel-exported source path',
      );
    }
    const nonExportedSourcePaths = discoveredNonTestSourcePaths
      .filter(
        (sourcePath) =>
          sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH &&
          !barrelExportedSourcePaths.includes(sourcePath),
      )
      .sort(compareLexicographically);
    expect(nonExportedSourcePaths).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS,
    ]);
    expect(
      [
        ...barrelExportedSourcePaths,
        ...nonExportedSourcePaths,
        SDK_SQUADS_INDEX_SOURCE_PATH,
      ].sort(compareLexicographically),
    ).to.deep.equal(
      [...discoveredNonTestSourcePaths].sort(compareLexicographically),
    );
  });

  it('keeps expected sdk squads barrel-exported source paths normalized and deduplicated', () => {
    expect(
      Object.isFrozen(EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS),
    ).to.equal(true);
    expect(
      [...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS].sort(
        compareLexicographically,
      ),
    ).to.deep.equal([...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS]);
    expect(
      new Set(EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS).size,
    ).to.equal(EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS.length);
    for (const sourcePath of EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS) {
      assertSdkSquadsNonTestSourcePathShape(
        sourcePath,
        'expected sdk squads barrel-exported source path constant',
      );
    }
  });

  it('keeps expected canonical sdk squads barrel-exported source paths', () => {
    expect(EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS).to.deep.equal([
      'src/squads/config.ts',
      'src/squads/error-format.ts',
      'src/squads/transaction-reader.ts',
      'src/squads/utils.ts',
    ]);
  });

  it('keeps expected canonical sdk squads test token paths', () => {
    expect(SDK_SQUADS_TEST_TOKEN_PATHS).to.deep.equal(['src/squads/*.test.ts']);
  });

  it('keeps expected canonical sdk squads barrel export statements', () => {
    expect(EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS).to.deep.equal([
      "export * from './config.js';",
      "export * from './utils.js';",
      "export * from './transaction-reader.js';",
      "export * from './error-format.js';",
    ]);
  });

  it('keeps squads barrel export statements aligned with exported source-path constants', () => {
    const exportedSourcePathsFromStatements =
      EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS.map((statement) =>
        statement
          .replace("export * from './", 'src/squads/')
          .replace(".js';", '.ts'),
      ).sort(compareLexicographically);
    expect(exportedSourcePathsFromStatements).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS,
    ]);
  });

  it('keeps expected canonical sdk squads internal source paths', () => {
    expect(EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS).to.deep.equal(
      ['src/squads/provider.ts', 'src/squads/validation.ts'],
    );
  });

  it('keeps expected canonical sdk squads index source path', () => {
    expect(SDK_SQUADS_INDEX_SOURCE_PATH).to.equal('src/squads/index.ts');
  });

  it('keeps sdk squads source-role constants normalized and disjoint', () => {
    expect(Object.isFrozen(EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS)).to.equal(
      true,
    );
    expect(
      Object.isFrozen(EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS),
    ).to.equal(true);

    expect(new Set(EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS).size).to.equal(
      EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS.length,
    );
    for (const exportStatement of EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS) {
      expect(exportStatement).to.equal(exportStatement.trim());
      expect(/\s{2,}/.test(exportStatement)).to.equal(false);
      expect(exportStatement.startsWith("export * from './")).to.equal(true);
      expect(exportStatement.endsWith(".js';")).to.equal(true);
    }

    expect(
      new Set(EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS).size,
    ).to.equal(EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS.length);
    for (const sourcePath of EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS) {
      assertSdkSquadsNonTestSourcePathShape(
        sourcePath,
        'expected sdk squads internal non-exported source path constant',
      );
    }

    const exportedSourcePathSet = new Set(
      EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS,
    );
    for (const internalSourcePath of EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS) {
      expect(exportedSourcePathSet.has(internalSourcePath)).to.equal(false);
    }
  });

  it('keeps sdk squads source-path constants isolated from caller mutation', () => {
    const baselineBarrelExportedPaths = [
      ...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS,
    ];
    const callerMutatedBarrelExportedPaths = [
      ...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS,
    ];
    callerMutatedBarrelExportedPaths.pop();
    const subsequentBarrelExportedPaths = [
      ...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS,
    ];
    expect(callerMutatedBarrelExportedPaths).to.not.deep.equal(
      baselineBarrelExportedPaths,
    );
    expect(subsequentBarrelExportedPaths).to.deep.equal(
      baselineBarrelExportedPaths,
    );

    const baselineInternalSourcePaths = [
      ...EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS,
    ];
    const callerMutatedInternalSourcePaths = [
      ...EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS,
    ];
    callerMutatedInternalSourcePaths.pop();
    const subsequentInternalSourcePaths = [
      ...EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS,
    ];
    expect(callerMutatedInternalSourcePaths).to.not.deep.equal(
      baselineInternalSourcePaths,
    );
    expect(subsequentInternalSourcePaths).to.deep.equal(
      baselineInternalSourcePaths,
    );
  });

  it('keeps sdk squads source directory flat without nested subdirectories', () => {
    expect(
      listSdkSquadsSubdirectoryPathsRecursively(SDK_SQUADS_SOURCE_DIR),
    ).to.deep.equal([]);
  });

  it('keeps sdk squads runtime sources decoupled from infra and filesystem env wiring', () => {
    const runtimeSourcePaths = listSdkSquadsNonTestSourceFilePaths();
    expect(runtimeSourcePaths.length).to.be.greaterThan(0);

    for (const runtimeSourcePath of runtimeSourcePaths) {
      const runtimeSource = fs.readFileSync(
        path.join(SDK_PACKAGE_ROOT, runtimeSourcePath),
        'utf8',
      );

      expect(
        INFRA_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid infra references: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        FILESYSTEM_IMPORT_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid filesystem imports: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_ENV_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.env coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_ARGV_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.argv coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_CWD_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.cwd coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_EXIT_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.exit coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_STDIN_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.stdin coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_STDOUT_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.stdout coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_STDERR_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.stderr coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        CLI_GLUE_IMPORT_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid infra CLI glue imports: ${runtimeSourcePath}`,
      ).to.equal(false);
    }
  });

  it('keeps recursive sdk squads discovery helpers isolated from caller mutation', () => {
    assertPathSnapshotIsolation(
      listSdkSquadsTestFilePaths,
      'sdk squads top-level test-path discovery',
    );
    assertPathSnapshotIsolation(
      listSdkSquadsNonTestSourceFilePaths,
      'sdk squads top-level non-test source discovery',
    );
    assertPathSnapshotIsolation(
      () => listSdkSquadsTestFilePathsRecursively(SDK_SQUADS_SOURCE_DIR),
      'sdk squads recursive test-path discovery',
    );
    assertPathSnapshotIsolation(
      () =>
        listSdkSquadsNonTestSourceFilePathsRecursively(SDK_SQUADS_SOURCE_DIR),
      'sdk squads recursive non-test source discovery',
    );
    assertPathSnapshotIsolation(
      () => listSdkSquadsTypeScriptPathsRecursively(SDK_SQUADS_SOURCE_DIR),
      'sdk squads recursive TypeScript discovery',
    );
    assertPathSnapshotIsolation(
      listSquadsBarrelExportedSourcePaths,
      'sdk squads barrel-exported source discovery',
    );
  });
});
