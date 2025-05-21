import { Account, num } from 'starknet';
import { zeroAddress } from 'viem';

import {
  Address,
  ChainId,
  Domain,
  ProtocolType,
  assert,
  deepEquals,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneModuleParams } from '../core/AbstractHyperlaneModule.js';
import { StarknetDeployer } from '../deploy/StarknetDeployer.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedStarknetTransaction } from '../providers/ProviderType.js';
import { PROTOCOL_TO_DEFAULT_NATIVE_TOKEN } from '../token/nativeTokenMetadata.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';
import {
  StarknetContractName,
  getStarknetContract,
} from '../utils/starknet.js';

import { StarknetHookReader } from './StarknetHookReader.js';
import {
  HookConfig,
  HookConfigSchema,
  HookType,
  ProtocolFeeHookConfig,
} from './types.js';

type StarknetHookModuleAddresses = {
  deployedHook: Address;
  mailbox: Address;
  // StarkNet doesn't have ProxyAdmin in the same way as EVM,
};

export class StarknetHookModule {
  protected readonly logger = rootLogger.child({
    module: 'StarknetHookModule',
  });
  protected readonly reader: StarknetHookReader;
  protected readonly deployer: StarknetDeployer;
  protected readonly multiProvider: MultiProvider;

  public readonly chainName: ChainName;
  public readonly chainId: ChainId;
  public readonly domainId: Domain;

  public readonly args: HyperlaneModuleParams<
    HookConfig,
    StarknetHookModuleAddresses
  >;

  constructor(
    protected readonly signer: Account,
    protected readonly multiProtocolProvider: MultiProtocolProvider,
    params: HyperlaneModuleParams<HookConfig, StarknetHookModuleAddresses>,
  ) {
    params.config = HookConfigSchema.parse(params.config);
    this.args = params;
    this.multiProvider = multiProtocolProvider.toMultiProvider();

    this.reader = new StarknetHookReader(
      this.multiProtocolProvider,
      this.args.chain,
    );
    this.deployer = new StarknetDeployer(signer, this.multiProvider);

    this.chainName = this.multiProvider.getChainName(this.args.chain);
    this.chainId = this.multiProvider.getChainId(this.chainName);
    this.domainId = this.multiProvider.getDomainId(this.chainName);
  }

  public async read(): Promise<HookConfig> {
    return typeof this.args.config === 'string'
      ? this.args.addresses.deployedHook
      : this.reader.deriveHookConfig(this.args.addresses.deployedHook);
  }

