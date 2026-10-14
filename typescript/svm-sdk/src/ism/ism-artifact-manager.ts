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
import { type NonEmptyArray, assert } from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import type { SvmDeployedIsm, SvmRpc } from '../types.js';

import {
  SvmCompositeIsmReader,
  SvmCompositeIsmWriter,
} from './composite-ism.js';
import { detectIsmType } from './ism-query.js';
import {
  SvmRoutingMessageIdMultisigIsmReader,
  SvmRoutingMessageIdMultisigIsmWriter,
} from './multisig-ism.js';
import { SvmTestIsmReader, SvmTestIsmWriter } from './test-ism.js';

const UNSUPPORTED_FLAT_MULTISIG_MESSAGE = `${IsmType.MESSAGE_ID_MULTISIG} is unsupported on SVM: the program stores validators and threshold per origin domain, use ${IsmType.ROUTING_MESSAGE_ID_MULTISIG} instead`;

export class SvmIsmArtifactManager implements IRawIsmArtifactManager {
  /**
   * @param knownDomainIds Candidate origin domains probed when reading a
   * routingMessageIdMultisigIsm, whose per-domain accounts can't be enumerated.
   */
  constructor(
    private readonly rpc: SvmRpc,
    private readonly knownDomainIds?: NonEmptyArray<number>,
  ) {}

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
      compositeIsm: () => new SvmCompositeIsmReader(this.rpc),
      routingMessageIdMultisigIsm: () => {
        assert(
          this.knownDomainIds,
          'routingMessageIdMultisigIsm requires known domain ids',
        );
        return new SvmRoutingMessageIdMultisigIsmReader(
          this.rpc,
          this.knownDomainIds,
        );
      },
      messageIdMultisigIsm: () => {
        throw new Error(UNSUPPORTED_FLAT_MULTISIG_MESSAGE);
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
      compositeIsm: () =>
        new SvmCompositeIsmWriter(
          {
            program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.compositeIsm },
          },
          this.rpc,
          signer,
        ),
      routingMessageIdMultisigIsm: () => {
        assert(
          this.knownDomainIds,
          'routingMessageIdMultisigIsm requires known domain ids',
        );
        return new SvmRoutingMessageIdMultisigIsmWriter(
          {
            program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.multisigIsm },
          },
          this.rpc,
          signer,
          this.knownDomainIds,
        );
      },
      messageIdMultisigIsm: () => {
        throw new Error(UNSUPPORTED_FLAT_MULTISIG_MESSAGE);
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
      case IsmType.ROUTING_MESSAGE_ID_MULTISIG:
        return 'routingMessageIdMultisigIsm';
      case IsmType.COMPOSITE:
        return 'compositeIsm';
      default:
        throw new Error(`Unsupported ISM type on Solana: ${ismType}`);
    }
  }
}
