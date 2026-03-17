import {
  address as parseAddress,
  type Address,
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
import { assert } from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import type { SvmDeployedHook, SvmDeployedIgpHook } from '../types.js';

import { detectHookType } from './hook-query.js';
import {
  DEFAULT_IGP_SALT,
  SvmIgpHookReader,
  SvmIgpHookWriter,
} from './igp-hook.js';
import {
  SvmMerkleTreeHookReader,
  SvmMerkleTreeHookWriter,
} from './merkle-tree-hook.js';

export type HookAccountDecoder = 'igpProgramData' | 'igp' | 'overheadIgp';

function createUnsupportedSvmHookReader<T extends keyof RawHookArtifactConfigs>(
  type: T,
): ArtifactReader<
  RawHookArtifactConfigs[T],
  SvmDeployedHook | SvmDeployedIgpHook
> {
  return {
    read: async () => {
      throw new Error(`${type} hook type is unsupported on Sealevel`);
    },
  };
}

function createUnsupportedSvmHookWriter<T extends keyof RawHookArtifactConfigs>(
  type: T,
): ArtifactWriter<
  RawHookArtifactConfigs[T],
  SvmDeployedHook | SvmDeployedIgpHook
> {
  return {
    read: async () => {
      throw new Error(`${type} hook type is unsupported on Sealevel`);
    },
    create: async () => {
      throw new Error(`${type} hook type is unsupported on Sealevel`);
    },
    update: async () => {
      throw new Error(`${type} hook type is unsupported on Sealevel`);
    },
  };
}

export class SvmHookArtifactManager implements IRawHookArtifactManager {
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly mailboxAddress?: Address,
    private readonly salt: Uint8Array = DEFAULT_IGP_SALT,
  ) {}

  async readHook(address: string): Promise<DeployedHookArtifact> {
    const addr = parseAddress(address);
    const hookType = await detectHookType(this.rpc, addr);

    if (hookType !== null) {
      return this.createReader(this.altVmToTypeKey(hookType)).read(address);
    }

    // The only other supported hook on SVM is the merkle tree hook, which IS
    // the mailbox program. Validate the address matches before assuming.
    assert(
      this.mailboxAddress,
      'Mailbox address is required to detect merkle tree hooks on SVM',
    );
    assert(
      addr === this.mailboxAddress,
      `Unknown hook address ${address}: not an IGP program; expected the configured mailbox (${this.mailboxAddress}) for Merkle detection`,
    );
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
      protocolFee: () => createUnsupportedSvmHookReader('protocolFee'),
    };
    const factory = readers[type];
    if (!factory) throw new Error(`Unsupported hook type: ${type}`);
    return factory();
  }

  createWriter<T extends keyof RawHookArtifactConfigs>(
    type: T,
    signer: SvmSigner,
  ): ArtifactWriter<
    RawHookArtifactConfigs[T],
    SvmDeployedHook | SvmDeployedIgpHook
  > {
    const writers: {
      [K in keyof RawHookArtifactConfigs]: () => ArtifactWriter<
        RawHookArtifactConfigs[K],
        SvmDeployedHook | SvmDeployedIgpHook
      >;
    } = {
      merkleTreeHook: () => new SvmMerkleTreeHookWriter(this.rpc, signer),
      interchainGasPaymaster: () =>
        new SvmIgpHookWriter(this.rpc, this.salt, signer),
      protocolFee: () => createUnsupportedSvmHookWriter('protocolFee'),
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
