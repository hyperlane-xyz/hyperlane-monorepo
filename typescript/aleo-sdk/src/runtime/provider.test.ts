import { expect } from 'chai';

import {
  ProtocolType,
  type ChainMetadataForAltVM,
} from '@hyperlane-xyz/provider-sdk';
import type { WarpArtifactConfig } from '@hyperlane-xyz/provider-sdk/warp';

import { AleoProvider as NodeAleoProvider } from '../clients/provider.node.js';

import { AleoProvider as MainnetAleoProvider } from './mainnet.js';
import { AleoProvider as TestnetAleoProvider } from './testnet.js';

function aleoMetadata(chainId: number): ChainMetadataForAltVM {
  return {
    name: `aleo${chainId}`,
    chainId,
    domainId: chainId,
    protocol: ProtocolType.Aleo,
    rpcUrls: [{ http: 'https://rpc.example' }],
  };
}

const nativeWarpConfig: WarpArtifactConfig = {
  type: 'native',
  owner: 'aleo1owner',
  mailbox: 'aleo1mailbox',
  remoteRouters: {},
  destinationGas: {},
};

describe('Aleo runtime providers', () => {
  it('constructs the eager Node provider from chain metadata', async () => {
    const provider = await NodeAleoProvider.connect({
      ...aleoMetadata(1),
      rpcUrls: [{ http: 'https://rpc.example/testnet' }],
    });

    expect(provider.getRpcUrls()).to.deep.equal(['https://rpc.example']);
  });

  it('constructs providers for their configured network', () => {
    const mainnet = new MainnetAleoProvider(
      ['https://rpc.example/mainnet'],
      0,
      aleoMetadata(0),
    );
    const testnet = new TestnetAleoProvider(
      ['https://rpc.example/testnet'],
      1,
      aleoMetadata(1),
    );

    expect(mainnet.getRpcUrls()).to.deep.equal(['https://rpc.example']);
    expect(testnet.getRpcUrls()).to.deep.equal(['https://rpc.example']);
  });

  it('preserves composable warp deploy gas estimation', async () => {
    const provider = new MainnetAleoProvider(
      ['https://rpc.example/mainnet'],
      0,
      aleoMetadata(0),
    );

    expect(await provider.getMinGasForWarpDeploy(nativeWarpConfig)).to.equal(
      100_000_000n,
    );
  });

  it('rejects the other network', () => {
    expect(
      () =>
        new MainnetAleoProvider(['https://rpc.example'], 1, aleoMetadata(1)),
    ).to.throw('Mainnet runtime cannot serve Aleo chain id 1');
    expect(
      () =>
        new TestnetAleoProvider(['https://rpc.example'], 0, aleoMetadata(0)),
    ).to.throw('Testnet runtime cannot serve Aleo chain id 0');
  });
});
