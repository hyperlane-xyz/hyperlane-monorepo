import {
  address as parseAddress,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedHookArtifact,
  IRawHookArtifactManager,
  RawHookArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/hook';

import type { SealevelSigner } from '../clients/signer.js';
import type { SvmDeployedHook, SvmDeployedIgpHook } from '../types.js';

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

export class SvmHookArtifactManager implements IRawHookArtifactManager {
  private readonly salt: Uint8Array;

  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    context: string = DEFAULT_IGP_CONTEXT,
  ) {
    this.salt = deriveIgpSalt(context);
  }

  async readHook(address: string): Promise<DeployedHookArtifact> {
    const addr = parseAddress(address);
    const hookType = await detectHookType(this.rpc, addr);

    if (hookType !== null) {
      return this.createReader(this.altVmToTypeKey(hookType)).read(address);
    }

    // TODO: implement proper on-chain hook type detection for merkle tree hooks.
    // Currently falls through to merkle tree for any non-IGP address since
    // the merkle tree hook on SVM is the mailbox program itself.
    return this.createReader('merkleTreeHook').read(address);
  }

  createReader<T extends keyof RawHookArtifactConfigs>(
    type: T,
  ): ArtifactReader<
    RawHookArtifactConfigs[T],
    SvmDeployedHook | SvmDeployedIgpHook
  > {
    const readers: {
      [K in keyof RawHookArtifactConfigs]: () => ArtifactReader<
        RawHookArtifactConfigs[K],
        SvmDeployedHook | SvmDeployedIgpHook
      >;
    } = {
      merkleTreeHook: () => new SvmMerkleTreeHookReader(this.rpc),
      interchainGasPaymaster: () => new SvmIgpHookReader(this.rpc, this.salt),
    };
    const factory = readers[type];
    if (!factory) throw new Error(`Unsupported hook type: ${type}`);
    return factory();
  }

  createWriter<T extends keyof RawHookArtifactConfigs>(
    type: T,
    signer: SealevelSigner,
  ): ArtifactWriter<
    RawHookArtifactConfigs[T],
    SvmDeployedHook | SvmDeployedIgpHook
  > {
    const svmSigner = signer.getSvmSigner();
    const writers: {
      [K in keyof RawHookArtifactConfigs]: () => ArtifactWriter<
        RawHookArtifactConfigs[K],
        SvmDeployedHook | SvmDeployedIgpHook
      >;
    } = {
      merkleTreeHook: () => new SvmMerkleTreeHookWriter(this.rpc, svmSigner),
      interchainGasPaymaster: () =>
        new SvmIgpHookWriter(this.rpc, this.salt, svmSigner),
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
