import {
  address as parseAddress,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedRawIsmArtifact,
  RawIsmArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/ism';

import type { SvmSigner } from '../signer.js';
import type { SvmDeployedIsm } from '../types.js';

import { detectIsmType } from './ism-query.js';
import {
  SvmMessageIdMultisigIsmReader,
  SvmMessageIdMultisigIsmWriter,
} from './multisig-ism.js';
import { SvmTestIsmReader, SvmTestIsmWriter } from './test-ism.js';

export class SvmIsmArtifactManager {
  constructor(private readonly rpc: Rpc<SolanaRpcApi>) {}

  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const programId = parseAddress(address);
    const ismType = await detectIsmType(this.rpc, programId);
    const typeKey = this.altVmToTypeKey(ismType);
    const reader = this.createReader(typeKey);
    return reader.read(address);
  }

  createReader<T extends keyof RawIsmArtifactConfigs>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], SvmDeployedIsm> {
    const readers: {
      [K in keyof RawIsmArtifactConfigs]?: () => ArtifactReader<
        RawIsmArtifactConfigs[K],
        SvmDeployedIsm
      >;
    } = {
      testIsm: () => new SvmTestIsmReader(this.rpc),
      messageIdMultisigIsm: () => new SvmMessageIdMultisigIsmReader(this.rpc),
    };
    const factory = readers[type];
    if (!factory) throw new Error(`Unsupported ISM type: ${type}`);
    return factory();
  }

  createWriter<T extends keyof RawIsmArtifactConfigs>(
    type: T,
    signer: SvmSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], SvmDeployedIsm> {
    const writers: {
      [K in keyof RawIsmArtifactConfigs]?: () => ArtifactWriter<
        RawIsmArtifactConfigs[K],
        SvmDeployedIsm
      >;
    } = {
      testIsm: () => new SvmTestIsmWriter(this.rpc, signer),
      messageIdMultisigIsm: () =>
        new SvmMessageIdMultisigIsmWriter(this.rpc, signer),
    };
    const factory = writers[type];
    if (!factory) throw new Error(`Unsupported ISM type: ${type}`);
    return factory();
  }

  private altVmToTypeKey(ismType: IsmType): keyof RawIsmArtifactConfigs {
    switch (ismType) {
      case IsmType.TEST_ISM:
        return 'testIsm';
      case IsmType.MESSAGE_ID_MULTISIG:
        return 'messageIdMultisigIsm';
      default:
        throw new Error(`Unsupported ISM type on Solana: ${ismType}`);
    }
  }
}
