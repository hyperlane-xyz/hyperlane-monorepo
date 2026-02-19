import { expect } from 'chai';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { StarknetValidatorAnnounceArtifactManager } from './validator-announce-artifact-manager.js';

describe('StarknetValidatorAnnounceArtifactManager', () => {
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

  it('reads validator announce artifacts', async () => {
    const manager = new StarknetValidatorAnnounceArtifactManager(chainMetadata);
    const reader = manager.createReader('validatorAnnounce');
    const artifact = await reader.read('0xabc');

    expect(artifact.deployed.address).to.equal('0xabc');
    expect(artifact.config.mailboxAddress).to.equal('');
  });

  it('creates validator announce artifacts and supports no-op updates', async () => {
    const manager = new StarknetValidatorAnnounceArtifactManager(chainMetadata);
    const signer = {
      createValidatorAnnounce: async () => ({ validatorAnnounceId: '0xdef' }),
    };

    const writer = manager.createWriter('validatorAnnounce', signer as any);
    const [created, receipts] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: { mailboxAddress: '0x123' },
    });
    const updateTxs = await writer.update({
      artifactState: ArtifactState.DEPLOYED,
      config: { mailboxAddress: '0x123' },
      deployed: { address: '0xdef' },
    });

    expect(created.deployed.address).to.equal('0xdef');
    expect(created.config.mailboxAddress).to.equal('0x123');
    expect(receipts).to.deep.equal([]);
    expect(updateTxs).to.deep.equal([]);
  });
});
