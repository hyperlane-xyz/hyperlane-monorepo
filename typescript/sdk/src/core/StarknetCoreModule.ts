import { BigNumber } from 'ethers';
import { Account, MultiType } from 'starknet';

import {
  ChainId,
  Domain,
  ProtocolType,
  assert,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { transferOwnershipTransactionsStarknet } from '../contracts/contracts.js';
import { StarknetDeployer } from '../deploy/StarknetDeployer.js';
import { HookType } from '../hook/types.js';
import { StarknetIsmModule } from '../ism/StarknetIsmModule.js';
import { DerivedIsmConfig, IsmConfig } from '../ism/types.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  AnnotatedStarknetTransaction,
  StarknetJsTransaction,
} from '../providers/ProviderType.js';
import { PROTOCOL_TO_DEFAULT_NATIVE_TOKEN } from '../token/nativeTokenMetadata.js';
import { ChainName, ChainNameOrId } from '../types.js';
import {
  StarknetContractName,
  getStarknetMailboxContract,
} from '../utils/starknet.js';

import { HyperlaneModuleParams } from './AbstractHyperlaneModule.js';
import { StarknetCoreReader } from './StarknetCoreReader.js';
import {
  CoreConfig,
  DeployedCoreAddresses,
  DerivedCoreConfig,
} from './types.js';

export class StarknetCoreModule {
  protected logger = rootLogger.child({ module: 'StarknetCoreModule' });
  protected deployer: StarknetDeployer;
  protected coreReader: StarknetCoreReader;
  protected readonly multiProvider: MultiProvider;

  public readonly chainName: ChainName;
  public readonly chainId: ChainId;
  public readonly domainId: Domain;

  public readonly args:
    | HyperlaneModuleParams<CoreConfig, DeployedCoreAddresses>
    | undefined;

  constructor(
    protected readonly signer: Account,
    protected readonly multiProtocolProvider: MultiProtocolProvider,
    protected readonly chain: ChainNameOrId,
    args?: HyperlaneModuleParams<CoreConfig, DeployedCoreAddresses>,
  ) {
    this.multiProvider = multiProtocolProvider.toMultiProvider();

    this.chainName = this.multiProvider.getChainName(chain);
    this.chainId = this.multiProvider.getChainId(chain);
    this.domainId = this.multiProvider.getDomainId(chain);
    this.args = args ?? undefined;

    this.coreReader = new StarknetCoreReader(multiProtocolProvider, chain);
    this.deployer = new StarknetDeployer(signer, this.multiProvider);
  }

  /**
   * Reads the core configuration from the mailbox address
   * @returns The core config.
   */
  public async read(): Promise<DerivedCoreConfig> {
    assert(this.args, 'StarknetCoreModule must be initialized with args');
    return this.coreReader.deriveCoreConfig(this.args.addresses.mailbox);
  }

  public async readOwner(mailbox: string): Promise<string> {
    return this.coreReader.deriveOwner(mailbox);
  }

  async deploy(params: {
    config: CoreConfig;
    chain: ChainNameOrId;
  }): Promise<Record<string, string>> {
    const { config, chain } = params;
    assert(
      typeof config.requiredHook !== 'string',
      'string required hook is not accepted',
    );
    assert(
      config.requiredHook.type === HookType.PROTOCOL_FEE,
      'only protocolFee hook is accepted for required hook',
    );

    // Deploy core components in sequence:
    // 1. NoopISM - A basic interchain security module that performs no validation
    const noopIsm = await this.deployer.deployContract(
      StarknetContractName.NOOP_ISM,
      [],
    );

    // 2. Default Hook - A basic hook implementation for message processing
    const defaultHook = await this.deployer.deployContract(
      StarknetContractName.HOOK,
      [],
    );

    // 3. Protocol Fee Hook - Handles fee collection for cross-chain messages
    const protocolFee = await this.deployer.deployContract(
      StarknetContractName.PROTOCOL_FEE,
      [
        BigNumber.from(config.requiredHook.maxProtocolFee),
        BigNumber.from(config.requiredHook.protocolFee),
        config.requiredHook.beneficiary,
        config.owner,
        PROTOCOL_TO_DEFAULT_NATIVE_TOKEN[ProtocolType.Starknet]!
          .denom as MultiType,
      ],
    );

    // 4. Deploy Mailbox with initial configuration
    const mailboxContract = await this.deployMailbox(
      chain,
      config.owner,
      noopIsm,
      defaultHook,
      protocolFee,
    );

    // 5. Update the configuration with custom ISM and hooks if specified
    const { defaultIsm, defaultHook: merkleTreeHook } =
      await this.updateCoreDeploy(config, mailboxContract.address);

    const validatorAnnounce = await this.deployer.deployContract(
      StarknetContractName.VALIDATOR_ANNOUNCE,
      [mailboxContract.address, config.owner],
    );

    const testRecipient = await this.deployer.deployContract(
      StarknetContractName.MESSAGE_RECIPIENT,
      [defaultIsm || noopIsm],
    );

    return {
      noopIsm,
      defaultIsm: defaultIsm || noopIsm,
      protocolFee,
      mailbox: mailboxContract.address,
      merkleTreeHook: merkleTreeHook ?? '',
      validatorAnnounce,
      testRecipient,
    };
  }

