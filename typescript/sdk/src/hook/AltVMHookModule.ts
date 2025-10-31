import { zeroAddress } from 'viem';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { Address, assert, deepEquals, rootLogger } from '@hyperlane-xyz/utils';

import { ChainLookup } from '../altvm.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import {
  AnnotatedTypedTransaction,
  ProtocolReceipt,
} from '../providers/ProviderType.js';
import { ChainName } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';

import { AltVMHookReader, ChainMetadataForHook } from './AltVMHookReader.js';
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

export class AltVMHookModule<PT extends ProtocolType> extends HyperlaneModule<
  PT,
  HookConfig,
  HookModuleAddresses
> {
  protected readonly logger = rootLogger.child({
    module: 'AltVMHookModule',
  });
  protected readonly reader: AltVMHookReader;

  // Cached chain name
  public readonly chain: ChainName;

  constructor(
    protected readonly chainLookup: ChainLookup<ChainMetadataForHook>,
    params: HyperlaneModuleParams<HookConfig, HookModuleAddresses>,
    protected readonly signer: AltVM.ISigner<
      AnnotatedTypedTransaction<PT>,
      ProtocolReceipt<PT>
    >,
  ) {
    params.config = HookConfigSchema.parse(params.config);
    super(params);

    this.reader = new AltVMHookReader(chainLookup.getChainMetadata, signer);

    const metadata = chainLookup.getChainMetadata(this.args.chain);
    this.chain = metadata.name;
  }

  public async read(): Promise<HookConfig> {
    return this.reader.deriveHookConfig(this.args.addresses.deployedHook);
  }

  public async update(
    targetConfig: HookConfig,
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
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

    if (!MUTABLE_HOOK_TYPE.includes(normalizedTargetConfig.type)) {
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
  }): Promise<AnnotatedTypedTransaction<PT>[]> {
    const { current, target } = configs;
    let updateTxs: AnnotatedTypedTransaction<PT>[];

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

    return updateTxs;
  }

  protected async updateIgpHook({
    currentConfig,
    targetConfig,
  }: {
    currentConfig: IgpHookConfig;
    targetConfig: IgpHookConfig;
  }): Promise<AnnotatedTypedTransaction<PT>[]> {
    const updateTxs: AnnotatedTypedTransaction<PT>[] = [];

    for (const [remote, c] of Object.entries(targetConfig.oracleConfig)) {
      if (deepEquals(currentConfig.oracleConfig[remote], c)) {
        continue;
      }

      const remoteDomain = this.chainLookup.getDomainId(remote);
      if (remoteDomain === null) {
        this.logger.warn(`Skipping gas oracle ${this.chain} -> ${remote}.`);
        continue;
      }

      updateTxs.push({
        annotation: `Setting gas params for ${this.chain}`,
        ...(await this.signer.getSetDestinationGasConfigTransaction({
          signer: currentConfig.owner,
          hookAddress: this.args.addresses.deployedHook,
          destinationGasConfig: {
            remoteDomainId: remoteDomain,
            gasOracle: {
              tokenExchangeRate: c.tokenExchangeRate,
              gasPrice: c.gasPrice,
            },
            gasOverhead: targetConfig.overhead[remote].toString(),
          },
        })),
      });
    }

    // Lastly, check if the resolved owner is different from the current owner
    if (currentConfig.owner !== targetConfig.owner) {
      updateTxs.push({
        annotation: 'Transferring ownership of ownable Hook...',
        ...(await this.signer.getSetInterchainGasPaymasterHookOwnerTransaction({
          signer: currentConfig.owner,
          hookAddress: this.args.addresses.deployedHook,
          newOwner: targetConfig.owner,
        })),
      });
    }

    return updateTxs;
  }

  public static async create<PT extends ProtocolType>({
    chain,
    config,
    addresses,
    chainLookup,
    signer,
  }: {
    chain: string;
    config: HookConfig;
    addresses: HookModuleAddresses;
    chainLookup: ChainLookup<ChainMetadataForHook>;
    signer: AltVM.ISigner<AnnotatedTypedTransaction<PT>, ProtocolReceipt<PT>>;
  }): Promise<AltVMHookModule<PT>> {
    const module = new AltVMHookModule<PT>(
      chainLookup,
      { addresses, chain, config },
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
        throw new Error(`Hook type ${hookType} is not supported on AltVM`);
    }
  }

  protected async deployIgpHook({
    config,
  }: {
    config: IgpHookConfig;
  }): Promise<Address> {
    this.logger.debug('Deploying IGP as hook...');

    const { nativeToken } = this.chainLookup.getChainMetadata(this.chain);

    assert(nativeToken?.denom, `found no native token for chain ${this.chain}`);

    const { hookAddress } = await this.signer.createInterchainGasPaymasterHook({
      denom: nativeToken.denom,
    });

    for (const [remote, c] of Object.entries(config.oracleConfig)) {
      const remoteDomain = this.chainLookup.getDomainId(remote);
      if (remoteDomain === null) {
        this.logger.warn(`Skipping gas oracle ${this.chain} -> ${remote}.`);
        continue;
      }

      await this.signer.setDestinationGasConfig({
        hookAddress,
        destinationGasConfig: {
          remoteDomainId: remoteDomain,
          gasOverhead: config.overhead[remote].toString(),
          gasOracle: {
            tokenExchangeRate: c.tokenExchangeRate,
            gasPrice: c.gasPrice,
          },
        },
      });
    }

    if (this.signer.getSignerAddress() !== config.owner) {
      await this.signer.setInterchainGasPaymasterHookOwner({
        hookAddress,
        newOwner: config.owner,
      });
    }

    this.logger.debug(`Deployed IGP hook to ${hookAddress}`);
    return hookAddress;
  }

  protected async deployMerkleTreeHook(): Promise<Address> {
    this.logger.debug('Deploying Merkle Tree Hook...');

    const { hookAddress } = await this.signer.createMerkleTreeHook({
      mailboxAddress: this.args.addresses.mailbox,
    });

    this.logger.debug(`Deployed merkle tree hook to ${hookAddress}`);
    return hookAddress;
  }
}
