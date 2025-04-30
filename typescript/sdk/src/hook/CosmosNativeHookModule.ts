import { zeroAddress } from 'viem';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import {
  Address,
  ChainId,
  Domain,
  ProtocolType,
  deepEquals,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedCosmJsNativeTransaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';

import { CosmosNativeHookReader } from './CosmosNativeHookReader.js';
import {
  HookConfig,
  HookConfigSchema,
  HookType,
  IgpHookConfig,
} from './types.js';

type HookModuleAddresses = {
  deployedHook: Address;
  mailbox: Address;
};

export class CosmosNativeHookModule extends HyperlaneModule<
  ProtocolType.CosmosNative,
  HookConfig,
  HookModuleAddresses
> {
  protected readonly logger = rootLogger.child({
    module: 'CosmosNativeHookModule',
  });
  protected readonly reader: CosmosNativeHookReader;

  // Adding these to reduce how often we need to grab from MultiProvider.
  public readonly chain: ChainName;
  public readonly chainId: ChainId;
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    params: HyperlaneModuleParams<HookConfig, HookModuleAddresses>,
    protected readonly signer: SigningHyperlaneModuleClient,
  ) {
    params.config = HookConfigSchema.parse(params.config);
    super(params);

    this.reader = new CosmosNativeHookReader(multiProvider, signer);

    this.chain = multiProvider.getChainName(this.args.chain);
    this.chainId = multiProvider.getChainId(this.chain);
    this.domainId = multiProvider.getDomainId(this.chain);
  }

  public async read(): Promise<HookConfig> {
    return this.reader.deriveHookConfig(this.args.addresses.deployedHook);
  }

  public async update(
    targetConfig: HookConfig,
  ): Promise<AnnotatedCosmJsNativeTransaction[]> {
    // Nothing to do if its the default hook
    if (targetConfig === zeroAddress) {
      return Promise.resolve([]);
    }

    targetConfig = HookConfigSchema.parse(targetConfig);

    // Do not support updating to a custom Hook address
    if (typeof targetConfig === 'string') {
      throw new Error(
        'Invalid targetConfig: Updating to a custom Hook address is not supported. Please provide a valid Hook configuration.',
      );
    }

    // Update the config
    this.args.config = targetConfig;

    // We need to normalize the current and target configs to compare.
    const normalizedCurrentConfig = normalizeConfig(await this.read());
    const normalizedTargetConfig = normalizeConfig(targetConfig);

    // If configs match, no updates needed
    if (deepEquals(normalizedCurrentConfig, normalizedTargetConfig)) {
      return [];
    }

    this.args.addresses.deployedHook = await this.deploy({
      config: normalizedTargetConfig,
    });

    return [];
  }

  // manually write static create function
  public static async create({
    chain,
    config,
    addresses,
    multiProvider,
    signer,
  }: {
    chain: ChainNameOrId;
    config: HookConfig;
    addresses: HookModuleAddresses;
    multiProvider: MultiProvider;
    signer: SigningHyperlaneModuleClient;
  }): Promise<CosmosNativeHookModule> {
    const module = new CosmosNativeHookModule(
      multiProvider,
      {
        addresses,
        chain,
        config,
      },
      signer,
    );

    module.args.addresses.deployedHook = await module.deploy({ config });

    return module;
  }

  protected async deploy({ config }: { config: HookConfig }): Promise<Address> {
    config = HookConfigSchema.parse(config);

    if (typeof config === 'string') {
      return config;
    }
    const hookType = config.type;
    this.logger.info(`Deploying ${hookType} to ${this.chain}`);

    switch (hookType) {
      case HookType.INTERCHAIN_GAS_PAYMASTER:
        return this.deployIgpHook({ config });
      case HookType.MERKLE_TREE:
        return this.deployMerkleTreeHook();
      case HookType.MAILBOX_DEFAULT:
        return this.deployNoopHook();
      default:
        throw new Error(`Hook type ${hookType} is not supported on Cosmos`);
    }
  }

  protected async deployIgpHook({
    config,
  }: {
    config: IgpHookConfig;
  }): Promise<Address> {
    this.logger.debug('Deploying IGP as hook...');

    // TODO: what about denom?
    const { nativeToken } = this.multiProvider.getChainMetadata(this.chain);

    const { response: igp } = await this.signer.createIgp({
      denom: nativeToken?.denom ?? '',
    });

    for (const [remote, c] of Object.entries(config.oracleConfig)) {
      const remoteDomain = this.multiProvider.tryGetDomainId(remote);
      if (remoteDomain === null) {
        this.logger.warn(`Skipping gas oracle ${this.chain} -> ${remote}.`);
        continue;
      }

      await this.signer.setDestinationGasConfig({
        igp_id: igp.id,
        destination_gas_config: {
          remote_domain: remoteDomain,
          gas_overhead: config.overhead[remote].toString(),
          gas_oracle: {
            token_exchange_rate: c.tokenExchangeRate,
            gas_price: c.gasPrice,
          },
        },
      });
    }

    if (config.owner && this.signer.account.address !== config.owner) {
      await this.signer.setIgpOwner({
        igp_id: igp.id,
        new_owner: config.owner,
      });
    }

    return igp.id;
  }

  protected async deployMerkleTreeHook(): Promise<Address> {
    this.logger.debug('Deploying Merkle Tree Hook...');

    const { response: merkleTree } = await this.signer.createMerkleTreeHook({
      mailbox_id: this.args.addresses.mailbox,
    });

    return merkleTree.id;
  }

  protected async deployNoopHook(): Promise<Address> {
    this.logger.debug('Deploying Noop Hook...');

    const { response: noopResponse } = await this.signer.createNoopHook({});
    return noopResponse.id;
  }
}
