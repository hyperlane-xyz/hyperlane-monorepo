import { Account, Contract } from 'starknet';

import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { StarknetDeployer } from '../deploy/StarknetDeployer.js';
import { HookType } from '../hook/types.js';
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
  ) {
    this.deployer = new StarknetDeployer(signer);
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
    const noopIsm = await this.deployer.deployContract('noop_ism', []);

    const defaultHook = await this.deployer.deployContract('hook', []);

    const protocolFee = await this.deployer.deployContract('protocol_fee', [
      '1000000000000000000',
      '0',
      '10000000000000000',
      '0',
      config.requiredHook.beneficiary,
      config.owner,
      '0x49D36570D4E46F48E99674BD3FCC84644DDD6B96F7C741B1562B82F9E004DC7', // ETH address on Starknet chains
    ]);

    const mailboxContract = await this.deployMailbox(
      config.owner,
      noopIsm,
      defaultHook,
      protocolFee,
    );

    const { defaultIsm, requiredHook } = await this.update(config, {
      chain,
      mailboxContract,
      owner: config.owner,
    });

    const validatorAnnounce = await this.deployer.deployContract(
      'validator_announce',
      [mailboxContract.address, config.owner],
    );

    return {
      noopIsm,
      defaultHook,
      defaultIsm: defaultIsm || noopIsm,
      protocolFee,
      mailbox: mailboxContract.address,
      merkleTreeHook: requiredHook || '',
      validatorAnnounce,
    };
  }

  async deployMailbox(
    owner: string,
    defaultIsm: string,
    defaultHook: string,
    requiredHook: string,
  ) {
    const mailboxAddress = await this.deployer.deployContract('mailbox', [
      this.domainId,
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

    if (expectedConfig.defaultIsm) {
      const defaultIsm = await this.deployer.deployIsm({
        chain: args.chain.toString(),
        ismConfig: expectedConfig.defaultIsm,
        mailbox: args.mailboxContract.address,
      });

      this.logger.trace(`Updating default ism ${defaultIsm}..`);
      const { transaction_hash: defaultIsmUpdateTxHash } =
        await args.mailboxContract.invoke('set_default_ism', [defaultIsm]);

      await this.signer.waitForTransaction(defaultIsmUpdateTxHash);
      this.logger.trace(
        `Transaction hash for updated default ism: ${defaultIsmUpdateTxHash}`,
      );
      result.defaultIsm = defaultIsm;
    }

    if (expectedConfig.requiredHook) {
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
