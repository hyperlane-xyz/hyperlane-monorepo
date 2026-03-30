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

  it('accepts a compatible connected graph', async () => {
    const routeAChain1 = addNode({
      chainName: 'chain-a',
      routerAddress: '0x1111111111111111111111111111111111111111',
      decimals: 18,
      peers: [],
      symbol: 'USDC',
    });
    const routeAChain2 = addNode({
      chainName: 'chain-b',
      routerAddress: '0x2222222222222222222222222222222222222222',
      decimals: 6,
      peers: [],
      scale: 1_000_000_000_000,
      symbol: 'USDC',
    });
    const routeBChain1 = addNode({
      chainName: 'chain-a',
      routerAddress: '0x3333333333333333333333333333333333333333',
      decimals: 18,
      peers: [],
      symbol: 'USDT',
    });
    const routeBChain2 = addNode({
      chainName: 'chain-c',
      routerAddress: '0x4444444444444444444444444444444444444444',
      decimals: 6,
      peers: [],
      scale: 1_000_000_000_000,
      symbol: 'USDT',
    });

    routeAChain1.peers = [routeAChain2, routeBChain1];
    routeAChain2.peers = [routeAChain1];
    routeBChain1.peers = [routeAChain1, routeBChain2];
    routeBChain2.peers = [routeBChain1];

    await validateCrossCollateralGraph({
      roots: [routeAChain1],
      loadNode,
    });
  });

  it('rejects an incompatible graph even without same-chain overlap', async () => {
    const routeAChain1 = addNode({
      chainName: 'chain-a',
      routerAddress: '0x1111111111111111111111111111111111111111',
      decimals: 18,
      peers: [],
      symbol: 'USDC',
    });
    const routeAChain2 = addNode({
      chainName: 'chain-b',
      routerAddress: '0x2222222222222222222222222222222222222222',
      decimals: 6,
      peers: [],
      scale: 1_000_000_000_000,
      symbol: 'USDC',
    });
    const routeBChain1 = addNode({
      chainName: 'chain-a',
      routerAddress: '0x3333333333333333333333333333333333333333',
      decimals: 18,
      peers: [],
      symbol: 'USDT',
    });
    const routeBChain2 = addNode({
      chainName: 'chain-c',
      routerAddress: '0x4444444444444444444444444444444444444444',
      decimals: 18,
      peers: [],
      scale: 2,
      symbol: 'USDT',
    });

    routeAChain1.peers = [routeAChain2, routeBChain1];
    routeAChain2.peers = [routeAChain1];
    routeBChain1.peers = [routeAChain1, routeBChain2];
    routeBChain2.peers = [routeBChain1];

    let thrown: Error | undefined;
    try {
      await validateCrossCollateralGraph({
        roots: [routeAChain1],
        loadNode,
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
});
