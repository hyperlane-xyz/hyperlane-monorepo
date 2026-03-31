import { expect } from 'chai';

import {
  CrossCollateralValidationNode,
  validateCrossCollateralGraph,
} from './crossCollateralValidation.js';

describe('validateCrossCollateralGraph', () => {
  it('accepts a compatible router set', () => {
    const nodes: CrossCollateralValidationNode[] = [
      {
        chainName: 'chain-a',
        routerAddress: '0x1111111111111111111111111111111111111111',
        decimals: 18,
        symbol: 'USDC',
      },
      {
        chainName: 'chain-b',
        routerAddress: '0x2222222222222222222222222222222222222222',
        decimals: 6,
        scale: 1_000_000_000_000,
        symbol: 'USDC',
      },
      {
        chainName: 'chain-c',
        routerAddress: '0x3333333333333333333333333333333333333333',
        decimals: 18,
        symbol: 'USDT',
      },
    ];

    validateCrossCollateralGraph({ nodes });
  });

  it('rejects an incompatible router set', () => {
    const nodes: CrossCollateralValidationNode[] = [
      {
        chainName: 'chain-a',
        routerAddress: '0x1111111111111111111111111111111111111111',
        decimals: 18,
        symbol: 'USDC',
      },
      {
        chainName: 'chain-b',
        routerAddress: '0x2222222222222222222222222222222222222222',
        decimals: 6,
        scale: 1_000_000_000_000,
        symbol: 'USDC',
      },
      {
        chainName: 'chain-c',
        routerAddress: '0x3333333333333333333333333333333333333333',
        decimals: 18,
        scale: 2,
        symbol: 'USDT',
      },
    ];

    let thrown: Error | undefined;
    try {
      validateCrossCollateralGraph({ nodes });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.include(
      'Incompatible CrossCollateralRouter decimals/scale',
    );
    expect(thrown?.message).to.include('USDT');
    expect(thrown?.message).to.include('chain-c');
  });
});
