import { expect } from 'chai';
import { Wallet } from 'ethers';

import { MultiProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { tryResolveSignerAddress } from './resolveSignerAddress.js';

const PRIVATE_KEY = Wallet.createRandom().privateKey;
const CHAIN = 'test';
const previousHttpSignerToken = process.env.HYP_HTTP_SIGNER_TOKEN;

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
    if (previousHttpSignerToken === undefined) {
      delete process.env.HYP_HTTP_SIGNER_TOKEN;
    } else {
      process.env.HYP_HTTP_SIGNER_TOKEN = previousHttpSignerToken;
    }
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

  it('uses the pinned HTTP signer address for a chain', async () => {
    const signer = Wallet.createRandom();
    process.env.HYP_HTTP_SIGNER_TOKEN = 'test-token';

    expect(
      await tryResolveSignerAddress(
        getContext(`http://127.0.0.1:3333#${signer.address}`),
        CHAIN,
      ),
    ).to.equal(signer.address);
  });

  it('does not choose an arbitrary chain for an HTTP signer', async () => {
    expect(
      await tryResolveSignerAddress(
        getContext(`http://127.0.0.1:3333#${Wallet.createRandom().address}`),
      ),
    ).to.equal(undefined);
  });
});
