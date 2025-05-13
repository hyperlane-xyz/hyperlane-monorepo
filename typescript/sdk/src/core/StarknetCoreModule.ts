import { BigNumber } from 'ethers';
import { Account, Contract, MultiType } from 'starknet';

import { ProtocolType, assert, rootLogger } from '@hyperlane-xyz/utils';

import { StarknetDeployer } from '../deploy/StarknetDeployer.js';
import { HookType } from '../hook/types.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { PROTOCOL_TO_DEFAULT_NATIVE_TOKEN } from '../token/nativeTokenMetadata.js';
import { ChainNameOrId } from '../types.js';
import {
  StarknetContractName,
  getStarknetMailboxContract,
} from '../utils/starknet.js';

import { StarknetCoreReader } from './StarknetCoreReader.js';
import { CoreConfig } from './types.js';

export class StarknetCoreModule {
  protected logger = rootLogger.child({ module: 'StarknetCoreModule' });
  protected deployer: StarknetDeployer;
  protected coreReader: StarknetCoreReader;

  constructor(
    protected readonly signer: Account,
    protected readonly multiProvider: MultiProvider,
    protected readonly multiProtocolProvider: MultiProtocolProvider,
    protected readonly chain: ChainNameOrId,
  ) {
    this.deployer = new StarknetDeployer(signer, multiProvider);
    this.coreReader = new StarknetCoreReader(multiProtocolProvider, chain);
  }

  /**
   * Reads the core configuration from the mailbox address
   * @returns The core config.
   */
  public async read(mailboxContract: Contract): Promise<CoreConfig> {
    return this.coreReader.deriveCoreConfig(mailboxContract.address);
  }
  public async readOwner(mailboxContract: Contract): Promise<string> {
    return this.coreReader.deriveOwner(mailboxContract.address);
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
    const { defaultIsm, defaultHook: merkleTreeHook } = await this.update(
      config,
      {
        chain,
        mailboxContract,
      },
    );

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

  async update(
    expectedConfig: Partial<CoreConfig>,
    args: { mailboxContract: Contract; chain: ChainNameOrId },
  ): Promise<{ defaultIsm?: string; defaultHook?: string; owner?: string }> {
    const result: {
      defaultIsm?: string;
      defaultHook?: string;
      owner?: string;
    } = {};

    const actualOwner = await this.readOwner(args.mailboxContract);

    // Update ISM if specified in config
    if (expectedConfig.defaultIsm) {
      const defaultIsm = await this.deployer.deployIsm({
        chain: args.chain.toString(),
        ismConfig: expectedConfig.defaultIsm,
        mailbox: args.mailboxContract.address,
      });

      this.logger.info(`Updating default ism ${defaultIsm}..`);
      const nonce = await this.signer.getNonce();
      const { transaction_hash: defaultIsmUpdateTxHash } =
        await args.mailboxContract.invoke('set_default_ism', [defaultIsm], {
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
        [args.mailboxContract.address, expectedConfig.owner!],
      );

      this.logger.info(`Updating required hook ${merkleTreeHook}..`);
      const { transaction_hash: defaultHookUpdateTxHash } =
        await args.mailboxContract.invoke('set_default_hook', [merkleTreeHook]);

      await this.signer.waitForTransaction(defaultHookUpdateTxHash);
      this.logger.info(
        `Transaction hash for updated default hook: ${defaultHookUpdateTxHash}`,
      );

      result.defaultHook = merkleTreeHook;
    }

    // Update owner if different from current
    if (expectedConfig.owner && actualOwner !== expectedConfig.owner) {
      this.logger.info(`Updating mailbox owner ${expectedConfig.owner}..`);
      const { transaction_hash: transferOwnershipTxHash } =
        await args.mailboxContract.invoke('transfer_ownership', [
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
}
