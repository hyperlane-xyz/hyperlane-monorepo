import { expect } from 'chai';
import sinon from 'sinon';

import {
  type AltVM,
  type ChainMetadataForAltVM,
  ProtocolType,
  type ProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { altVmPrompts, createAltVMSigners } from '../../context/altvm.js';
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

function getRadixMetadata(chainName: string): ChainMetadataForAltVM {
  return {
    name: chainName,
    protocol: ProtocolType.Radix,
    chainId: chainName.toUpperCase(),
    domainId: 1234,
    rpcUrls: [{ http: 'http://localhost:3333' }],
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

  beforeEach(() => {
    capturedConfigs.length = 0;
    delete process.env.HYP_ACCOUNT_ADDRESS_STARKNET;
    sinon.restore();
  });

  function getProtocolRegistry(): NonNullable<
    Parameters<typeof createAltVMSigners>[4]
  > {
    const provider: Pick<ProtocolProvider, 'createSigner'> = {
      async createSigner(_chainMetadata, config) {
        capturedConfigs.push(config);
        return getStubSigner();
      },
    };

    return {
      getProtocolProvider: () => provider,
      hasProtocol: () => true,
    };
  }

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
      getProtocolRegistry(),
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
      getProtocolRegistry(),
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
      getProtocolRegistry(),
    );

    expect(capturedConfigs).to.have.length(1);
    expect(capturedConfigs[0]).to.deep.equal({
      privateKey: '0xkey',
      accountAddress: '0xenv-account',
    });
  });

  it('resolves Starknet accountAddress per chain', async () => {
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
      getProtocolRegistry(),
    );

    expect(capturedConfigs).to.have.length(2);
    expect(capturedConfigs[0].accountAddress).to.equal('0xaaa');
    expect(capturedConfigs[1].accountAddress).to.equal('0xbbb');
  });

  it('prompts for private key when strategy omits it', async () => {
    const privateKeyPrompt = sinon
      .stub(altVmPrompts, 'password')
      .resolves('0xprompted-key');

    const strategy: Partial<ExtendedChainSubmissionStrategy> = {
      starknetsepolia: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: 'starknetsepolia',
          userAddress: '0xstrategy-account',
        },
      },
    };

    await createAltVMSigners(
      getMetadataManager(() => getStarknetMetadata('starknetsepolia')),
      ['starknetsepolia'],
      {},
      strategy,
      getProtocolRegistry(),
    );

    expect(privateKeyPrompt.calledOnce).to.equal(true);
    expect(capturedConfigs).to.have.length(1);
    expect(capturedConfigs[0]).to.deep.equal({
      privateKey: '0xprompted-key',
      accountAddress: '0xstrategy-account',
    });
  });

  it('throws for non-Starknet jsonRpc strategies without a private key', async () => {
    const privateKeyPrompt = sinon.stub(altVmPrompts, 'password');

    const strategy: Partial<ExtendedChainSubmissionStrategy> = {
      radix: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: 'radix',
        },
      },
    };

    await createAltVMSigners(
      getMetadataManager(() => getRadixMetadata('radix')),
      ['radix'],
      {},
      strategy,
      getProtocolRegistry(),
    )
      .then(() => expect.fail('expected createAltVMSigners to throw'))
      .catch((error: unknown) => {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal(
          'missing private key in strategy config for chain radix',
        );
      });

    expect(privateKeyPrompt.called).to.equal(false);
    expect(capturedConfigs).to.have.length(0);
  });

  it('prefers explicit per-chain strategy key over prompted fallback', async () => {
    const privateKeyPrompt = sinon
      .stub(altVmPrompts, 'password')
      .resolves('0xprompted-key');

    const strategy: Partial<ExtendedChainSubmissionStrategy> = {
      starknetsepolia: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: 'starknetsepolia',
          userAddress: '0xstrategy-account-sepolia',
        },
      },
      starknetmainnet: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: 'starknetmainnet',
          privateKey: '0xstrategy-key-mainnet',
          userAddress: '0xstrategy-account-mainnet',
        },
      },
    };

    await createAltVMSigners(
      getMetadataManager((chainName) => getStarknetMetadata(chainName)),
      ['starknetsepolia', 'starknetmainnet'],
      {},
      strategy,
      getProtocolRegistry(),
    );

    expect(privateKeyPrompt.calledOnce).to.equal(true);
    expect(capturedConfigs).to.have.length(2);
    expect(capturedConfigs[0]).to.deep.equal({
      privateKey: '0xprompted-key',
      accountAddress: '0xstrategy-account-sepolia',
    });
    expect(capturedConfigs[1]).to.deep.equal({
      privateKey: '0xstrategy-key-mainnet',
      accountAddress: '0xstrategy-account-mainnet',
    });
  });

  it('does not reuse a prompted Starknet account address across chains', async () => {
    const accountPrompt = sinon
      .stub(altVmPrompts, 'input')
      .onFirstCall()
      .resolves('0xaaa')
      .onSecondCall()
      .resolves('0xbbb');

    const keys: SignerKeyProtocolMap = {
      [ProtocolType.Starknet]: '0xkey',
    };

    await createAltVMSigners(
      getMetadataManager((chainName) => getStarknetMetadata(chainName)),
      ['starknetsepolia', 'starknetmainnet'],
      keys,
      {},
      getProtocolRegistry(),
    );

    expect(accountPrompt.callCount).to.equal(2);
    expect(capturedConfigs).to.have.length(2);
    expect(capturedConfigs[0].accountAddress).to.equal('0xaaa');
    expect(capturedConfigs[1].accountAddress).to.equal('0xbbb');
  });
});
