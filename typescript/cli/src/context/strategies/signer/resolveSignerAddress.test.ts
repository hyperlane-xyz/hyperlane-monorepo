import { expect } from 'chai';
import { Wallet } from 'ethers';

import { PartialRegistry } from '@hyperlane-xyz/registry';
import {
  IsmType,
  MultiProtocolProvider,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, normalizeAddressEvm } from '@hyperlane-xyz/utils';

import { createTrustedRelayerConfig } from '../../../config/ism.js';
import { type CommandContext } from '../../types.js';
import { tryResolveSignerAddress } from './resolveSignerAddress.js';

const PRIVATE_KEY = Wallet.createRandom().privateKey;
const CHAIN = 'test';
const previousHttpSignerToken = process.env.HYP_HTTP_SIGNER_TOKEN;

function getContext(key?: string): CommandContext {
  const chainMetadata = {
    [CHAIN]: {
      name: CHAIN,
      protocol: ProtocolType.Ethereum,
      chainId: 1,
      domainId: 1,
      rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
    },
  };
  return {
    altVmSigners: {},
    altVmProviders: {},
    chainMetadata,
    key: key ? { [ProtocolType.Ethereum]: key } : {},
    multiProtocolProvider: new MultiProtocolProvider(chainMetadata),
    multiProvider: new MultiProvider(chainMetadata),
    registry: new PartialRegistry({ chainMetadata }),
    skipConfirmation: true,
    supportedProtocols: [ProtocolType.Ethereum],
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

  it('uses the pinned HTTP signer address without a chain', async () => {
    const signer = Wallet.createRandom();
    expect(
      await tryResolveSignerAddress(
        getContext(`http://127.0.0.1:3333#${signer.address.toLowerCase()}`),
      ),
    ).to.equal(normalizeAddressEvm(signer.address));
  });

  it('rejects an invalid pinned EVM signer address without a chain', async () => {
    try {
      await tryResolveSignerAddress(
        getContext('http://127.0.0.1:3333#not-an-address'),
      );
      expect.fail('Expected an invalid pinned address to throw');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).to.equal(
          'Invalid EVM signer address: not-an-address',
        );
      }
    }
  });

  it('uses the pinned HTTP signer address for a trusted relayer default', async () => {
    const signer = Wallet.createRandom();

    expect(
      await createTrustedRelayerConfig(
        getContext(`http://127.0.0.1:3333#${signer.address}`),
        false,
      ),
    ).to.deep.equal({
      type: IsmType.TRUSTED_RELAYER,
      relayer: signer.address,
    });
  });
});
