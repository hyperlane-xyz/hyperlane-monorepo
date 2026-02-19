import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { StarknetHookArtifactManager } from './hook-artifact-manager.js';

describe('StarknetHookArtifactManager', () => {
  const chainMetadata = {
    name: 'starknet-test',
    chainId: 1234,
    domainId: 1234,
    protocol: 'starknet',
    rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
    nativeToken: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
      denom: 'ETH',
    },
  } as any;

  it('rejects unsupported IGP hook readers', () => {
    const manager = new StarknetHookArtifactManager(chainMetadata);
    expect(() =>
      manager.createReader(AltVM.HookType.INTERCHAIN_GAS_PAYMASTER),
    ).to.throw('IGP hook is unsupported on Starknet');
  });

  it('creates protocol fee update transactions for mutable fields', async () => {
    const manager = new StarknetHookArtifactManager(chainMetadata);
    const writer = manager.createWriter(
      AltVM.HookType.PROTOCOL_FEE,
      {} as any,
    ) as any;

    writer.read = async () => ({
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.HookType.PROTOCOL_FEE,
        owner: '0x01',
        beneficiary: '0x02',
        protocolFee: '1',
        maxProtocolFee: '100',
        tokenAddress: '0x03',
      },
      deployed: { address: '0xabc' },
    });

    const txs = await writer.update({
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.HookType.PROTOCOL_FEE,
        owner: '0x11',
        beneficiary: '0x12',
        protocolFee: '2',
        maxProtocolFee: '100',
        tokenAddress: '0x03',
      },
      deployed: { address: '0xabc' },
    });

    expect(txs).to.have.length(3);
    expect(txs[0].annotation).to.contain('Updating protocol fee');
    expect(txs[1].annotation).to.contain('Updating protocol fee beneficiary');
    expect(txs[2].annotation).to.contain(
      'Transferring protocol fee hook ownership',
    );
  });
});
