import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';

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
    const programId = address as Address;
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
    switch (type) {
      case 'testIsm':
        return this.programAddresses.testIsm;
      case 'messageIdMultisigIsm':
        return this.programAddresses.multisigIsmMessageId;
      case 'merkleRootMultisigIsm':
        throw new Error('Merkle root multisig ISM not supported on Solana');
      case 'domainRoutingIsm':
        throw new Error('Domain routing ISM not supported on Solana');
      default:
        throw new Error(`Unknown ISM type: ${type}`);
    }
  }

  private createReaderForProgramId<T extends keyof RawIsmArtifactConfigs>(
    type: T,
    programId: Address,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case 'testIsm':
        return new SvmTestIsmReader(
          this.rpc,
          programId,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case 'messageIdMultisigIsm':
        return new SvmMessageIdMultisigIsmReader(
          this.rpc,
          programId,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      default:
        throw new Error(`Unsupported ISM type: ${type}`);
    }
  }

  private createWriterForProgramId<T extends keyof RawIsmArtifactConfigs>(
    type: T,
    programId: Address,
    signer: SvmSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case 'testIsm':
        return new SvmTestIsmWriter(
          this.rpc,
          programId,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case 'messageIdMultisigIsm':
        return new SvmMessageIdMultisigIsmWriter(
          this.rpc,
          programId,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      default:
        throw new Error(`Unsupported ISM type: ${type}`);
    }
  }
}
