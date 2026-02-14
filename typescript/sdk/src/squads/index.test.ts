import { expect } from 'chai';

import {
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
  });
});
