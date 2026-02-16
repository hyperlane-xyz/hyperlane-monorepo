import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedValidatorAnnounceAddress,
  type IRawValidatorAnnounceArtifactManager,
  type RawValidatorAnnounceArtifactConfigs,
  type ValidatorAnnounceType,
} from '@hyperlane-xyz/provider-sdk/validator-announce';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';
import { MAINNET_PREFIX, TESTNET_PREFIX } from '../utils/helper.js';
import { AleoNetworkId, type OnChainArtifactManagers } from '../utils/types.js';

import {
  AleoValidatorAnnounceReader,
  AleoValidatorAnnounceWriter,
} from './validator-announce.js';

/**
 * Aleo ValidatorAnnounce Artifact Manager implementing IRawValidatorAnnounceArtifactManager.
 *
 * This manager:
 * - Provides factory methods for creating validator announce readers and writers
 * - Handles validator announce deployment
 */
export class AleoValidatorAnnounceArtifactManager
  implements IRawValidatorAnnounceArtifactManager
{
  private readonly onChainArtifactManagers: OnChainArtifactManagers;

  constructor(
    private readonly aleoClient: AnyAleoNetworkClient,
    chainId: number,
  ) {
    // Determine prefix from chain ID
    const prefix =
      chainId === AleoNetworkId.TESTNET ? TESTNET_PREFIX : MAINNET_PREFIX;

    // Construct ISM manager address (same logic as AleoBase)
    const ismManagerSuffix = process.env['ALEO_ISM_MANAGER_SUFFIX'];
    const ismManagerAddress = ismManagerSuffix
      ? `${prefix}_ism_manager_${ismManagerSuffix}.aleo`
      : `${prefix}_ism_manager.aleo`;

    this.onChainArtifactManagers = {
      ismManagerAddress,
      hookManagerAddress: '', // Ignored - derived from mailbox address in getMailboxConfig
    };
  }

  async readValidatorAnnounce(address: string) {
    const reader = this.createReader('validatorAnnounce');
    return reader.read(address);
  }

  createReader<T extends ValidatorAnnounceType>(
    _type: T,
  ): ArtifactReader<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    return new AleoValidatorAnnounceReader(this.aleoClient);
  }

  createWriter<T extends ValidatorAnnounceType>(
    _type: T,
    signer: AleoSigner,
  ): ArtifactWriter<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    return new AleoValidatorAnnounceWriter(
      this.aleoClient,
      signer,
      this.onChainArtifactManagers,
    );
  }
}
