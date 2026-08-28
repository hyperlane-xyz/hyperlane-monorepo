import { expect } from 'chai';
import { Wallet } from 'ethers';
import sinon from 'sinon';

import { MultiProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { HttpSignerClient } from './HttpSignerClient.js';
import { tryResolveSignerAddress } from './resolveSignerAddress.js';

const PRIVATE_KEY = Wallet.createRandom().privateKey;
const CHAIN = 'test';

function getContext(key?: string) {
  return {
    altVmSigners: {},
    key: key ? { [ProtocolType.Ethereum]: key } : {},
    multiProvider: new MultiProvider({
      [CHAIN]: {
        name: CHAIN,
        protocol: ProtocolType.Ethereum,
        chainId: 1,
        domainId: 1,
        rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
      },
    }),
    skipConfirmation: true,
  };
}

describe('tryResolveSignerAddress', () => {
  afterEach(() => {
    sinon.restore();
    delete process.env.HYP_HTTP_SIGNER_TOKEN;
  });

  it('uses an attached signer', async () => {
    const context = getContext();
    const signer = Wallet.createRandom();
    context.multiProvider.setSigner(CHAIN, signer);

    expect(await tryResolveSignerAddress(context, CHAIN)).to.equal(
      signer.address,
    );
  });

  it('derives a private-key signer without a chain', async () => {
    expect(await tryResolveSignerAddress(getContext(PRIVATE_KEY))).to.equal(
      new Wallet(PRIVATE_KEY).address,
    );
  });

  it('discovers an HTTP signer for a chain', async () => {
    const signer = Wallet.createRandom();
    process.env.HYP_HTTP_SIGNER_TOKEN = 'test-token';
    sinon.stub(HttpSignerClient.prototype, 'getAccount').resolves({
      chain: CHAIN,
      protocol: ProtocolType.Ethereum,
      address: signer.address,
      curve: 'secp256k1',
    });

    expect(
      await tryResolveSignerAddress(getContext('http://127.0.0.1:3333'), CHAIN),
    ).to.equal(signer.address);
  });

  it('does not choose an arbitrary chain for an HTTP signer', async () => {
    expect(
      await tryResolveSignerAddress(getContext('http://127.0.0.1:3333')),
    ).to.equal(undefined);
  });
});
