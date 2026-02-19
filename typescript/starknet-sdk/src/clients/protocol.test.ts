import { expect } from 'chai';
import { addAddressPadding } from 'starknet';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { StarknetProtocolProvider } from './protocol.js';

describe('StarknetProtocolProvider', () => {
  const chainMetadata = {
    name: 'starknet-test',
    chainId: 1234,
    domainId: 1234,
    protocol: ProtocolType.Starknet,
    rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
    nativeToken: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
      denom: 'ETH',
    },
  } as any;

  it('creates Starknet providers and signers', async () => {
    const protocolProvider = new StarknetProtocolProvider();

    const provider = await protocolProvider.createProvider(chainMetadata);
    const signer = await protocolProvider.createSigner(chainMetadata, {
      privateKey: '0x1',
      accountAddress: '0x2',
    });

    expect(provider.getRpcUrls()).to.deep.equal(['http://127.0.0.1:8545']);
    expect(signer.getSignerAddress()).to.equal(addAddressPadding('0x2'));
  });

  it('throws when signer accountAddress is missing', async () => {
    const protocolProvider = new StarknetProtocolProvider();

    let error: Error | undefined;
    try {
      await protocolProvider.createSigner(chainMetadata, {
        privateKey: '0x1',
      });
    } catch (err) {
      error = err as Error;
    }

    expect(error?.message).to.equal(
      'accountAddress missing for Starknet signer',
    );
  });
});
