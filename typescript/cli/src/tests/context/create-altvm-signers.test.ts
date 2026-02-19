import { expect } from 'chai';

import { loadProtocolProviders } from '@hyperlane-xyz/deploy-sdk';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { createAltVMSigners } from '../../context/altvm.js';
import { type SignerKeyProtocolMap } from '../../context/types.js';

describe('createAltVMSigners', () => {
  const normalizeAddress = (address: string) =>
    `0x${BigInt(address).toString(16).padStart(64, '0')}`;

  const chain = 'starknet-test';
  const metadata = {
    name: chain,
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
  const metadataManager = {
    getChainMetadata: (_chain: string) => metadata,
  } as any;

  const keyByProtocol: SignerKeyProtocolMap = {
    [ProtocolType.Starknet]: '0x1',
  };

  before(async () => {
    await loadProtocolProviders(new Set([ProtocolType.Starknet]));
  });

  it('uses strategy submitter userAddress for Starknet account address', async () => {
    const signers = await createAltVMSigners(
      metadataManager,
      [chain],
      { ...keyByProtocol },
      {
        [chain]: {
          submitter: {
            type: TxSubmitterType.JSON_RPC,
            chain,
            userAddress: '0x2',
          },
        },
      } as any,
    );

    expect(signers[chain]?.getSignerAddress()).to.equal(
      normalizeAddress('0x2'),
    );
  });

  it('uses HYP_ACCOUNT_ADDRESS_STARKNET as fallback when strategy omits userAddress', async () => {
    process.env.HYP_ACCOUNT_ADDRESS_STARKNET = '0x3';

    try {
      const signers = await createAltVMSigners(
        metadataManager,
        [chain],
        { ...keyByProtocol },
        {},
      );

      expect(signers[chain]?.getSignerAddress()).to.equal(
        normalizeAddress('0x3'),
      );
    } finally {
      delete process.env.HYP_ACCOUNT_ADDRESS_STARKNET;
    }
  });
});
