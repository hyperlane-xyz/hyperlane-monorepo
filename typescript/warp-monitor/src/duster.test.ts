import { expect } from 'chai';

import type { IRegistry } from '@hyperlane-xyz/registry';
import {
  MultiProtocolProvider,
  WarpCore,
  type ChainMetadata,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, addressToBytes32 } from '@hyperlane-xyz/utils';

import { WarpTransferDuster } from './duster.js';

async function invokeProcessDustingCycle(
  duster: WarpTransferDuster,
  warpCore: WarpCore,
  multiProtocolProvider: MultiProtocolProvider,
  chainMetadata: Record<string, ChainMetadata>,
  sourceCursors: Map<string, number>,
) {
  // CAST: tests intentionally call a private helper to exercise a single dusting cycle
  // without starting the long-running service loop.
  const processDustingCycle = (duster as unknown as {
    processDustingCycle: (
      warpCore: WarpCore,
      multiProtocolProvider: MultiProtocolProvider,
      chainMetadata: Record<string, ChainMetadata>,
      sourceCursors: Map<string, number>,
    ) => Promise<void>;
  }).processDustingCycle;

  await processDustingCycle.call(
    duster,
    warpCore,
    multiProtocolProvider,
    chainMetadata,
    sourceCursors,
  );
}

describe('WarpTransferDuster', () => {
  it('sends native dust when a routed recipient has no native balance', async () => {
    const eventContract = {
      provider: {
        getBlockNumber: async () => 105,
      },
      filters: {
        SentTransferRemote: () => ({}),
      },
      queryFilter: async () => [
        {
          args: {
            destination: 8453,
            recipient: addressToBytes32(
              '0x1111111111111111111111111111111111111111',
            ),
          },
        },
      ],
    };

    const warpCore = {
      multiProvider: {},
      tokens: [
        {
          chainName: 'ethereum',
          addressOrDenom: '0xrouter',
          protocol: ProtocolType.Ethereum,
          getHypAdapter: () => ({
            contract: eventContract,
          }),
        },
      ],
    };

    const chainMetadata = {
      ethereum: {
        name: 'ethereum',
        domainId: 1,
        protocol: ProtocolType.Ethereum,
      },
      base: {
        name: 'base',
        domainId: 8453,
        protocol: ProtocolType.Ethereum,
      },
    };

    const duster = new WarpTransferDuster(
      {
        warpRouteId: 'ETH/ethereum-base',
        checkFrequency: 30_000,
        nativeDusting: {
          privateKey:
            '0x0123456789012345678901234567890123456789012345678901234567890123',
          defaultAmount: '0.0001',
        },
      },
      // CAST: this test calls processDustingCycle directly, so registry methods are never read.
      {} as IRegistry,
    );

    let dustedRecipient: string | undefined;
    // CAST: tests replace the internal side-effect method with a spy implementation.
    (duster as unknown as {
      ensureRecipientDusted: (chain: string, recipient: string) => Promise<void>;
    }).ensureRecipientDusted = async (chain: string, recipient: string) => {
      expect(chain).to.equal('base');
      dustedRecipient = recipient;
    };

    // CAST: the private helper only reads the WarpCore fields defined in this test stub.
    const warpCoreStub = warpCore as WarpCore;
    // CAST: ensureRecipientDusted is stubbed above, so this helper never dereferences the provider.
    const multiProtocolProviderStub = {} as MultiProtocolProvider;

    await invokeProcessDustingCycle(
      duster,
      warpCoreStub,
      multiProtocolProviderStub,
      chainMetadata,
      new Map([['ethereum:0xrouter', 100]]),
    );

    expect(dustedRecipient).to.equal(
      '0x1111111111111111111111111111111111111111',
    );
  });

  it('skips unsupported destination protocols before attempting to dust', async () => {
    const eventContract = {
      provider: {
        getBlockNumber: async () => 105,
      },
      filters: {
        SentTransferRemote: () => ({}),
      },
      queryFilter: async () => [
        {
          args: {
            destination: 6900,
            recipient: addressToBytes32(
              '11111111111111111111111111111111',
              ProtocolType.Sealevel,
            ),
          },
        },
      ],
    };

    const warpCore = {
      multiProvider: {},
      tokens: [
        {
          chainName: 'ethereum',
          addressOrDenom: '0xrouter',
          protocol: ProtocolType.Ethereum,
          getHypAdapter: () => ({
            contract: eventContract,
          }),
        },
      ],
    };

    const chainMetadata = {
      ethereum: {
        name: 'ethereum',
        domainId: 1,
        protocol: ProtocolType.Ethereum,
      },
      eclipse: {
        name: 'eclipse',
        domainId: 6900,
        protocol: ProtocolType.Sealevel,
      },
    };

    const duster = new WarpTransferDuster(
      {
        warpRouteId: 'ETH/ethereum-eclipse',
        checkFrequency: 30_000,
        nativeDusting: {
          privateKey:
            '0x0123456789012345678901234567890123456789012345678901234567890123',
          defaultAmount: '0.0001',
        },
      },
      // CAST: this test calls processDustingCycle directly, so registry methods are never read.
      {} as IRegistry,
    );

    let calls = 0;
    // CAST: tests replace the internal side-effect method with a spy implementation.
    (duster as unknown as {
      ensureRecipientDusted: () => Promise<void>;
    }).ensureRecipientDusted = async () => {
      calls += 1;
    };

    // CAST: the private helper only reads the WarpCore fields defined in this test stub.
    const warpCoreStub = warpCore as WarpCore;
    // CAST: ensureRecipientDusted is stubbed above, so this helper never dereferences the provider.
    const multiProtocolProviderStub = {} as MultiProtocolProvider;

    await invokeProcessDustingCycle(
      duster,
      warpCoreStub,
      multiProtocolProviderStub,
      chainMetadata,
      new Map([['ethereum:0xrouter', 100]]),
    );

    expect(calls).to.equal(0);
  });
});
