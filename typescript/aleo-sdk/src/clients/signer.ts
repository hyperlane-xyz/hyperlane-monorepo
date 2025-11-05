import {
  Account,
  AleoKeyProvider,
  NetworkRecordProvider,
  Program,
  ProgramManager,
  ProgramManagerBase,
} from '@provablehq/sdk';

import { AltVM } from '@hyperlane-xyz/utils';

import { loadProgramsInDeployOrder } from '../artifacts.js';
import { AleoReceipt, AleoTransaction } from '../utils/types.js';

import { AleoProvider } from './provider.js';

export class AleoSigner
  extends AleoProvider
  implements AltVM.ISigner<AleoTransaction, AleoReceipt>
{
  private readonly aleoAccount: Account;
  private readonly keyProvider: AleoKeyProvider;
  private readonly networkRecordProvider: NetworkRecordProvider;
  private readonly programManager: ProgramManager;

  static async connectWithSigner(
    rpcUrls: string[],
    privateKey: string,
    _extraParams?: Record<string, any>,
  ): Promise<AltVM.ISigner<AleoTransaction, AleoReceipt>> {
    return new AleoSigner(rpcUrls, privateKey);
  }

  protected constructor(rpcUrls: string[], privateKey: string) {
    super(rpcUrls);

    this.aleoAccount = new Account({
      privateKey,
    });

    this.keyProvider = new AleoKeyProvider();
    this.keyProvider.useCache(true);

    this.networkRecordProvider = new NetworkRecordProvider(
      this.aleoAccount,
      this.aleoClient,
    );

    this.programManager = new ProgramManager(
      rpcUrls[0],
      this.keyProvider,
      this.networkRecordProvider,
    );
    this.programManager.setAccount(this.aleoAccount);
  }

  private async deployProgram(programName: string): Promise<Program[]> {
    const programs = loadProgramsInDeployOrder(programName);

    for (const program of programs) {
      const isDeployed = await this.isProgramDeployed(program);

      // if the program is already deployed (which can be the case for some imports)
      // we simply skip it
      if (isDeployed) {
        continue;
      }

      const fee = await ProgramManagerBase.estimateDeploymentFee(
        program.toString(),
      );

      const txId = await this.programManager.deploy(
        program.toString(),
        Math.ceil(Number(fee) / 10 ** 6),
        false,
      );

      await this.aleoClient.waitForTransactionConfirmation(txId);
    }

    return programs;
  }

  getSignerAddress(): string {
    return this.aleoAccount.address().to_string();
  }

  supportsTransactionBatching(): boolean {
    return false;
  }

  async transactionToPrintableJson(
    transaction: AleoTransaction,
  ): Promise<object> {
    return transaction;
  }

  async sendAndConfirmTransaction(
    transaction: AleoTransaction,
  ): Promise<AleoReceipt> {
    const txId = await this.programManager.execute(transaction);
    return this.aleoClient.waitForTransactionConfirmation(txId);
  }

  async sendAndConfirmBatchTransactions(
    _transactions: AleoTransaction[],
  ): Promise<AleoReceipt> {
    throw new Error(`${AleoSigner.name} does not support transaction batching`);
  }

  // ### TX CORE ###

  private async isProgramDeployed(program: Program) {
    try {
      await this.aleoClient.getProgram(program.id());
      return true;
    } catch {
      return false;
    }
  }

  async createMailbox(
    req: Omit<AltVM.ReqCreateMailbox, 'signer'>,
  ): Promise<AltVM.ResCreateMailbox> {
    await this.deployProgram('dispatch_proxy');

    // TODO: init with correct mailbox id
    const tx = await this.getCreateMailboxTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      mailboxAddress: 'todo',
    };
  }

  async setDefaultIsm(
    req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm> {
    const tx = await this.getSetDefaultIsmTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      ismAddress: req.ismAddress,
    };
  }

  async setDefaultHook(
    req: Omit<AltVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<AltVM.ResSetDefaultHook> {
    const tx = await this.getSetDefaultHookTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      hookAddress: req.hookAddress,
    };
  }

  async setRequiredHook(
    req: Omit<AltVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<AltVM.ResSetRequiredHook> {
    const tx = await this.getSetRequiredHookTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      hookAddress: req.hookAddress,
    };
  }

  async setMailboxOwner(
    req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<AltVM.ResSetMailboxOwner> {
    const tx = await this.getSetMailboxOwnerTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      newOwner: req.newOwner,
    };
  }

  async createMerkleRootMultisigIsm(
    _req: Omit<AltVM.ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleRootMultisigIsm> {
    throw new Error(`MerkleRootMultisigIsm is currently not supported on Aleo`);
  }

  async createMessageIdMultisigIsm(
    req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMessageIdMultisigIsm> {
    let nonce = await this.aleoClient.getProgramMappingValue(
      'ism_manager.aleo',
      'nonce',
      'true',
    );

    if (nonce === null) {
      nonce = '0u32';
    }

    const tx = await this.getCreateMessageIdMultisigIsmTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    const ismAddress = await this.aleoClient.getProgramMappingValue(
      'ism_manager.aleo',
      'ism_addresses',
      nonce,
    );

    if (ismAddress === null) {
      throw new Error(
        `could not read ism address with nonce ${nonce} from ism_manager`,
      );
    }

    return {
      ismAddress,
    };
  }

  async createRoutingIsm(
    req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm> {
    let nonce = await this.aleoClient.getProgramMappingValue(
      'ism_manager.aleo',
      'nonce',
      'true',
    );

    if (nonce === null) {
      nonce = '0u32';
    }

    const tx = await this.getCreateRoutingIsmTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    const ismAddress = await this.aleoClient.getProgramMappingValue(
      'ism_manager.aleo',
      'ism_addresses',
      nonce,
    );

    if (ismAddress === null) {
      throw new Error(
        `could not read ism address with nonce ${nonce} from ism_manager`,
      );
    }

    return {
      ismAddress,
    };
  }

  async setRoutingIsmRoute(
    req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute> {
    const tx = await this.getSetRoutingIsmRouteTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      route: req.route,
    };
  }

  async removeRoutingIsmRoute(
    req: Omit<AltVM.ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResRemoveRoutingIsmRoute> {
    const tx = await this.getRemoveRoutingIsmRouteTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      domainId: req.domainId,
    };
  }

  async setRoutingIsmOwner(
    req: Omit<AltVM.ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmOwner> {
    const tx = await this.getSetRoutingIsmOwnerTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      newOwner: req.newOwner,
    };
  }

  async createNoopIsm(
    req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<AltVM.ResCreateNoopIsm> {
    let nonce = await this.aleoClient.getProgramMappingValue(
      'ism_manager.aleo',
      'nonce',
      'true',
    );

    if (nonce === null) {
      nonce = '0u32';
    }

    const tx = await this.getCreateNoopIsmTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    const ismAddress = await this.aleoClient.getProgramMappingValue(
      'ism_manager.aleo',
      'ism_addresses',
      nonce,
    );

    if (ismAddress === null) {
      throw new Error(
        `could not read ism address with nonce ${nonce} from ism_manager`,
      );
    }

    return {
      ismAddress,
    };
  }

  async createMerkleTreeHook(
    req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook> {
    let nonce = await this.aleoClient.getProgramMappingValue(
      'hook_manager.aleo',
      'nonce',
      'true',
    );

    if (nonce === null) {
      nonce = '0u32';
    }

    const tx = await this.getCreateMerkleTreeHookTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    const hookAddress = await this.aleoClient.getProgramMappingValue(
      'hook_manager.aleo',
      'hook_addresses',
      nonce,
    );

    if (hookAddress === null) {
      throw new Error(
        `could not read hook address with nonce ${nonce} from hook_manager`,
      );
    }

    return {
      hookAddress,
    };
  }

  async createInterchainGasPaymasterHook(
    req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook> {
    let nonce = await this.aleoClient.getProgramMappingValue(
      'hook_manager.aleo',
      'nonce',
      'true',
    );

    if (nonce === null) {
      nonce = '0u32';
    }

    const tx = await this.getCreateInterchainGasPaymasterHookTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    const hookAddress = await this.aleoClient.getProgramMappingValue(
      'hook_manager.aleo',
      'hook_addresses',
      nonce,
    );

    if (hookAddress === null) {
      throw new Error(
        `could not read hook address with nonce ${nonce} from hook_manager`,
      );
    }

    return {
      hookAddress,
    };
  }

  async setInterchainGasPaymasterHookOwner(
    req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner> {
    const tx = await this.getSetInterchainGasPaymasterHookOwnerTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      newOwner: req.newOwner,
    };
  }

  async setDestinationGasConfig(
    req: Omit<AltVM.ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResSetDestinationGasConfig> {
    const tx = await this.getSetDestinationGasConfigTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      destinationGasConfig: req.destinationGasConfig,
    };
  }

  async createValidatorAnnounce(
    req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce> {
    await this.deployProgram('validator_announce');

    // TODO: init with correct validator announce and mailbox id
    const tx = await this.getCreateValidatorAnnounceTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      validatorAnnounceId: 'todo',
    };
  }

  // ### TX WARP ###

  async createCollateralToken(
    _req: Omit<AltVM.ReqCreateCollateralToken, 'signer'>,
  ): Promise<AltVM.ResCreateCollateralToken> {
    throw new Error(`TODO: implement`);
  }

  async createSyntheticToken(
    _req: Omit<AltVM.ReqCreateSyntheticToken, 'signer'>,
  ): Promise<AltVM.ResCreateSyntheticToken> {
    throw new Error(`TODO: implement`);
  }

  async setTokenOwner(
    _req: Omit<AltVM.ReqSetTokenOwner, 'signer'>,
  ): Promise<AltVM.ResSetTokenOwner> {
    throw new Error(`TODO: implement`);
  }

  async setTokenIsm(
    _req: Omit<AltVM.ReqSetTokenIsm, 'signer'>,
  ): Promise<AltVM.ResSetTokenIsm> {
    throw new Error(`TODO: implement`);
  }

  async enrollRemoteRouter(
    _req: Omit<AltVM.ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResEnrollRemoteRouter> {
    throw new Error(`TODO: implement`);
  }

  async unenrollRemoteRouter(
    _req: Omit<AltVM.ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResUnenrollRemoteRouter> {
    throw new Error(`TODO: implement`);
  }

  async transfer(
    req: Omit<AltVM.ReqTransfer, 'signer'>,
  ): Promise<AltVM.ResTransfer> {
    const tx = await this.getTransferTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const txId = await this.programManager.execute(tx);
    await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      recipient: req.recipient,
    };
  }

  async remoteTransfer(
    _req: Omit<AltVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<AltVM.ResRemoteTransfer> {
    throw new Error(`TODO: implement`);
  }
}
