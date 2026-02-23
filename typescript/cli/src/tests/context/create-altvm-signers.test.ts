import { expect } from 'chai';

import {
  type AltVM,
  type ChainMetadataForAltVM,
  ProtocolType,
  hasProtocol,
  registerProtocol,
} from '@hyperlane-xyz/provider-sdk';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { createAltVMSigners } from '../../context/altvm.js';
import { type SignerKeyProtocolMap } from '../../context/types.js';
import { type ExtendedChainSubmissionStrategy } from '../../submitters/types.js';

type MetadataManager = Parameters<typeof createAltVMSigners>[0];

function getStarknetMetadata(chainName: string): ChainMetadataForAltVM {
  return {
    name: chainName,
    protocol: ProtocolType.Starknet,
    chainId: chainName.toUpperCase(),
    domainId: chainName === 'starknetmainnet' ? 1234 : 421614,
    rpcUrls: [{ http: 'http://localhost:9545' }],
  };
}

function getMetadataManager(
  getMetadata: (chainName: string) => ChainMetadataForAltVM,
): MetadataManager {
  return {
    getChainMetadata: getMetadata,
  };
}

function getStubSigner(): AltVM.ISigner<AnnotatedTx, TxReceipt> {
  return {} as AltVM.ISigner<AnnotatedTx, TxReceipt>;
}

describe('createAltVMSigners', () => {
  const capturedConfigs: Array<{
    privateKey?: string;
    accountAddress?: string;
  }> = [];

  before(function () {
    if (hasProtocol(ProtocolType.Starknet)) {
      this.skip();
    }

    registerProtocol(ProtocolType.Starknet, () => ({
      async createProvider() {
        throw new Error('not needed for createAltVMSigners test');
      },
      async createSigner(_chainMetadata, config) {
        capturedConfigs.push(config);
        return getStubSigner();
      },
      async createSubmitter() {
        throw new Error('not needed for createAltVMSigners test');
      },
      createIsmArtifactManager() {
        throw new Error('not needed for createAltVMSigners test');
      },
      createHookArtifactManager() {
        throw new Error('not needed for createAltVMSigners test');
      },
      createMailboxArtifactManager() {
        throw new Error('not needed for createAltVMSigners test');
      },
      createValidatorAnnounceArtifactManager() {
        return null;
      },
      getMinGas() {
        return {
          CORE_DEPLOY_GAS: 0n,
          WARP_DEPLOY_GAS: 0n,
          TEST_SEND_GAS: 0n,
          AVS_GAS: 0n,
          ISM_DEPLOY_GAS: 0n,
        };
      },
    }));
  });

  beforeEach(() => {
    capturedConfigs.length = 0;
    delete process.env.HYP_ACCOUNT_ADDRESS_STARKNET;
  });

  it('prefers strategy user/account address over environment variable', async () => {
    process.env.HYP_ACCOUNT_ADDRESS_STARKNET = '0xenv';

    const strategy: Partial<ExtendedChainSubmissionStrategy> = {
      starknetsepolia: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: 'starknetsepolia',
          privateKey: '0xstrategy',
          userAddress: '0xstrategy-account',
        },
      },
    };

    const keys: SignerKeyProtocolMap = {
      [ProtocolType.Starknet]: '0xstrategy',
    };

    await createAltVMSigners(
      getMetadataManager(() => getStarknetMetadata('starknetsepolia')),
      ['starknetsepolia'],
      keys,
      strategy,
    );

    expect(capturedConfigs).to.have.length(1);
    expect(capturedConfigs[0]).to.deep.equal({
      privateKey: '0xstrategy',
      accountAddress: '0xstrategy-account',
    });
  });

  it('respects per-chain strategy account addresses for the same protocol', async () => {
    const strategy: Partial<ExtendedChainSubmissionStrategy> = {
      starknetsepolia: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: 'starknetsepolia',
          userAddress: '0xstrategy-account-sepolia',
        },
      },
      starknet: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: 'starknet',
          userAddress: '0xstrategy-account-mainnet',
        },
      },
    };

    const keys: SignerKeyProtocolMap = {
      [ProtocolType.Starknet]: '0xkey',
    };

    await createAltVMSigners(
      getMetadataManager((chainName) => getStarknetMetadata(chainName)),
      ['starknetsepolia', 'starknet'],
      keys,
      strategy,
    );

    expect(capturedConfigs).to.have.length(2);
    expect(capturedConfigs[0]).to.deep.equal({
      privateKey: '0xkey',
      accountAddress: '0xstrategy-account-sepolia',
    });
    expect(capturedConfigs[1]).to.deep.equal({
      privateKey: '0xkey',
      accountAddress: '0xstrategy-account-mainnet',
    });
  });

  it('uses env account address when strategy has none', async () => {
    process.env.HYP_ACCOUNT_ADDRESS_STARKNET = '0xenv-account';

    const keys: SignerKeyProtocolMap = {
      [ProtocolType.Starknet]: '0xkey',
    };

    await createAltVMSigners(
      getMetadataManager(() => getStarknetMetadata('starknetsepolia')),
      ['starknetsepolia'],
      keys,
      {},
    );

    expect(capturedConfigs).to.have.length(1);
    expect(capturedConfigs[0]).to.deep.equal({
      privateKey: '0xkey',
      accountAddress: '0xenv-account',
    });
  });

  it('resolves Starknet accountAddress per chain before fallback cache reuse', async () => {
    const strategy: Partial<ExtendedChainSubmissionStrategy> = {
      starknetsepolia: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: 'starknetsepolia',
          privateKey: '0xkey',
          userAddress: '0xaaa',
        },
      },
      starknetmainnet: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: 'starknetmainnet',
          privateKey: '0xkey',
          userAddress: '0xbbb',
        },
      },
    };

    const keys: SignerKeyProtocolMap = {
      [ProtocolType.Starknet]: '0xkey',
    };

    await createAltVMSigners(
      getMetadataManager((chainName) => getStarknetMetadata(chainName)),
      ['starknetsepolia', 'starknetmainnet'],
      keys,
      strategy,
    );

    expect(capturedConfigs).to.have.length(2);
    expect(capturedConfigs[0].accountAddress).to.equal('0xaaa');
    expect(capturedConfigs[1].accountAddress).to.equal('0xbbb');
  });
});
