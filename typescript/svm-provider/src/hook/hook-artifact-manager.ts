import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedHookAddress,
  DeployedHookArtifact,
  RawHookArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/hook';

import type { SvmSigner } from '../signer.js';
import type { SvmProgramAddresses } from '../types.js';

import { detectHookType } from './hook-query.js';
import {
  DEFAULT_IGP_CONTEXT,
  SvmIgpHookReader,
  SvmIgpHookWriter,
  deriveIgpSalt,
} from './igp-hook.js';
import {
  SvmMerkleTreeHookReader,
  SvmMerkleTreeHookWriter,
} from './merkle-tree-hook.js';

export type HookAccountDecoder = 'igpProgramData' | 'igp' | 'overheadIgp';

export class SvmHookArtifactManager {
  private readonly salt: Uint8Array;

  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly programAddresses: SvmProgramAddresses,
    context: string = DEFAULT_IGP_CONTEXT,
  ) {
    this.salt = deriveIgpSalt(context);
  }

  async readHook(address: string): Promise<DeployedHookArtifact> {
    const addr = address as Address;
    const hookType = await detectHookType(this.rpc, addr);
    const typeKey = this.altVmToTypeKey(hookType);
    const reader = this.createReader(typeKey);
    return reader.read(address);
  }

  createReader<T extends keyof RawHookArtifactConfigs>(
    type: T,
  ): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const readers: {
      [K in keyof RawHookArtifactConfigs]: () => ArtifactReader<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    } = {
      merkleTreeHook: () =>
        new SvmMerkleTreeHookReader(this.rpc, this.programAddresses.mailbox),
      interchainGasPaymaster: () =>
        new SvmIgpHookReader(this.rpc, this.programAddresses.igp, this.salt),
    };
    const factory = readers[type];
    if (!factory) throw new Error(`Unsupported hook type: ${type}`);
    return factory();
  }

  createWriter<T extends keyof RawHookArtifactConfigs>(
    type: T,
    signer: SvmSigner,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const writers: {
      [K in keyof RawHookArtifactConfigs]: () => ArtifactWriter<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    } = {
      merkleTreeHook: () =>
        new SvmMerkleTreeHookWriter(
          this.rpc,
          this.programAddresses.mailbox,
          signer,
        ),
      interchainGasPaymaster: () =>
        new SvmIgpHookWriter(
          this.rpc,
          this.programAddresses.igp,
          this.salt,
          signer,
        ),
    };
    const factory = writers[type];
    if (!factory) throw new Error(`Unsupported hook type: ${type}`);
    return factory();
  }

  private altVmToTypeKey(hookType: HookType): keyof RawHookArtifactConfigs {
    switch (hookType) {
      case HookType.MERKLE_TREE:
        return 'merkleTreeHook';
      case HookType.INTERCHAIN_GAS_PAYMASTER:
        return 'interchainGasPaymaster';
      default:
        throw new Error(`Unsupported hook type on Solana: ${hookType}`);
    }
  }
}
