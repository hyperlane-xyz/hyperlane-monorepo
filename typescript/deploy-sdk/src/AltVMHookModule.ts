import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DerivedHookConfig,
  HookConfig,
  HookModuleAddresses,
  HookModuleType,
  HookType,
  IgpHookConfig,
  MUTABLE_HOOK_TYPE,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  AnnotatedTx,
  HypModule,
  HypModuleArgs,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import {
  Address,
  Logger,
  assert,
  deepEquals,
  isZeroishAddress,
  normalizeConfig,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { AltVMHookReader } from './AltVMHookReader.js';

export class AltVMHookModule implements HypModule<HookModuleType> {
  protected readonly logger: Logger = rootLogger.child({
    module: 'AltVMHookModule',
  });
  protected readonly reader: AltVMHookReader;

  // Cached chain name
  public readonly chain: string;

  constructor(
    protected readonly chainLookup: ChainLookup,
    private readonly args: HypModuleArgs<HookModuleType>,
    protected readonly signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
  ) {
    this.reader = new AltVMHookReader(chainLookup.getChainMetadata, signer);

    const metadata = chainLookup.getChainMetadata(this.args.chain);
    this.chain = metadata.name;
  }

  public async read(): Promise<DerivedHookConfig> {
    return this.reader.deriveHookConfig(this.args.addresses.deployedHook);
  }

  public serialize(): HookModuleAddresses {
    return this.args.addresses;
  }

  public async update(
    targetConfig: HookConfig | Address,
  ): Promise<AnnotatedTx[]> {
    // Nothing to do if its the default hook
    if (typeof targetConfig === 'string' && isZeroishAddress(targetConfig)) {
      return Promise.resolve([]);
    }

    // We need to normalize the current and target configs to compare.
    const normalizedCurrentConfig = normalizeConfig(await this.read());
    const normalizedTargetConfig = normalizeConfig(targetConfig);

    // If configs match, no updates needed
    if (deepEquals(normalizedCurrentConfig, normalizedTargetConfig)) {
      return [];
    }

    // Do not support updating to a custom Hook address
    if (typeof normalizedTargetConfig === 'string') {
      throw new Error(
        'Invalid targetConfig: Updating to a custom Hook address is not supported. Please provide a valid Hook configuration.',
      );
    }

    // Update the module config to the target one as we are sure now that an update will be needed
    this.args.config = normalizedTargetConfig;

    // Conditions for deploying a new hook:
    // - If updating from an address/custom config to a proper hook config.
    // - If updating a proper hook config whose types are different.
    // - If it is not a mutable Hook.
    if (
      typeof normalizedCurrentConfig === 'string' ||
      normalizedTargetConfig.type !== normalizedCurrentConfig.type ||
      !MUTABLE_HOOK_TYPE.includes(normalizedTargetConfig.type)
    ) {
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
  }): Promise<AnnotatedTx[]> {
    const { current, target } = configs;
    let updateTxs: AnnotatedTx[];

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
      current.type === 'interchainGasPaymaster' &&
      target.type === 'interchainGasPaymaster'
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
  }): Promise<AnnotatedTx[]> {
    const updateTxs: AnnotatedTx[] = [];

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

  public static async create({
    chain,
    config,
    addresses,
    chainLookup,
    signer,
  }: {
    chain: string;
    config: HookConfig | string;
    addresses: HookModuleAddresses;
    chainLookup: ChainLookup;
    signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  }): Promise<AltVMHookModule> {
    const module = new AltVMHookModule(
      chainLookup,
      { addresses, chain, config },
      signer,
    );

    module.args.addresses.deployedHook = await module.deploy({ config });

    return module;
  }

  protected async deploy({
    config,
  }: {
    config: HookConfig | string;
  }): Promise<Address> {
    if (typeof config === 'string') {
      return config;
    }
    const hookType = config.type;
    this.logger.info(`Deploying ${hookType} to ${this.chain}`);

    switch (hookType) {
      case 'interchainGasPaymaster':
        return this.deployIgpHook({ config });
      case 'merkleTreeHook':
        return this.deployMerkleTreeHook();
      default:
        throw new Error(
          `Hook type ${hookType as HookType} is not supported on AltVM`,
        );
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
      mailboxAddress: this.args.addresses.mailbox,
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
