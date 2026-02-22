import {
  address as parseAddress,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedIsmAddress,
  DeployedRawIsmArtifact,
  RawIsmArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/ism';

import type { SvmSigner } from '../signer.js';
import type { SvmProgramAddresses } from '../types.js';

import { detectIsmType } from './ism-query.js';
import {
  SvmMessageIdMultisigIsmReader,
  SvmMessageIdMultisigIsmWriter,
} from './multisig-ism.js';
import { SvmTestIsmReader, SvmTestIsmWriter } from './test-ism.js';

export type IsmInstructionFamily =
  | 'interchainSecurityModule'
  | 'multisigInterface'
  | 'multisigProgram';

export interface IsmProgramSelector {
  testIsmProgramAddress: Address;
  multisigIsmProgramAddress: Address;
}

export class SvmIsmArtifactManager {
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly programAddresses: SvmProgramAddresses,
  ) {}

  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const programId = parseAddress(address);
    const ismType = await detectIsmType(this.rpc, programId);
    const typeKey = this.altVmToTypeKey(ismType);
    const reader = this.createReaderForProgramId(typeKey, programId);
    return reader.read(address);
  }

  createReader<T extends keyof RawIsmArtifactConfigs>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const programId = this.getProgramIdForType(type);
    return this.createReaderForProgramId(type, programId);
  }

  createWriter<T extends keyof RawIsmArtifactConfigs>(
    type: T,
    signer: SvmSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const programId = this.getProgramIdForType(type);
    return this.createWriterForProgramId(type, programId, signer);
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

  private getProgramIdForType(type: keyof RawIsmArtifactConfigs): Address {
    const programIds: Record<keyof RawIsmArtifactConfigs, Address | null> = {
      testIsm: this.programAddresses.testIsm,
      messageIdMultisigIsm: this.programAddresses.multisigIsmMessageId,
      merkleRootMultisigIsm: null,
      domainRoutingIsm: null,
    };
    const programId = programIds[type];
    if (!programId) throw new Error(`Unsupported ISM type on Solana: ${type}`);
    return programId;
  }

  private createReaderForProgramId<T extends keyof RawIsmArtifactConfigs>(
    type: T,
    programId: Address,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const readers: {
      [K in keyof RawIsmArtifactConfigs]?: () => ArtifactReader<
        RawIsmArtifactConfigs[K],
        DeployedIsmAddress
      >;
    } = {
      testIsm: () => new SvmTestIsmReader(this.rpc, programId),
      messageIdMultisigIsm: () =>
        new SvmMessageIdMultisigIsmReader(this.rpc, programId),
    };
    const factory = readers[type];
    if (!factory) throw new Error(`Unsupported ISM type: ${type}`);
    return factory();
  }

  private createWriterForProgramId<T extends keyof RawIsmArtifactConfigs>(
    type: T,
    programId: Address,
    signer: SvmSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const writers: {
      [K in keyof RawIsmArtifactConfigs]?: () => ArtifactWriter<
        RawIsmArtifactConfigs[K],
        DeployedIsmAddress
      >;
    } = {
      testIsm: () => new SvmTestIsmWriter(this.rpc, programId, signer),
      messageIdMultisigIsm: () =>
        new SvmMessageIdMultisigIsmWriter(this.rpc, programId, signer),
    };
    const factory = writers[type];
    if (!factory) throw new Error(`Unsupported ISM type: ${type}`);
    return factory();
  }
}
