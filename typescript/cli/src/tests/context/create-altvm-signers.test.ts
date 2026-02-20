import { expect } from 'chai';

import {
  ProtocolType,
  hasProtocol,
  registerProtocol,
} from '@hyperlane-xyz/provider-sdk';

import { createAltVMSigners } from '../../context/altvm.js';
import { type SignerKeyProtocolMap } from '../../context/types.js';

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
        return {} as any;
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

    const strategy = {
      starknetsepolia: {
        submitter: {
          type: 'jsonRpc',
          chain: 'starknetsepolia',
          privateKey: '0xstrategy',
          userAddress: '0xstrategy-account',
        },
      },
    } as any;

    const keys: SignerKeyProtocolMap = {
      [ProtocolType.Starknet]: '0xstrategy',
    };

    await createAltVMSigners(
      {
        getChainMetadata: () =>
          ({
            name: 'starknetsepolia',
            protocol: ProtocolType.Starknet,
            chainId: 'SN_SEPOLIA',
            domainId: 421614,
            rpcUrls: [{ http: 'http://localhost:9545' }],
          }) as any,
      } as any,
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
    const strategy = {
      starknetsepolia: {
        submitter: {
          type: 'jsonRpc',
          chain: 'starknetsepolia',
          userAddress: '0xstrategy-account-sepolia',
        },
      },
      starknet: {
        submitter: {
          type: 'jsonRpc',
          chain: 'starknet',
          accountAddress: '0xstrategy-account-mainnet',
        },
      },
    } as any;

    const keys: SignerKeyProtocolMap = {
      [ProtocolType.Starknet]: '0xkey',
    };

    await createAltVMSigners(
      {
        getChainMetadata: (chain: string) =>
          ({
            name: chain,
            protocol: ProtocolType.Starknet,
            chainId: chain.toUpperCase(),
            domainId: 1,
            rpcUrls: [{ http: 'http://localhost:9545' }],
          }) as any,
      } as any,
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
      {
        getChainMetadata: () =>
          ({
            name: 'starknetsepolia',
            protocol: ProtocolType.Starknet,
            chainId: 'SN_SEPOLIA',
            domainId: 421614,
            rpcUrls: [{ http: 'http://localhost:9545' }],
          }) as any,
      } as any,
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
});
