import { expect } from 'vitest';

import { type ChainMap, type IsmConfig, IsmType } from '@hyperlane-xyz/sdk';

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
    expect(ism).toEqual(exampleIsmConfig);
  });

  it('parsing failure, missing internal key "threshold"', () => {
    expect(function () {
      readIsmConfig('src/tests/ethereum/ism/safe-parse-fail.yaml');
    }).toThrow();
  });

  it('parsing failure, routingIsm.domains includes destination domain', () => {
    expect(function () {
      readIsmConfig('src/tests/ethereum/ism/routing-same-chain-fail.yaml');
    }).toThrow(
      'Cannot set RoutingIsm.domain to the same chain you are configuring',
    );
  });

  it('parsing failure, wrong ism type', () => {
    expect(function () {
      readIsmConfig('src/tests/ethereum/ism/wrong-ism-type-fail.yaml');
    }).toThrow('Invalid ISM config: anvil2 => Invalid input');
  });

  it('parsing failure, threshold > modules.length', () => {
    expect(function () {
      readIsmConfig(
        'src/tests/ethereum/ism/threshold-gt-modules-length-fail.yaml',
      );
    }).toThrow('Threshold must be less than or equal to the number of modules');
  });
});