  async deployMailbox(
    chain: ChainNameOrId,
    owner: string,
    defaultIsm: string,
    defaultHook: string,
    requiredHook: string,
  ) {
    const domainId = this.multiProvider.getDomainId(chain);
    const mailboxAddress = await this.deployer.deployContract(
      StarknetContractName.MAILBOX,
      [BigInt(domainId), owner, defaultIsm, defaultHook, requiredHook],
    );

    return getStarknetMailboxContract(mailboxAddress, this.signer);
  }

  async updateCoreDeploy(
    expectedConfig: CoreConfig,
    mailbox: string,
  ): Promise<{ defaultIsm?: string; defaultHook?: string; owner?: string }> {
    const result: {
      defaultIsm?: string;
      defaultHook?: string;
      owner?: string;
    } = {};

    const owner = await this.readOwner(mailbox);
    const mailboxContract = getStarknetMailboxContract(mailbox, this.signer);

    // Update ISM if specified in config
    if (expectedConfig.defaultIsm) {
      const defaultIsm = await this.deployer.deployIsm({
        chain: this.chainName,
        ismConfig: expectedConfig.defaultIsm,
        mailbox,
      });

      this.logger.info(`Updating default ism ${defaultIsm}..`);
      const nonce = await this.signer.getNonce();
      const { transaction_hash: defaultIsmUpdateTxHash } =
        await mailboxContract.invoke('set_default_ism', [defaultIsm], {
          nonce,
        });

      await this.signer.waitForTransaction(defaultIsmUpdateTxHash);
      this.logger.info(
        `Transaction hash for updated default ism: ${defaultIsmUpdateTxHash}`,
      );
      result.defaultIsm = defaultIsm;
    }

    // Update required hook to MerkleTreeHook if specified
    if (expectedConfig.defaultHook) {
      this.logger.info(
        `Deploying MerkleTreeHook with explicit owner (${expectedConfig.owner}). Note: Unlike EVM where deployer automatically becomes owner, ` +
          `in Starknet the owner must be explicitly passed as a constructor parameter.`,
      );

      const merkleTreeHook = await this.deployer.deployContract(
        StarknetContractName.MERKLE_TREE_HOOK,
        [mailbox, expectedConfig.owner!],
      );

      this.logger.info(`Updating required hook ${merkleTreeHook}..`);
      const { transaction_hash: defaultHookUpdateTxHash } =
        await mailboxContract.invoke('set_default_hook', [merkleTreeHook]);

      await this.signer.waitForTransaction(defaultHookUpdateTxHash);
      this.logger.info(
        `Transaction hash for updated default hook: ${defaultHookUpdateTxHash}`,
      );

      result.defaultHook = merkleTreeHook;
    }

    // Update owner if different from current
    if (expectedConfig.owner && owner !== expectedConfig.owner) {
      this.logger.info(`Updating mailbox owner ${expectedConfig.owner}..`);
      const { transaction_hash: transferOwnershipTxHash } =
        await mailboxContract.invoke('transfer_ownership', [
          expectedConfig.owner,
        ]);

      await this.signer.waitForTransaction(transferOwnershipTxHash);
      this.logger.info(
        `Transaction hash for updated owner: ${transferOwnershipTxHash}`,
      );

      result.owner = expectedConfig.owner;
    }

    return result;
  }

  async update(
    expectedConfig: CoreConfig,
  ): Promise<AnnotatedStarknetTransaction[]> {
    assert(this.args, 'StarknetCoreModule must be initialized with args');

    const actualConfig = await this.read();

    const transactions: AnnotatedStarknetTransaction[] = [];
    transactions.push(
      ...(await this.createDefaultIsmUpdateTxs(actualConfig, expectedConfig)),
      ...this.createMailboxOwnerUpdateTxs(actualConfig, expectedConfig),
    );
    return transactions;
  }

