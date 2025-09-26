import { RadixSigningSDK } from '@hyperlane-xyz/radix-sdk';
import {
  Address,
  ChainId,
  Domain,
  ProtocolType,
  assert,
  deepEquals,
  eqAddress,
  isNullish,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedRadixTransaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';

import { RadixHookReader } from './RadixHookReader.js';
import {
  HookConfig,
  HookConfigSchema,
  HookType,
  IgpHookConfig,
  MUTABLE_HOOK_TYPE,
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

  public async update(
    targetConfig: HookConfig,
  ): Promise<AnnotatedRadixTransaction[]> {
    if (typeof targetConfig === 'string' && isZeroishAddress(targetConfig)) {
      return [];
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

    if (!MUTABLE_HOOK_TYPE.includes(normalizedTargetConfig.target)) {
      this.args.addresses.deployedHook = await this.deploy({
        config: normalizedTargetConfig,
      });

      return [];
    }

    return this.updateMutableHook({
      current: normalizedCurrentConfig,
      target: normalizedTargetConfig,
    });
  }

  protected async updateMutableHook(configs: {
    current: Exclude<HookConfig, string>;
    target: Exclude<HookConfig, string>;
  }): Promise<AnnotatedRadixTransaction[]> {
    const { current, target } = configs;
    let updateTxs: AnnotatedRadixTransaction[];

    assert(
      current.type === target.type,
      `Mutable hook update requires both hook configs to be of the same type. Expected ${current.type}, got ${target.type}`,
    );
    assert(
      MUTABLE_HOOK_TYPE.includes(current.type),
      'Expected update config to be of mutable hook type',
    );
    // Checking both objects type fields to help typescript narrow the type down correctly
    if (
      current.type === HookType.INTERCHAIN_GAS_PAYMASTER &&
      target.type === HookType.INTERCHAIN_GAS_PAYMASTER
    ) {
      updateTxs = await this.updateIgpHook({
        currentConfig: current,
        targetConfig: target,
      });
    } else {
      throw new Error(`Unsupported hook type: ${target.type}`);
    }

    // Lastly, check if the resolved owner is different from the current owner
    if (!eqAddress(this.signer.getAddress(), target.owner)) {
      updateTxs.push({
        annotation: 'Transferring ownership of ownable Hook...',
        networkId: this.signer.getNetworkId(),
        manifest: await this.signer.populate.core.setIgpOwner({
          from_address: this.signer.getAddress(),
          igp: this.args.addresses.deployedHook,
          new_owner: target.owner,
        }),
      });
    }

    return updateTxs;
  }

  protected async updateIgpHook({
    currentConfig,
    targetConfig,
  }: {
    currentConfig: IgpHookConfig;
    targetConfig: IgpHookConfig;
  }): Promise<AnnotatedRadixTransaction[]> {
    const updateTxs: AnnotatedRadixTransaction[] = [];

    for (const [remote, c] of Object.entries(targetConfig.oracleConfig)) {
      if (deepEquals(currentConfig.oracleConfig[remote], c)) {
        continue;
      }

      const remoteDomain = this.metadataManager.tryGetDomainId(remote);
      if (remoteDomain === null) {
        this.logger.warn(`Skipping gas oracle ${this.chain} -> ${remote}.`);
        continue;
      }

      updateTxs.push({
        annotation: `Setting gas params for ${this.chain}`,
        networkId: this.signer.getNetworkId(),
        manifest: await this.signer.populate.core.setDestinationGasConfig({
          from_address: this.signer.getAddress(),
          igp: this.args.addresses.deployedHook,
          destination_gas_config: {
            remote_domain: remoteDomain.toString(),
            gas_oracle: {
              token_exchange_rate: c.tokenExchangeRate,
              gas_price: c.gasPrice,
            },
            gas_overhead: targetConfig.overhead[remote].toString(),
          },
        }),
      });
    }

    return updateTxs;
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

    assert(
      nativeToken?.denom,
      `found no native token denom for chain ${this.chain}`,
    );

    const igp = await this.signer.tx.core.createIgp({
      denom: nativeToken.denom,
    });

    for (const [remote, c] of Object.entries(config.oracleConfig)) {
      const remoteDomain = this.metadataManager.tryGetDomainId(remote);
      if (isNullish(remoteDomain)) {
        this.logger.warn(`Skipping gas oracle ${this.chain} -> ${remote}.`);
        continue;
      }

      await this.signer.tx.core.setDestinationGasConfig({
        igp,
        destination_gas_config: {
          remote_domain: remoteDomain.toString(),
          gas_oracle: {
            token_exchange_rate: c.tokenExchangeRate,
            gas_price: c.gasPrice,
          },
          gas_overhead: config.overhead[remote].toString(),
        },
      });
    }

    if (!eqAddress(this.signer.getAddress(), config.owner)) {
      await this.signer.tx.core.setIgpOwner({
        igp,
        new_owner: config.owner,
      });
    }

    return igp;
  }

  protected async deployMerkleTreeHook(): Promise<Address> {
    this.logger.debug('Deploying Merkle Tree Hook...');

    return this.signer.tx.core.createMerkleTreeHook({
      mailbox: this.args.addresses.mailbox,
    });
  }
}
