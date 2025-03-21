import { BigNumber } from 'ethers';
import { Account, Contract, MultiType } from 'starknet';

import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { ProtocolType, assert, rootLogger } from '@hyperlane-xyz/utils';

import { StarknetDeployer } from '../deploy/StarknetDeployer.js';
import { HookType } from '../hook/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { PROTOCOL_TO_DEFAULT_NATIVE_TOKEN } from '../token/nativeTokenMetadata.js';
import { ChainNameOrId } from '../types.js';

import { StarknetCoreReader } from './StarknetCoreReader.js';
import { CoreConfig } from './types.js';

export class StarknetCoreModule {
  protected logger = rootLogger.child({ module: 'StarknetCoreModule' });
  protected deployer: StarknetDeployer;
  protected coreReader: StarknetCoreReader;

  constructor(
    protected readonly signer: Account,
    protected readonly domainId: number,
    protected readonly multiProvider: MultiProvider,
  ) {
    this.deployer = new StarknetDeployer(signer, multiProvider);
    this.coreReader = new StarknetCoreReader(signer);
  }

  /**
   * Reads the core configuration from the mailbox address
   * @returns The core config.
   */
  public async read(mailboxContract: Contract): Promise<CoreConfig> {
    return this.coreReader.deriveCoreConfig(mailboxContract.address);
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
    const noopIsm = await this.deployer.deployContract('noop_ism', []);

    // 2. Default Hook - A basic hook implementation for message processing
    const defaultHook = await this.deployer.deployContract('hook', []);

    // 3. Protocol Fee Hook - Handles fee collection for cross-chain messages
    const protocolFee = await this.deployer.deployContract('protocol_fee', [
      BigNumber.from(config.requiredHook.maxProtocolFee),
      BigNumber.from(config.requiredHook.protocolFee),
      config.requiredHook.beneficiary,
      config.owner,
      PROTOCOL_TO_DEFAULT_NATIVE_TOKEN[ProtocolType.Starknet]!
        .denom as MultiType,
    ]);

    // 4. Deploy Mailbox with initial configuration
    const mailboxContract = await this.deployMailbox(
      chain,
      config.owner,
      noopIsm,
      defaultHook,
      protocolFee,
    );

    // 5. Update the configuration with custom ISM and hooks if specified
    const { defaultIsm, requiredHook } = await this.update(config, {
      chain,
      mailboxContract,
      owner: config.owner,
    });

    const validatorAnnounce = await this.deployer.deployContract(
      'validator_announce',
      [mailboxContract.address, config.owner],
    );

    const testRecipient = await this.deployer.deployContract(
      'message_recipient',
      [defaultIsm || noopIsm],
    );

    return {
      noopIsm,
      defaultHook,
      defaultIsm: defaultIsm || noopIsm,
      protocolFee,
      mailbox: mailboxContract.address,
      merkleTreeHook: requiredHook || '',
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
    const mailboxAddress = await this.deployer.deployContract('mailbox', [
      BigInt(domainId),
      owner,
      defaultIsm,
      defaultHook,
      requiredHook,
    ]);

    const { abi } = getCompiledContract('mailbox');
    return new Contract(abi, mailboxAddress, this.signer);
  }

  async update(
    expectedConfig: Partial<CoreConfig>,
    args: { mailboxContract: Contract; chain: ChainNameOrId; owner: string },
  ): Promise<{ defaultIsm?: string; requiredHook?: string; owner?: string }> {
    const result: {
      defaultIsm?: string;
      requiredHook?: string;
      owner?: string;
    } = {};

    const actualConfig = await this.read(args.mailboxContract);

    // Update ISM if specified in config
    if (expectedConfig.defaultIsm) {
      const defaultIsm = await this.deployer.deployIsm({
        chain: args.chain.toString(),
        ismConfig: expectedConfig.defaultIsm,
        mailbox: args.mailboxContract.address,
      });

      this.logger.info(`Updating default ism ${defaultIsm}..`);
      const { transaction_hash: defaultIsmUpdateTxHash } =
        await args.mailboxContract.invoke('set_default_ism', [defaultIsm]);

      try {
        await this.signer.waitForTransaction(defaultIsmUpdateTxHash);
      } catch (error) {
        this.logger.error(`Error updating default ism ${defaultIsm}: ${error}`);
      }
      this.logger.info(
        `Transaction hash for updated default ism: ${defaultIsmUpdateTxHash}`,
      );
      result.defaultIsm = defaultIsm;
    }

    // Update required hook to MerkleTreeHook if specified
    if (expectedConfig.requiredHook) {
      this.logger.info(
        `Deploying MerkleTreeHook with explicit owner (${args.owner}). Note: Unlike EVM where deployer becomes owner, ` +
          `in Starknet the owner is specified during construction.`,
      );

      const merkleTreeHook = await this.deployer.deployContract(
        'merkle_tree_hook',
        [args.mailboxContract.address, args.owner],
      );

      this.logger.trace(`Updating required hook ${merkleTreeHook}..`);
      const { transaction_hash: requiredHookUpdateTxHash } =
        await args.mailboxContract.invoke('set_required_hook', [
          merkleTreeHook,
        ]);

      await this.signer.waitForTransaction(requiredHookUpdateTxHash);
      this.logger.trace(
        `Transaction hash for updated required hook: ${requiredHookUpdateTxHash}`,
      );

      result.requiredHook = merkleTreeHook;
    }

    // Update owner if different from current
    if (expectedConfig.owner && actualConfig.owner !== expectedConfig.owner) {
      this.logger.trace(`Updating mailbox owner ${expectedConfig.owner}..`);
      const { transaction_hash: transferOwnershipTxHash } =
        await args.mailboxContract.invoke('transfer_ownership', [
          expectedConfig.owner,
        ]);

      await this.signer.waitForTransaction(transferOwnershipTxHash);
      this.logger.trace(
        `Transaction hash for updated owner: ${transferOwnershipTxHash}`,
      );

      result.owner = expectedConfig.owner;
    }

    return result;
  }
}
