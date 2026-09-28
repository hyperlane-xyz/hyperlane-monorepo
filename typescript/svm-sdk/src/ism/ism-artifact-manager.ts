import { address as parseAddress } from '@solana/kit';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedRawIsmArtifact,
  type IRawIsmArtifactManager,
  type IsmArtifactReaderFactories,
  type IsmArtifactWriterFactories,
  type RawIsmArtifactConfigs,
  throwUnsupportedIsmType,
} from '@hyperlane-xyz/provider-sdk/ism';

import type { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import type { SvmDeployedIsm, SvmRpc } from '../types.js';

import {
  SvmCompositeIsmReader,
  SvmCompositeIsmWriter,
} from './composite-ism.js';
import { detectIsmType } from './ism-query.js';
import { SvmTestIsmReader, SvmTestIsmWriter } from './test-ism.js';

export class SvmIsmArtifactManager implements IRawIsmArtifactManager {
  constructor(private readonly rpc: SvmRpc) {}

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
    const readers: IsmArtifactReaderFactories<SvmDeployedIsm> = {
      testIsm: () => new SvmTestIsmReader(this.rpc),
      compositeIsm: () => new SvmCompositeIsmReader(this.rpc),
    };

    const factory = readers[type];
    if (!factory) {
      return throwUnsupportedIsmType(type, ProtocolType.Sealevel);
    }

    return factory();
  }

  createWriter<T extends keyof RawIsmArtifactConfigs>(
    type: T,
    signer: SvmSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], SvmDeployedIsm> {
    const writers: IsmArtifactWriterFactories<SvmDeployedIsm> = {
      testIsm: () =>
        new SvmTestIsmWriter(
          { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.testIsm } },
          this.rpc,
          signer,
        ),
      compositeIsm: () =>
        new SvmCompositeIsmWriter(
          {
            program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.compositeIsm },
          },
          this.rpc,
          signer,
        ),
    };

    const factory = writers[type];
    if (!factory) {
      return throwUnsupportedIsmType(type, ProtocolType.Sealevel);
    }

    return factory();
  }

  private altVmToTypeKey(ismType: IsmType): keyof RawIsmArtifactConfigs {
    switch (ismType) {
      case IsmType.TEST_ISM:
        return 'testIsm';
      case IsmType.MESSAGE_ID_MULTISIG:
        return 'messageIdMultisigIsm';
      case IsmType.COMPOSITE:
        return 'compositeIsm';
      default:
        return throwUnsupportedIsmType(ismType, ProtocolType.Sealevel);
    }
  }
}
