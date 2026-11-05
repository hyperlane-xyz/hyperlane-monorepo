import { expect } from 'chai';
import { ethers } from 'ethers';
import Sinon from 'sinon';

import { TokenBridgeOft__factory } from '@hyperlane-xyz/core';
import {
  MultiProtocolProvider,
  Token,
  TokenStandard,
  type ChainMap,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  ExecutionType,
  ExternalBridgeType,
  RebalancerStrategyOptions,
  TokenBridgeStatusAdapterType,
  type StrategyConfig,
} from '../../config/types.js';
import { validateOftRoutes } from './validateOftRoutes.js';

const BRIDGE = '0x1111111111111111111111111111111111111111';
const OFTS: ChainMap<string> = {
  ethereum: '0x2222222222222222222222222222222222222222',
  arbitrum: '0x3333333333333333333333333333333333333333',
  tron: '0x4444444444444444444444444444444444444444',
};
const ENDPOINT = '0x5555555555555555555555555555555555555555';
const ABI = new ethers.utils.Interface([
  'function endpoint() view returns (address)',
  'function peers(uint32) view returns (bytes32)',
  'function eid() view returns (uint32)',
]);
const bridgeInterface = TokenBridgeOft__factory.createInterface();

function status(destinationOft: string, destinationEid: number) {
  return {
    kind: TokenBridgeStatusAdapterType.LayerZeroScan,
    sourceEid: 30101,
    destinationEid,
    sourceOft: OFTS.ethereum,
    destinationOft,
  };
}

function fixture() {
  const multiProvider = Sinon.createStubInstance(MultiProtocolProvider);
  const tokens: ChainMap<Token> = {};
  const domain: ChainMap<number> = { ethereum: 1, arbitrum: 2, tron: 3 };
  const eids: ChainMap<number> = {
    ethereum: 30101,
    arbitrum: 30110,
    tron: 30420,
  };
  const providers: ChainMap<ethers.providers.StaticJsonRpcProvider> = {};
  for (const chain of Object.keys(domain)) {
    tokens[chain] = new Token({
      chainName: chain,
      addressOrDenom: OFTS[chain],
      decimals: 6,
      name: 'Test',
      symbol: 'T',
      standard: TokenStandard.EvmHypCollateral,
    });
    const provider = new ethers.providers.StaticJsonRpcProvider(
      'https://rpc.invalid',
      { chainId: domain[chain], name: `test-${chain}` },
    );
    Sinon.stub(provider, 'call').callsFake(async (request) => {
      const data = String(await request.data);
      if (data.startsWith(bridgeInterface.getSighash('oft')))
        return bridgeInterface.encodeFunctionResult('oft', [OFTS[chain]]);
      if (
        data.startsWith(bridgeInterface.getSighash('hyperlaneDomainToLzEid'))
      ) {
        const [destination] = bridgeInterface.decodeFunctionData(
          'hyperlaneDomainToLzEid',
          data,
        );
        return bridgeInterface.encodeFunctionResult('hyperlaneDomainToLzEid', [
          destination === 2 ? eids.arbitrum : eids.tron,
        ]);
      }
      if (data.startsWith(ABI.getSighash('endpoint')))
        return ABI.encodeFunctionResult('endpoint', [ENDPOINT]);
      if (data.startsWith(ABI.getSighash('eid')))
        return ABI.encodeFunctionResult('eid', [eids[chain]]);
      if (data.startsWith(ABI.getSighash('peers'))) {
        const [destination] = ABI.decodeFunctionData('peers', data);
        return ABI.encodeFunctionResult('peers', [
          addressToBytes32(
            destination === eids.arbitrum ? OFTS.arbitrum : OFTS.tron,
          ),
        ]);
      }
      throw new Error(`Unexpected call ${data}`);
    });
    providers[chain] = provider;
  }
  multiProvider.getDomainId.callsFake((chain) => domain[String(chain)]);
  multiProvider.getEthersV5Provider.callsFake(
    (chain) => providers[String(chain)],
  );
  const config: StrategyConfig = {
    rebalanceStrategy: RebalancerStrategyOptions.Weighted,
    chains: {
      ethereum: {
        bridge: BRIDGE,
        weighted: { weight: 1n, tolerance: 0n },
        statusAdapter: status(OFTS.arbitrum, 30110),
        override: { tron: { statusAdapter: status(OFTS.tron, 30420) } },
      },
      arbitrum: {
        executionType: ExecutionType.Inventory,
        externalBridge: ExternalBridgeType.SwapsXyz,
        weighted: { weight: 1n, tolerance: 0n },
      },
      tron: {
        executionType: ExecutionType.Inventory,
        externalBridge: ExternalBridgeType.SwapsXyz,
        weighted: { weight: 1n, tolerance: 0n },
      },
    },
  };
  return { config, tokens, multiProvider };
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected validation to fail');
}

describe('resolved OFT route validation', () => {
  afterEach(() => Sinon.restore());

  it('accepts a chain default with correct destination overrides', async () => {
    const { config, tokens, multiProvider } = fixture();
    await validateOftRoutes([config], tokens, multiProvider);
  });

  it('rejects an inherited destination endpoint on the wrong pair', async () => {
    const { config, tokens, multiProvider } = fixture();
    delete config.chains.ethereum.override;
    expect(
      String(
        await rejection(validateOftRoutes([config], tokens, multiProvider)),
      ),
    ).to.include('destination endpoint mismatch');
  });

  it('rejects a source OFT unrelated to the selected bridge', async () => {
    const { config, tokens, multiProvider } = fixture();
    config.chains.ethereum.statusAdapter = {
      ...status(OFTS.arbitrum, 30110),
      sourceOft: OFTS.tron,
    };
    expect(
      String(
        await rejection(validateOftRoutes([config], tokens, multiProvider)),
      ),
    ).to.include('source contract mismatch');
  });

  it('does not require disabled pairs to have an executable OFT mapping', async () => {
    const { config, tokens, multiProvider } = fixture();
    config.chains.ethereum.override = { tron: { enabled: false } };
    await validateOftRoutes([config], tokens, multiProvider);
  });
});