  protected async createDefaultIsmUpdateTxs(
    actualConfig: DerivedCoreConfig,
    expectedConfig: CoreConfig,
  ): Promise<StarknetJsTransaction['transaction'][]> {
    assert(this.args, 'StarknetCoreModule must be initialized with args');

    const updateTransactions: StarknetJsTransaction['transaction'][] = [];

    const actualDefaultIsmConfig = actualConfig.defaultIsm as DerivedIsmConfig;

    const { deployedIsm, ismUpdateTxs } = await this.deployOrUpdateIsm(
      actualDefaultIsmConfig,
      expectedConfig.defaultIsm,
    );

    if (ismUpdateTxs.length) {
      updateTransactions.push(...ismUpdateTxs);
    }

    const newIsmDeployed = !eqAddress(
      actualDefaultIsmConfig.address,
      deployedIsm,
    );

    if (newIsmDeployed) {
      updateTransactions.push({
        contractAddress: this.args.addresses.mailbox,
        entrypoint: 'set_default_ism',
        calldata: [deployedIsm],
      });
    }
    return updateTransactions;
  }

  protected async createDefaultHookUpdateTxs(
    actualConfig: DerivedCoreConfig,
    expectedConfig: CoreConfig,
  ): Promise<StarknetJsTransaction['transaction'][]> {
    assert(this.args, 'StarknetCoreModule must be initialized with args');

    const preparedCalls: StarknetJsTransaction['transaction'][] = [];
    this.logger.debug(
      `Preparing default Hook update for Mailbox ${this.args.addresses.mailbox} on chain ${this.chainName}. Current Hook: ${actualConfig.defaultHook}`,
    );

    const targetHookAddress = await this.deployer.deployHook(
      this.chainName,
      expectedConfig.defaultHook,
      this.args.addresses.mailbox,
      expectedConfig.owner,
    );
    this.logger.info(
      `Target Hook address for Mailbox ${this.args.addresses.mailbox} on chain ${this.chainName} determined as: ${targetHookAddress}`,
    );

    const newHookDifferent = actualConfig.defaultHook !== targetHookAddress;

    if (newHookDifferent) {
      preparedCalls.push({
        contractAddress: this.args.addresses.mailbox,
        entrypoint: 'set_default_hook',
        calldata: [targetHookAddress],
      });
    } else {
      this.logger.info(
        `Default Hook ${targetHookAddress} on Mailbox ${this.args.addresses.mailbox} (chain ${this.chainName}) is already set. No update needed.`,
      );
    }
    return preparedCalls;
  }

  protected createOwnerUpdateTxs(
    currentOwner: string,
    expectedOwner: string,
  ): StarknetJsTransaction['transaction'][] {
    assert(this.args, 'StarknetCoreModule must be initialized with args');

    if (currentOwner.toLowerCase() === expectedOwner.toLowerCase()) {
      this.logger.info(
        `Mailbox ${this.args.addresses.mailbox} owner ${currentOwner} is already the expected owner. No update needed.`,
      );
      return [];
    }

    this.logger.info(
      `Mailbox ${this.args.addresses.mailbox} owner will be updated from ${currentOwner} to ${expectedOwner}.`,
    );
    return [
      {
        contractAddress: this.args.addresses.mailbox,
        entrypoint: 'transfer_ownership',
        calldata: [expectedOwner],
      },
    ];
  }

  /**
   * Updates or deploys the ISM using the provided configuration.
   *
   * @returns Object with deployedIsm address, and update Transactions
   */
  public async deployOrUpdateIsm(
    actualDefaultIsmConfig: DerivedIsmConfig,
    expectDefaultIsmConfig: IsmConfig,
  ): Promise<{
    deployedIsm: string;
    ismUpdateTxs: AnnotatedStarknetTransaction[];
  }> {
    assert(this.args, 'StarknetCoreModule must be initialized with args');

    const ismModule = new StarknetIsmModule(
      this.multiProtocolProvider,
      {
        chain: this.args.chain,
        config: expectDefaultIsmConfig,
        addresses: {
          mailbox: this.args.addresses.mailbox,
          deployedIsm: actualDefaultIsmConfig.address,
        },
      },
      this.signer,
    );
    this.logger.info(
      `Comparing target ISM config with ${this.args.chain} chain`,
    );

    const ismUpdateTxs = await ismModule.update(expectDefaultIsmConfig);
    const { deployedIsm } = ismModule.serialize();

    return { deployedIsm, ismUpdateTxs };
  }

  /**
   * Create a transaction to transfer ownership of an existing mailbox with a given config.
   *
   * @param actualConfig - The on-chain core configuration.
   * @param expectedConfig - The expected token core configuration.
   * @returns Ethereum transaction that need to be executed to update the owner.
   */
  createMailboxOwnerUpdateTxs(
    actualConfig: DerivedCoreConfig,
    expectedConfig: CoreConfig,
  ): AnnotatedStarknetTransaction[] {
    assert(this.args, 'StarknetCoreModule must be initialized with args');

    return transferOwnershipTransactionsStarknet(
      this.args.addresses.mailbox,
      actualConfig,
      expectedConfig,
    );
  }
}