  public async update(
    targetConfig: HookConfig,
  ): Promise<AnnotatedStarknetTransaction[]> {
    if (targetConfig === zeroAddress) {
      return Promise.resolve([]);
    }

    targetConfig = HookConfigSchema.parse(targetConfig);

    const derivedTargetConfig =
      await this.reader.deriveHookConfig(targetConfig);

    this.args.config = derivedTargetConfig;

    const currentConfig = await this.read();
    const normalizedCurrentConfig = currentConfig;
    const normalizedTargetConfig = normalizeConfig(targetConfig);

    if (deepEquals(normalizedCurrentConfig, normalizedTargetConfig)) {
      return [];
    }

    if (
      this.shouldDeployNewHook(
        normalizedCurrentConfig,
        normalizedTargetConfig as Exclude<HookConfig, string>, // Type assertion
      )
    ) {
      const contractAddress = await this.deploy({
        config: normalizedTargetConfig,
      });
      this.args.addresses.deployedHook = contractAddress;
      return [];
    }

    const updateTxs: AnnotatedStarknetTransaction[] = [];

    switch ((normalizedTargetConfig as Exclude<HookConfig, string>).type) {
      case HookType.PROTOCOL_FEE:
        updateTxs.push(
          ...(await this.updateProtocolFeeHook({
            currentConfig: normalizedCurrentConfig as ProtocolFeeHookConfig,
            targetConfig: normalizedTargetConfig as ProtocolFeeHookConfig,
          })),
        );
        break;
      case HookType.MERKLE_TREE:
        this.logger.info(
          'MerkleTreeHook is typically not updated directly beyond ownership.',
        );
        break;
      default:
        throw new Error(
          `Unsupported hook type for StarkNet: ${
            (normalizedTargetConfig as Exclude<HookConfig, string>).type
          }`,
        );
    }

    // Ownership transfer (if applicable and ownable)
    if (
      typeof normalizedTargetConfig !== 'string' &&
      normalizedTargetConfig.owner
    ) {
      const hookContract = getStarknetContract(
        // We need a generic way to get a contract for ownership check,
        // or rely on specific contract names based on type.
        // This is a simplification.
        this.getContractNameForHookType(
          (normalizedTargetConfig as Exclude<HookConfig, string>).type,
        ),
        this.args.addresses.deployedHook,
        this.signer, // Or provider for read-only
      );
      let currentOwner: string | undefined;
      try {
        currentOwner = await hookContract
          .owner()
          .then((o: any) => num.toHex(o));
      } catch (e) {
        this.logger.debug(
          `Could not read owner of hook ${this.args.addresses.deployedHook}, it might not be ownable.`,
        );
      }

      if (
        currentOwner &&
        !eqAddress(normalizedTargetConfig.owner, currentOwner)
      ) {
        updateTxs.push({
          contractAddress: this.args.addresses.deployedHook,
          entrypoint: 'transfer_ownership', // Common StarkNet entrypoint
          calldata: [normalizedTargetConfig.owner],
          annotation: `Transferring ownership of StarkNet Hook to ${normalizedTargetConfig.owner}`,
        });
      }
    }

    return updateTxs;
  }

  // Simplified deploy, focusing on supported types
  protected async deploy({ config }: { config: HookConfig }): Promise<Address> {
    if (typeof config === 'string') {
      // If it's an address, assume it's already deployed.
      // StarkNet doesn't have a direct "connect" equivalent for arbitrary addresses without ABI.
      // We'd typically need to know the contract type/ABI to interact.
      return config;
    }

    this.logger.debug(`Deploying StarkNet hook of type ${config.type}`);

    switch (config.type) {
      //   case HookType.MERKLE_TREE:
      //     return this.deployMerkleTreeHook({
      //       config: config as MerkleTreeHookConfig,
      //     });
      case HookType.PROTOCOL_FEE:
        return this.deployProtocolFeeHook({
          config: config as ProtocolFeeHookConfig,
        });
      default:
        throw new Error(
          `Unsupported StarkNet hook config type: ${config.type}`,
        );
    }
  }

  //   protected async deployMerkleTreeHook({
  //     config,
  //   }: {
  //     config: MerkleTreeHookConfig;
  //   }): Promise<Address> {
  //     this.logger.debug('Deploying StarkNet MerkleTreeHook...');
  //     assert(config.owner, 'Owner is required for StarkNet MerkleTreeHook');
  //     return this.deployer.deployContract(
  //       StarknetContractName.MERKLE_TREE_HOOK, // Ensure this exists and is correct
  //       [this.args.addresses.mailbox, config.owner],
  //     );
  //   }

  protected async deployProtocolFeeHook({
    config,
  }: {
    config: ProtocolFeeHookConfig;
  }): Promise<Address> {
    this.logger.debug('Deploying StarkNet ProtocolFeeHook...');

    const feeTokenAddress = PROTOCOL_TO_DEFAULT_NATIVE_TOKEN[
      ProtocolType.Starknet
    ]!.denom as string;
    assert(config.owner, 'Owner is required for StarkNet ProtocolFeeHook');
    return this.deployer.deployContract(StarknetContractName.PROTOCOL_FEE, [
      config.maxProtocolFee,
      config.protocolFee,
      config.beneficiary,
      config.owner,
      feeTokenAddress,
    ]);
  }

