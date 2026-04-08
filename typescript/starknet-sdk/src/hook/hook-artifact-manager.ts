import { AltVM, type ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { type ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedHookAddress,
  type DeployedHookArtifact,
  type HookType,
  type IRawHookArtifactManager,
  type RawHookArtifactConfigs,
  throwUnsupportedHookType,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';
import {
  createStarknetInterchainGasPaymasterHookReader,
  createStarknetInterchainGasPaymasterHookWriter,
} from './interchain-gas-paymaster-hook-artifact-manager.js';
import {
  StarknetMerkleTreeHookReader,
  StarknetMerkleTreeHookWriter,
} from './merkle-tree-hook-artifact-manager.js';
import {
  StarknetProtocolFeeHookReader,
  StarknetProtocolFeeHookWriter,
} from './protocol-fee-hook-artifact-manager.js';
import {
  StarknetUnknownHookReader,
  StarknetUnknownHookWriter,
} from './unknown-hook-artifact-manager.js';

export class StarknetHookArtifactManager implements IRawHookArtifactManager {
  private readonly provider: StarknetProvider;
  private readonly mailboxAddress: string;

  constructor(
    private readonly chainMetadata: ChainMetadataForAltVM,
    context?: { mailbox?: string },
  ) {
    this.provider = StarknetProvider.connect(
      (chainMetadata.rpcUrls ?? []).map(({ http }) => http),
      chainMetadata.chainId,
      { metadata: chainMetadata },
    );
    this.mailboxAddress = context?.mailbox
      ? normalizeStarknetAddressSafe(context.mailbox)
      : '';
  }

  private requireStarknetSigner(
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): StarknetSigner {
    assert(signer instanceof StarknetSigner, 'Expected StarknetSigner');
    return signer;
  }

  async readHook(address: string): Promise<DeployedHookArtifact> {
    const hookType = await this.provider.getHookType({
      hookAddress: address,
    });

    switch (hookType) {
      case AltVM.HookType.CUSTOM:
        return this.createReader('unknownHook').read(address);
      case AltVM.HookType.MERKLE_TREE:
        return this.createReader(AltVM.HookType.MERKLE_TREE).read(address);
      case AltVM.HookType.PROTOCOL_FEE:
        return this.createReader(AltVM.HookType.PROTOCOL_FEE).read(address);
      default:
        return throwUnsupportedHookType(hookType, 'Starknet');
    }
  }

  createReader<T extends HookType>(
    type: T,
  ): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const readers: Partial<{
      [K in HookType]: () => ArtifactReader<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    }> = {
      merkleTreeHook: () => new StarknetMerkleTreeHookReader(),
      interchainGasPaymaster: () =>
        createStarknetInterchainGasPaymasterHookReader(),
      protocolFee: () =>
        new StarknetProtocolFeeHookReader(this.chainMetadata, this.provider),
      unknownHook: () => new StarknetUnknownHookReader(),
    };
    const readerFactory = readers[type];
    if (!readerFactory) {
      return throwUnsupportedHookType(type, 'Starknet');
    }
    return readerFactory();
  }

  createWriter<T extends HookType>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const starknetSigner = this.requireStarknetSigner(signer);
    assert(
      this.mailboxAddress || type !== AltVM.HookType.MERKLE_TREE,
      'mailbox address required for Starknet merkle tree hook deployment',
    );

    const writers: Partial<{
      [K in HookType]: () => ArtifactWriter<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    }> = {
      merkleTreeHook: () =>
        new StarknetMerkleTreeHookWriter(starknetSigner, this.mailboxAddress),
      interchainGasPaymaster: () =>
        createStarknetInterchainGasPaymasterHookWriter(),
      protocolFee: () =>
        new StarknetProtocolFeeHookWriter(
          this.chainMetadata,
          this.provider,
          starknetSigner,
        ),
      unknownHook: () => new StarknetUnknownHookWriter(),
    };
    const writerFactory = writers[type];
    if (!writerFactory) {
      return throwUnsupportedHookType(type, 'Starknet');
    }
    return writerFactory();
  }
}
