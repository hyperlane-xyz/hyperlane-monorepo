import {
  HyperlaneModuleClient,
  IsmTypes,
  SigningHyperlaneModuleClient,
} from '@hyperlane-xyz/cosmos-sdk';
import { isTypes } from '@hyperlane-xyz/cosmos-types';
import {
  Address,
  ProtocolType,
  WithAddress,
  assert,
  concurrentMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

import { EvmIsmReader } from './EvmIsmReader.js';
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
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
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

    const domainIds = ism.routes.map((r) => r.domain);
    const domains: DomainRoutingIsmConfig['domains'] = {};

    await concurrentMap(1, domainIds, async (domainId) => {
      const metadata = this.multiProvider.tryGetChainMetadata(domainId);
      if (!metadata) {
        this.logger.warn(
          `Unknown domain ID ${domainId}, skipping domain configuration`,
        );
        return;
      }

      switch (metadata.protocol) {
        case ProtocolType.Ethereum: {
          domains[metadata.name] = await new EvmIsmReader(
            this.multiProvider,
            this.chain,
          ).deriveIsmConfig(address);
          break;
        }
        case ProtocolType.CosmosNative: {
          domains[metadata.name] = await this.deriveIsmConfig(address);
          break;
        }
        default: {
          this.logger.warn(
            `Protocol type ${metadata.protocol} not supported, skipping domain configuration`,
          );
          return;
        }
      }
    });

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
