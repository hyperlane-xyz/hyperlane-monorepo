import { expect } from 'chai';

import {
  CrossCollateralValidationNode,
  getCrossCollateralRouterId,
  validateCrossCollateralGraph,
} from './crossCollateralValidation.js';

describe('validateCrossCollateralGraph', () => {
  const nodes = new Map<string, CrossCollateralValidationNode>();

  const addNode = (node: CrossCollateralValidationNode) => {
    nodes.set(getCrossCollateralRouterId(node), node);
    return node;
  };

  const loadNode = async (
    ref: Pick<CrossCollateralValidationNode, 'chainName' | 'routerAddress'>,
  ) => {
    const node = nodes.get(getCrossCollateralRouterId(ref));
    if (!node) {
      throw new Error(
        `Missing test node for ${ref.chainName}:${ref.routerAddress}`,
      );
    }
    return node;
  };

  beforeEach(() => {
    nodes.clear();
  });

  it('accepts a compatible router set', async () => {
    const routeAChain1 = addNode({
      chainName: 'chain-a',
      routerAddress: '0x1111111111111111111111111111111111111111',
      decimals: 18,
      symbol: 'USDC',
    });
    const routeAChain2 = addNode({
      chainName: 'chain-b',
      routerAddress: '0x2222222222222222222222222222222222222222',
      decimals: 6,
      scale: 1_000_000_000_000,
      symbol: 'USDC',
    });
    const routeBChain1 = addNode({
      chainName: 'chain-c',
      routerAddress: '0x3333333333333333333333333333333333333333',
      decimals: 18,
      symbol: 'USDT',
    });

    await validateCrossCollateralGraph({
      loadNode,
      routers: [routeAChain1, routeAChain2, routeBChain1],
    });
  });

  it('rejects an incompatible router set', async () => {
    const routeAChain1 = addNode({
      chainName: 'chain-a',
      routerAddress: '0x1111111111111111111111111111111111111111',
      decimals: 18,
      symbol: 'USDC',
    });
    const routeAChain2 = addNode({
      chainName: 'chain-b',
      routerAddress: '0x2222222222222222222222222222222222222222',
      decimals: 6,
      scale: 1_000_000_000_000,
      symbol: 'USDC',
    });
    const routeBChain1 = addNode({
      chainName: 'chain-c',
      routerAddress: '0x3333333333333333333333333333333333333333',
      decimals: 18,
      scale: 2,
      symbol: 'USDT',
    });

    let thrown: Error | undefined;
    try {
      await validateCrossCollateralGraph({
        loadNode,
        routers: [routeAChain1, routeAChain2, routeBChain1],
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.include(
      'Incompatible CrossCollateralRouter decimals/scale',
    );
    expect(thrown?.message).to.include('USDT');
    expect(thrown?.message).to.include('chain-c');
  });

  it('dedupes router refs before loading metadata', async () => {
    const routeAChain1 = addNode({
      chainName: 'chain-a',
      routerAddress: '0x1111111111111111111111111111111111111111',
      decimals: 18,
      symbol: 'USDC',
    });
    const routeAChain2 = addNode({
      chainName: 'chain-b',
      routerAddress: '0x2222222222222222222222222222222222222222',
      decimals: 6,
      scale: 1_000_000_000_000,
      symbol: 'USDC',
    });
    let loads = 0;

    await validateCrossCollateralGraph({
      loadNode: async (ref) => {
        loads += 1;
        return loadNode(ref);
      },
      routers: [routeAChain1, routeAChain1, routeAChain2],
    });

    expect(loads).to.equal(2);
  });
});
