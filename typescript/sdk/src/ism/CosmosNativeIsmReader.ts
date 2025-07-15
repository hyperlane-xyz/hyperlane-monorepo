import {
  HyperlaneModuleClient,
  IsmTypes,
  SigningHyperlaneModuleClient,
} from '@hyperlane-xyz/cosmos-sdk';
import { isTypes } from '@hyperlane-xyz/cosmos-types';
import { Address, WithAddress, assert, rootLogger } from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';

import {
  DerivedIsmConfig,
  DomainRoutingIsmConfig,
  IsmType,
  MultisigIsmConfig,
} from './types.js';

export class CosmosNativeIsmReader {
  protected readonly logger = rootLogger.child({
    module: 'CosmosNativeIsmReader',
  });

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly cosmosProviderOrSigner:
      | HyperlaneModuleClient
      | SigningHyperlaneModuleClient,
  ) {}

  async deriveIsmConfig(address: Address): Promise<DerivedIsmConfig> {
    try {
      const { ism } =
        await this.cosmosProviderOrSigner.query.interchainSecurity.Ism({
          id: address,
        });

      assert(ism, `ISM with id ${address} not found`);

      switch (ism.type_url) {
        case IsmTypes.MerkleRootMultisigISM:
          return this.deriveMerkleRootMultisigConfig(address);
        case IsmTypes.MessageIdMultisigISM:
          return this.deriveMessageIdMultisigConfig(address);
        case IsmTypes.RoutingISM:
          return this.deriveRoutingConfig(address);
        case IsmTypes.NoopISM:
          return this.deriveTestConfig(address);
        default:
          throw new Error(`Unknown ISM ModuleType: ${ism.type_url}`);
      }
    } catch (error) {
      this.logger.error(`Failed to derive ISM config for ${address}`, error);
      throw error;
    }
  }

  private async deriveMerkleRootMultisigConfig(
    address: Address,
  ): Promise<WithAddress<MultisigIsmConfig>> {
    const { ism } =
      await this.cosmosProviderOrSigner.query.interchainSecurity.DecodedIsm<isTypes.MerkleRootMultisigISM>(
        {
          id: address,
        },
      );

    return {
      type: IsmType.MERKLE_ROOT_MULTISIG,
      address,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  private async deriveMessageIdMultisigConfig(
    address: Address,
  ): Promise<WithAddress<MultisigIsmConfig>> {
    const { ism } =
      await this.cosmosProviderOrSigner.query.interchainSecurity.DecodedIsm<isTypes.MessageIdMultisigISM>(
        {
          id: address,
        },
      );

    return {
      type: IsmType.MESSAGE_ID_MULTISIG,
      address,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  private async deriveRoutingConfig(
    address: Address,
  ): Promise<WithAddress<DomainRoutingIsmConfig>> {
    const { ism } =
      await this.cosmosProviderOrSigner.query.interchainSecurity.DecodedIsm<isTypes.RoutingISM>(
        {
          id: address,
        },
      );

    const domains: DomainRoutingIsmConfig['domains'] = {};

    for (const route of ism.routes) {
      const chainName = this.metadataManager.tryGetChainName(route.domain);
      if (!chainName) {
        this.logger.warn(
          `Unknown domain ID ${route.domain}, skipping domain configuration`,
        );
        continue;
      }

      domains[chainName] = await this.deriveIsmConfig(route.ism);
    }

    return {
      type: IsmType.ROUTING,
      address,
      owner: ism.owner,
      domains,
    };
  }

  private async deriveTestConfig(address: Address): Promise<DerivedIsmConfig> {
    return {
      type: IsmType.TEST_ISM,
      address,
    };
  }
}
