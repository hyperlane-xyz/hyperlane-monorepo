import { address as parseAddress } from '@solana/kit';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import type {
  ArtifactComposition,
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedRawIsmArtifact,
  IRawIsmArtifactManager,
  IsmArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/ism';
import { assert } from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import type { SvmDeployedIsm, SvmRpc } from '../types.js';

import { detectIsmType } from './ism-query.js';
import { SvmRoutingMultisigReader } from './routing-multisig-reader.js';
import { SvmRoutingMultisigWriter } from './routing-multisig-writer.js';
import { SvmTestIsmReader, SvmTestIsmWriter } from './test-ism.js';

export class SvmIsmArtifactManager implements IRawIsmArtifactManager {
  constructor(
    private readonly rpc: SvmRpc,
    /**
     * Superset of remote domain ids the routing-multisig reader/writer may
     * encounter on-chain. Required for `domainRoutingIsm` reader/writer
     * dispatch because DomainData PDAs don't carry the domain id in their
     * payload — see `SvmRoutingMultisigReader` JSDoc. Callers that don't
     * need domain-routing reads can omit it.
     */
    private readonly candidateDomains?: readonly number[],
  ) {}

  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const programId = parseAddress(address);
    const ismType = await detectIsmType(this.rpc, programId);
    const typeKey = this.altVmToTypeKey(ismType);
    const reader = this.createReader(typeKey);
    return reader.read(address);
  }

  createReader<T extends keyof IsmArtifactConfigs>(
    type: T,
  ): ArtifactReader<
    IsmArtifactConfigs[T],
    SvmDeployedIsm,
    ArtifactComposition
  > {
    const readers: {
      [K in keyof IsmArtifactConfigs]?: () => ArtifactReader<
        IsmArtifactConfigs[K],
        SvmDeployedIsm,
        ArtifactComposition
      >;
    } = {
      testIsm: () => new SvmTestIsmReader(this.rpc),
      domainRoutingIsm: () => {
        assert(
          this.candidateDomains !== undefined,
          'domainRoutingIsm reader requires candidateDomains — pass via SvmIsmArtifactManager constructor (DomainData PDAs do not store the domain id)',
        );
        return new SvmRoutingMultisigReader(this.rpc, this.candidateDomains);
      },
      messageIdMultisigIsm: () => {
        throw new Error(
          'On SVM, multisig validators are configured per-domain inside a routing-multisig program. Use type "domainRoutingIsm" instead.',
        );
      },
    };
    const factory = readers[type];
    if (!factory) throw new Error(`Unsupported ISM type: ${type}`);
    return factory();
  }

  createWriter<T extends keyof IsmArtifactConfigs>(
    type: T,
    signer: SvmSigner,
  ): ArtifactWriter<
    IsmArtifactConfigs[T],
    SvmDeployedIsm,
    ArtifactComposition
  > {
    const writers: {
      [K in keyof IsmArtifactConfigs]?: () => ArtifactWriter<
        IsmArtifactConfigs[K],
        SvmDeployedIsm,
        ArtifactComposition
      >;
    } = {
      testIsm: () =>
        new SvmTestIsmWriter(
          { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.testIsm } },
          this.rpc,
          signer,
        ),
      domainRoutingIsm: () =>
        new SvmRoutingMultisigWriter(
          {
            program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.multisigIsm },
            candidateDomains: this.candidateDomains,
          },
          this.rpc,
          signer,
        ),
      messageIdMultisigIsm: () => {
        throw new Error(
          'On SVM, multisig validators are configured per-domain inside a routing-multisig program. Use type "domainRoutingIsm" instead.',
        );
      },
    };
    const factory = writers[type];
    if (!factory) throw new Error(`Unsupported ISM type: ${type}`);
    return factory();
  }

  private altVmToTypeKey(ismType: IsmType): keyof IsmArtifactConfigs {
    switch (ismType) {
      case IsmType.TEST_ISM:
        return 'testIsm';
      case IsmType.MESSAGE_ID_MULTISIG:
      case IsmType.ROUTING:
        return 'domainRoutingIsm';
      default:
        throw new Error(`Unsupported ISM type on Solana: ${ismType}`);
    }
  }
}
