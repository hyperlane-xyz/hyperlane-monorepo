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

const SDK_ROOT_INDEX_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'index.ts',
);
const SQUADS_BARREL_INDEX_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'index.ts',
);
const SDK_PACKAGE_JSON_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'package.json',
);
const SDK_SQUADS_TEST_COMMAND_PREFIX = 'mocha --config .mocharc.json';
const SDK_SQUADS_TEST_GLOB = 'src/squads/*.test.ts';
const EXPECTED_SDK_SQUADS_TEST_SCRIPT = `${SDK_SQUADS_TEST_COMMAND_PREFIX} '${SDK_SQUADS_TEST_GLOB}'`;
const SINGLE_QUOTED_SCRIPT_TOKEN_PATTERN = /'([^']+)'/g;
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

describe('squads barrel exports', () => {
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
    expect(
      EXPECTED_SDK_SQUADS_TEST_SCRIPT.startsWith(
        `${SDK_SQUADS_TEST_COMMAND_PREFIX} `,
      ),
    ).to.equal(true);
    expect(EXPECTED_SDK_SQUADS_TEST_SCRIPT.includes('  ')).to.equal(false);
    expect(/[\n\r\t]/.test(EXPECTED_SDK_SQUADS_TEST_SCRIPT)).to.equal(false);
    const quotedTestTokens = listSingleQuotedTokens(
      EXPECTED_SDK_SQUADS_TEST_SCRIPT,
    );
    expect(quotedTestTokens).to.deep.equal([SDK_SQUADS_TEST_GLOB]);
    for (const quotedTestToken of quotedTestTokens) {
      expect(quotedTestToken.startsWith('src/')).to.equal(true);
      expect(quotedTestToken.startsWith('test/')).to.equal(false);
      expect(quotedTestToken.startsWith('/')).to.equal(false);
      expect(quotedTestToken.includes('..')).to.equal(false);
      expect(quotedTestToken.includes('\\')).to.equal(false);
      expect(quotedTestToken).to.equal(quotedTestToken.trim());
      expect(/\s/.test(quotedTestToken)).to.equal(false);
      expect(quotedTestToken).to.equal(path.posix.normalize(quotedTestToken));
    }
    expect(
      countOccurrences(
        EXPECTED_SDK_SQUADS_TEST_SCRIPT,
        `'${SDK_SQUADS_TEST_GLOB}'`,
      ),
    ).to.equal(1);
    expect(sdkPackageJson.exports?.['.']).to.equal('./dist/index.js');
    expect(sdkPackageJson.exports?.['./squads']).to.equal(undefined);
    expect(sdkPackageJson.exports?.['./squads/*']).to.equal(undefined);
    const sdkExportKeys = Object.keys(sdkPackageJson.exports ?? {});
    expect(sdkExportKeys).to.deep.equal(['.']);
    expect(
      sdkExportKeys.some((exportKey) => exportKey.startsWith('./squads')),
    ).to.equal(false);
  });
});
