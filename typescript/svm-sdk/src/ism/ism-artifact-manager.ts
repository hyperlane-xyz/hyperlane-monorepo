import { address as parseAddress } from '@solana/kit';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedRawIsmArtifact,
  IRawIsmArtifactManager,
  RawIsmArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/ism';

import type { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import type { SvmDeployedIsm, SvmRpc } from '../types.js';

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
    const readers: {
      [K in keyof RawIsmArtifactConfigs]?: () => ArtifactReader<
        RawIsmArtifactConfigs[K],
        SvmDeployedIsm
      >;
    } = {
      testIsm: () => new SvmTestIsmReader(this.rpc),
      // FIXME: SVM multisig ISM has a completely different shape from other msig ISMs
      messageIdMultisigIsm: () => {
        throw new Error('Multisig ISM reading not supported on SVM chains');
      },
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
      testIsm: () =>
        new SvmTestIsmWriter(
          { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.testIsm } },
          this.rpc,
          signer,
        ),
      // FIXME: SVM multisig ISM has a completely different shape from other msig ISMs
      messageIdMultisigIsm: () => {
        throw new Error('Multisig ISM deployment not supported on SVM chains');
      },
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
