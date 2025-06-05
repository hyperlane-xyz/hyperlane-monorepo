import { expect } from 'chai';

import { ChainMap, IsmConfig, IsmType } from '@hyperlane-xyz/sdk';

import { readIsmConfig } from '../../config/ism.js';

describe('readIsmConfig', () => {
  it('parses and validates example correctly', () => {
    const ism = readIsmConfig('examples/ism-advanced.yaml');

    const exampleIsmConfig: ChainMap<IsmConfig> = {
      anvil1: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0xa0ee7a142d267c1f36714e4a8f75612f20a79720',
        domains: {
          anvil2: {
            type: IsmType.AGGREGATION,
            modules: [
              {
                type: IsmType.MESSAGE_ID_MULTISIG,
                threshold: 1,
                validators: ['0xa0ee7a142d267c1f36714e4a8f75612f20a79720'],
              },
              {
                type: IsmType.MERKLE_ROOT_MULTISIG,
                threshold: 1,
                validators: ['0xa0ee7a142d267c1f36714e4a8f75612f20a79720'],
              },
            ],
            threshold: 1,
          },
        },
      },
      anvil2: {
        type: IsmType.ROUTING,
        owner: '0xa0ee7a142d267c1f36714e4a8f75612f20a79720',
        domains: {
          anvil1: {
            type: IsmType.AGGREGATION,
            modules: [
              {
                type: IsmType.MESSAGE_ID_MULTISIG,
                threshold: 1,
                validators: ['0xa0ee7a142d267c1f36714e4a8f75612f20a79720'],
              },
              {
                type: IsmType.MERKLE_ROOT_MULTISIG,
                threshold: 1,
                validators: ['0xa0ee7a142d267c1f36714e4a8f75612f20a79720'],
              },
            ],
            threshold: 1,
          },
        },
      },
    };
    expect(ism).to.deep.equal(exampleIsmConfig);
  });

  it('parsing failure, missing internal key "threshold"', () => {
    expect(function () {
      readIsmConfig('src/tests/ism/safe-parse-fail.yaml');
    }).to.throw();
  });

  it('parsing failure, routingIsm.domains includes destination domain', () => {
    expect(function () {
      readIsmConfig('src/tests/ism/routing-same-chain-fail.yaml');
    }).to.throw(
      'Cannot set RoutingIsm.domain to the same chain you are configuring',
    );
  });

  it('parsing failure, wrong ism type', () => {
    expect(function () {
      readIsmConfig('src/tests/ism/wrong-ism-type-fail.yaml');
    }).to.throw('Invalid ISM config: anvil2 => Invalid input');
  });

  it('parsing failure, threshold > modules.length', () => {
    expect(function () {
      readIsmConfig('src/tests/ism/threshold-gt-modules-length-fail.yaml');
    }).to.throw(
      'Threshold must be less than or equal to the number of modules',
    );
  });
});
