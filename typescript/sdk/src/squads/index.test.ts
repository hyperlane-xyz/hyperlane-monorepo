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
});
