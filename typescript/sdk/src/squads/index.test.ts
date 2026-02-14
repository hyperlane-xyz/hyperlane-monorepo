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
import {
  SquadsTransactionReader as DirectSquadsTransactionReader,
} from './transaction-reader.js';
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
    expect(rootIndexSource).to.include("export * from './squads/index.js';");
  });

  it('keeps expected squads submodule exports in squads barrel source', () => {
    const squadsBarrelSource = fs.readFileSync(SQUADS_BARREL_INDEX_PATH, 'utf8');

    expect(squadsBarrelSource).to.include("export * from './config.js';");
    expect(squadsBarrelSource).to.include("export * from './utils.js';");
    expect(squadsBarrelSource).to.include(
      "export * from './transaction-reader.js';",
    );
    expect(squadsBarrelSource).to.include(
      "export * from './error-format.js';",
    );
  });

  it('keeps sdk package explicitly depending on @sqds/multisig', () => {
    const sdkPackageJson = JSON.parse(
      fs.readFileSync(SDK_PACKAGE_JSON_PATH, 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
    };

    expect(sdkPackageJson.dependencies?.['@sqds/multisig']).to.not.equal(
      undefined,
    );
  });
});