  protected async updateProtocolFeeHook({
    currentConfig,
    targetConfig,
  }: {
    currentConfig: ProtocolFeeHookConfig;
    targetConfig: ProtocolFeeHookConfig;
  }): Promise<AnnotatedStarknetTransaction[]> {
    const updateTxs: AnnotatedStarknetTransaction[] = [];
    const contractAddress = this.args.addresses.deployedHook;

    // On StarkNet, immutable parameters like maxProtocolFee often require redeployment.
    if (currentConfig.maxProtocolFee !== targetConfig.maxProtocolFee) {
      this.logger.warn(
        'maxProtocolFee changed for StarkNet ProtocolFeeHook. This typically requires redeployment.',
      );
      // For simplicity in this port, we are not handling automatic redeployment on immutable param change.
      // Consumer should be aware and handle this.
      // Alternatively, one could throw an error or implement redeploy logic here.
    }

    if (currentConfig.protocolFee !== targetConfig.protocolFee) {
      updateTxs.push({
        contractAddress,
        entrypoint: 'set_protocol_fee', // StarkNet selector
        calldata: [targetConfig.protocolFee],
        annotation: `Updating StarkNet protocol fee to ${targetConfig.protocolFee}`,
      });
    }

    if (!eqAddress(currentConfig.beneficiary, targetConfig.beneficiary)) {
      updateTxs.push({
        contractAddress,
        entrypoint: 'set_beneficiary', // StarkNet selector
        calldata: [targetConfig.beneficiary],
        annotation: `Updating StarkNet beneficiary to ${targetConfig.beneficiary}`,
      });
    }
    // Owner update is handled generically after the switch.
    return updateTxs;
  }

  private shouldDeployNewHook(
    currentConfig: HookConfig,
    targetConfig: Exclude<HookConfig, string>,
  ): boolean {
    if (typeof currentConfig === 'string') return true;
    if (currentConfig.type !== targetConfig.type) return true;

    if (targetConfig.type === HookType.PROTOCOL_FEE) {
      const currentPF = currentConfig as ProtocolFeeHookConfig;
      const targetPF = targetConfig as ProtocolFeeHookConfig;
      if (currentPF.maxProtocolFee !== targetPF.maxProtocolFee) {
        this.logger.warn(
          `maxProtocolFee change detected for ProtocolFeeHook (${currentPF.maxProtocolFee} -> ${targetPF.maxProtocolFee}). Redeployment is necessary.`,
        );
        return true;
      }
    }

    // TODO: return !MUTABLE_HOOK_TYPE_STARKNET.includes(targetConfig.type);
    // rn redeploying each hook
    return true;
  }

  private getContractNameForHookType(hookType: HookType): StarknetContractName {
    switch (hookType) {
      case HookType.MERKLE_TREE:
        return StarknetContractName.MERKLE_TREE_HOOK;
      case HookType.PROTOCOL_FEE:
        return StarknetContractName.PROTOCOL_FEE;
      default:
        this.logger.warn(
          `Cannot determine specific contract name for hook type ${hookType} for generic operations. Falling back to a generic hook name.`,
        );
        return StarknetContractName.HOOK;
    }
  }

  public static async create({
    chain,
    config,
    mailboxAddress,
    signer,
    multiProtocolProvider,
  }: {
    chain: ChainNameOrId;
    config: HookConfig;
    mailboxAddress: Address;
    signer: Account;
    multiProtocolProvider: MultiProtocolProvider;
  }): Promise<StarknetHookModule> {
    const initialDeployedHook =
      typeof config === 'string' ? config : zeroAddress;

    const module = new StarknetHookModule(signer, multiProtocolProvider, {
      addresses: {
        deployedHook: initialDeployedHook,
        mailbox: mailboxAddress,
      },
      chain,
      config,
    });

    if (initialDeployedHook === zeroAddress && typeof config !== 'string') {
      const deployedHookAddress = await module.deploy({ config });
      module.args.addresses.deployedHook = deployedHookAddress;
      if (typeof module.args.config !== 'string') {
        module.args.config =
          await module.reader.deriveHookConfig(deployedHookAddress);
      }
    }
    return module;
  }

  serialize() {
    return this.args.addresses;
  }
}
