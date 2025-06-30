import {
  HyperlaneModuleClient,
  SigningHyperlaneModuleClient,
} from '@hyperlane-xyz/cosmos-sdk';
import { Address, WithAddress, assert, rootLogger } from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';

import {
  DerivedHookConfig,
  HookType,
  IgpHookConfig,
  MailboxDefaultHookConfig,
  MerkleTreeHookConfig,
} from './types.js';

export class CosmosNativeHookReader {
  protected readonly logger = rootLogger.child({
    module: 'CosmosNativeHookReader',
  });

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly cosmosProviderOrSigner:
      | HyperlaneModuleClient
      | SigningHyperlaneModuleClient,
  ) {}

  async deriveHookConfig(address: Address): Promise<DerivedHookConfig> {
    try {
      if (await this.isIgpHook(address)) {
        return this.deriveIgpConfig(address);
      } else if (await this.isMerkleTreeHook(address)) {
        return this.deriveMerkleTreeConfig(address);
      } else if (await this.isNoopHook(address)) {
        return this.deriveNoopConfig(address);
      } else {
        throw new Error(`Unsupported hook type for address: ${address}`);
      }
    } catch (error) {
      this.logger.error(`Failed to derive Hook config for ${address}`, error);
      throw error;
    }
  }

  private async deriveIgpConfig(
    address: Address,
  ): Promise<WithAddress<IgpHookConfig>> {
    const { igp } = await this.cosmosProviderOrSigner.query.postDispatch.Igp({
      id: address,
    });

    assert(igp, `IGP not found for address ${address}`);

    const { destination_gas_configs } =
      await this.cosmosProviderOrSigner.query.postDispatch.DestinationGasConfigs(
        {
          id: igp.id,
        },
      );

    const overhead: IgpHookConfig['overhead'] = {};
    const oracleConfig: IgpHookConfig['oracleConfig'] = {};

    destination_gas_configs.forEach((gasConfig) => {
      const { name, nativeToken } = this.metadataManager.getChainMetadata(
        gasConfig.remote_domain,
      );
      overhead[name] = parseInt(gasConfig.gas_overhead);
      oracleConfig[name] = {
        gasPrice: gasConfig.gas_oracle?.gas_price ?? '',
        tokenExchangeRate: gasConfig.gas_oracle?.token_exchange_rate ?? '',
        tokenDecimals: nativeToken?.decimals,
      };
    });

    return {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      owner: igp.owner,
      beneficiary: igp.owner,
      oracleKey: igp.owner,
      overhead,
      oracleConfig,
      address: igp.id,
    };
  }

  private async deriveMerkleTreeConfig(
    address: Address,
  ): Promise<WithAddress<MerkleTreeHookConfig>> {
    const { merkle_tree_hook } =
      await this.cosmosProviderOrSigner.query.postDispatch.MerkleTreeHook({
        id: address,
      });

    assert(
      merkle_tree_hook,
      `Merkle Tree Hook not found for address ${address}`,
    );

    return {
      type: HookType.MERKLE_TREE,
      address: merkle_tree_hook.id,
    };
  }

  private async deriveNoopConfig(
    address: Address,
  ): Promise<WithAddress<MailboxDefaultHookConfig>> {
    const { noop_hook } =
      await this.cosmosProviderOrSigner.query.postDispatch.NoopHook({
        id: address,
      });

    assert(noop_hook, `Noop Hook not found for address ${address}`);

    return {
      type: HookType.MAILBOX_DEFAULT,
      address: noop_hook.id,
    };
  }

  private async isIgpHook(address: Address): Promise<boolean> {
    try {
      const { igp } = await this.cosmosProviderOrSigner.query.postDispatch.Igp({
        id: address,
      });
      return !!igp;
    } catch {
      return false;
    }
  }

  private async isMerkleTreeHook(address: Address): Promise<boolean> {
    try {
      const { merkle_tree_hook } =
        await this.cosmosProviderOrSigner.query.postDispatch.MerkleTreeHook({
          id: address,
        });
      return !!merkle_tree_hook;
    } catch {
      return false;
    }
  }

  private async isNoopHook(address: Address): Promise<boolean> {
    try {
      const { noop_hook } =
        await this.cosmosProviderOrSigner.query.postDispatch.NoopHook({
          id: address,
        });
      return !!noop_hook;
    } catch {
      return false;
    }
  }
}
