import { zeroAddress } from 'viem';

import { RadixSigningSDK } from '@hyperlane-xyz/radix-sdk';
import {
  Address,
  ChainId,
  Domain,
  ProtocolType,
  assert,
  deepEquals,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';

import { RadixHookReader } from './RadixHookReader.js';
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

export class RadixHookModule extends HyperlaneModule<
  ProtocolType.Radix,
  HookConfig,
  HookModuleAddresses
> {
  protected readonly logger = rootLogger.child({
    module: 'RadixHookModule',
  });
  protected readonly reader: RadixHookReader;

  // Adding these to reduce how often we need to grab from ChainMetadataManager.
  public readonly chain: ChainName;
  public readonly chainId: ChainId;
  public readonly domainId: Domain;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    params: HyperlaneModuleParams<HookConfig, HookModuleAddresses>,
    protected readonly signer: RadixSigningSDK,
  ) {
    params.config = HookConfigSchema.parse(params.config);
    super(params);

    this.reader = new RadixHookReader(metadataManager, signer);

    this.chain = metadataManager.getChainName(this.args.chain);
    this.chainId = metadataManager.getChainId(this.chain);
    this.domainId = metadataManager.getDomainId(this.chain);
  }

  public async read(): Promise<HookConfig> {
    return this.reader.deriveHookConfig(this.args.addresses.deployedHook);
  }

  public async update(targetConfig: HookConfig): Promise<string[]> {
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

    this.args.config = targetConfig;

    // We need to normalize the current and target configs to compare.
    const normalizedCurrentConfig = normalizeConfig(await this.read());
    const normalizedTargetConfig = normalizeConfig(targetConfig);

    if (deepEquals(normalizedCurrentConfig, normalizedTargetConfig)) {
      return [];
    }

    this.args.addresses.deployedHook = await this.deploy({
      config: normalizedTargetConfig,
    });

    return [];
  }

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
    signer: RadixSigningSDK;
  }): Promise<RadixHookModule> {
    const module = new RadixHookModule(
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
      default:
        throw new Error(`Hook type ${hookType} is not supported on Radix`);
    }
  }

  protected async deployIgpHook({
    config,
  }: {
    config: IgpHookConfig;
  }): Promise<Address> {
    this.logger.debug('Deploying IGP as hook...');

    const { nativeToken } = this.metadataManager.getChainMetadata(this.chain);

    assert(nativeToken?.denom, `found no native token for chain ${this.chain}`);

    // TODO: RADIX
    // set destination gas configs
    return this.signer.createIgp(nativeToken.denom);
  }

  protected async deployMerkleTreeHook(): Promise<Address> {
    this.logger.debug('Deploying Merkle Tree Hook...');

    return this.signer.createMerkleTreeHook(this.args.addresses.mailbox);
  }
}
