import { expect } from 'chai';

import { ChainMap, MultisigConfig } from '@hyperlane-xyz/sdk';

import { readMultisigConfig } from '../config/multisig.js';

describe('readMultisigConfig', () => {
  it('parses and validates example correctly', () => {
    const multisig = readMultisigConfig('examples/ism.yaml');

    const exampleMultisigConfig: ChainMap<MultisigConfig> = {
      anvil1: {
        threshold: 1,
        validators: ['0xa0Ee7A142d267C1f36714E4a8F75612F20a79720'],
      },
      anvil2: {
        threshold: 1,
        validators: ['0xa0Ee7A142d267C1f36714E4a8F75612F20a79720'],
      },
    };
    expect(multisig).to.deep.equal(exampleMultisigConfig);
  });

  it('parsing failure', () => {
    expect(function () {
      readMultisigConfig('src/tests/multisig/safe-parse-fail.yaml');
    }).to.throw('Invalid multisig config: anvil2,validators => Required');
  });

  it('threshold cannot be greater than the # of validators', () => {
    expect(function () {
      readMultisigConfig('src/tests/multisig/threshold-gt-fail.yaml');
    }).to.throw('Threshold cannot be greater than number of validators');
  });

  it('invalid address', () => {
    expect(function () {
      readMultisigConfig('src/tests/multisig/invalid-address-fail.yaml');
    }).to.throw('Invalid multisig config: anvil2,validators,0 => Invalid');
  });
});
