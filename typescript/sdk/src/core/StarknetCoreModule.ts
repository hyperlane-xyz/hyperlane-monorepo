import { Account, Contract } from 'starknet';

import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { StarknetDeployer } from '../deploy/StarknetDeployer.js';
import { HookType } from '../hook/types.js';
import { ChainNameOrId } from '../types.js';

import { CoreConfig } from './types.js';

export class StarknetCoreModule {
  protected logger = rootLogger.child({ module: 'StarknetCoreModule' });
  protected deployer: StarknetDeployer;
  constructor(protected readonly signer: Account) {
    this.deployer = new StarknetDeployer(signer);
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

    // deploy hook
    const hook = await this.deployer.deployContract('hook', []);

    const protocolFee = await this.deployer.deployContract('protocol_fee', [
      '1000000000000000000',
      '0',
      '10000000000000000',
      '0',
      config.requiredHook.beneficiary,
      config.owner,
      '0x49D36570D4E46F48E99674BD3FCC84644DDD6B96F7C741B1562B82F9E004DC7',
    ]);

    // deploy mailbox
    const mailbox = await this.deployer.deployContract('mailbox', [
      '888',
      config.owner,
      noopIsm,
      hook,
      protocolFee,
    ]);

    const { abi } = await getCompiledContract('mailbox');
    const mailboxContract = new Contract(abi, mailbox, this.signer);

    //TODO: skip next two steps if default ism not specified
    const defaultIsm = await this.deployer.deployIsm({
      chain: chain.toString(),
      ismConfig: config.defaultIsm,
      mailbox,
    });

    // Updating not a deployment
    console.log(`🧩 Updating default ism ${defaultIsm}..`);
    const { transaction_hash: defaultIsmUpdateTxHash } =
      await mailboxContract.invoke('set_default_ism', [defaultIsm]);

    await this.signer.waitForTransaction(defaultIsmUpdateTxHash);
    console.log(
      `⚡️ Transaction hash for updated default ism: ${defaultIsmUpdateTxHash}`,
    );

    const merkleTreeHook = await this.deployer.deployContract(
      'merkle_tree_hook',
      [mailbox, config.owner],
    );

    // Updating not a deployment
    console.log(`🧩 Updating required hook ${merkleTreeHook}..`);
    const { transaction_hash: requiredHookUpdateTxHash } =
      await mailboxContract.invoke('set_required_hook', [merkleTreeHook]);

    await this.signer.waitForTransaction(requiredHookUpdateTxHash);
    console.log(
      `⚡️ Transaction hash for updated required hook: ${requiredHookUpdateTxHash}`,
    );

    const validatorAnnounce = await this.deployer.deployContract(
      'validator_announce',
      [mailbox, config.owner],
    );

    return {
      noopIsm,
      hook,
      mailbox,
      defaultIsm,
      validatorAnnounce,
      protocolFee,
      merkleTreeHook,
    };
  }
}
