import { expect } from 'chai';
import { RpcProvider } from 'starknet';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';
import { ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import { StarknetSigner } from '../clients/signer.js';
import { StarknetAnnotatedTx, StarknetTxReceipt } from '../types.js';

import { StarknetWarpArtifactManager } from './warp-artifact-manager.js';

describe('StarknetWarpArtifactManager', () => {
  const chainMetadata: ChainMetadataForAltVM = {
    name: 'starknetsepolia',
    protocol: ProtocolType.Starknet,
    chainId: 'SN_SEPOLIA',
    domainId: 421614,
    rpcUrls: [{ http: 'http://localhost:9545' }],
  };

  class MockStarknetSigner extends StarknetSigner {
    capturedTxs: StarknetAnnotatedTx[] = [];

    constructor() {
      super(
        new RpcProvider({ nodeUrl: 'http://localhost:9545' }),
        chainMetadata,
        ['http://localhost:9545'],
        '0x1',
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      );
    }

    override async sendAndConfirmTransaction(
      tx: StarknetAnnotatedTx,
    ): Promise<StarknetTxReceipt> {
      this.capturedTxs.push(tx);
      return {
        transactionHash: `0x${this.capturedTxs.length}`,
        contractAddress: tx.kind === 'deploy' ? '0xabc' : undefined,
      };
    }
  }

  it('preserves current hook and ism when Starknet updates omit them', async () => {
    const manager = new StarknetWarpArtifactManager(chainMetadata);
    const signer = new MockStarknetSigner();
    const provider = Reflect.get(manager, 'provider') as {
      getToken: () => Promise<{
        address: string;
        tokenType: string;
        owner: string;
        mailboxAddress: string;
        ismAddress: string;
        hookAddress: string;
      }>;
      getRemoteRouters: () => Promise<{ remoteRouters: [] }>;
    };

    provider.getToken = async () => ({
      address: '0xabc',
      tokenType: TokenType.native,
      owner: signer.getSignerAddress(),
      mailboxAddress: '0x111',
      ismAddress: '0x444',
      hookAddress: '0x555',
    });
    provider.getRemoteRouters = async () => ({ remoteRouters: [] });

    const writer = manager.createWriter('native', signer);
    const txs = await writer.update({
      artifactState: ArtifactState.DEPLOYED,
      deployed: { address: '0xabc' },
      config: {
        type: TokenType.native,
        owner: signer.getSignerAddress(),
        mailbox: '0x111',
        remoteRouters: {},
        destinationGas: {},
      },
    });

    expect(txs).to.be.empty;
  });

  it('treats zero-address hook and ism placeholders as unset on Starknet update', async () => {
    const manager = new StarknetWarpArtifactManager(chainMetadata);
    const signer = new MockStarknetSigner();
    const provider = Reflect.get(manager, 'provider') as {
      getToken: () => Promise<{
        address: string;
        tokenType: string;
        owner: string;
        mailboxAddress: string;
        ismAddress: string;
        hookAddress: string;
      }>;
      getRemoteRouters: () => Promise<{ remoteRouters: [] }>;
    };

    provider.getToken = async () => ({
      address: '0xabc',
      tokenType: TokenType.native,
      owner: signer.getSignerAddress(),
      mailboxAddress: '0x111',
      ismAddress: '0x444',
      hookAddress: '0x555',
    });
    provider.getRemoteRouters = async () => ({ remoteRouters: [] });

    const writer = manager.createWriter('native', signer);
    const txs = await writer.update({
      artifactState: ArtifactState.DEPLOYED,
      deployed: { address: '0xabc' },
      config: {
        type: TokenType.native,
        owner: signer.getSignerAddress(),
        mailbox: '0x111',
        interchainSecurityModule: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ZERO_ADDRESS_HEX_32 },
        },
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ZERO_ADDRESS_HEX_32 },
        },
        remoteRouters: {},
        destinationGas: {},
      },
    });

    expect(txs).to.be.empty;
  });
});
