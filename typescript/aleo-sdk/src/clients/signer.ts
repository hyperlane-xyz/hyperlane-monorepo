import {
  Account,
  AleoKeyProvider,
  AleoNetworkClient,
  NetworkRecordProvider,
  ProgramManager,
  ProgramManagerBase,
} from '@provablehq/sdk';

import { AltVM, sleep } from '@hyperlane-xyz/utils';

import { loadPrograms } from '../artifacts.js';
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
    const aleoClient = new AleoNetworkClient(rpcUrls[0]);
    const aleoAccount = new Account({
      privateKey,
    });

    return new AleoSigner(aleoClient, rpcUrls, aleoAccount);
  }

  protected constructor(
    aleoClient: AleoNetworkClient,
    rpcUrls: string[],
    aleoAccount: Account,
  ) {
    super(aleoClient, rpcUrls);

    this.aleoAccount = aleoAccount;

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

  getSignerAddress(): string {
    return this.aleoAccount.address().to_string();
  }

  supportsTransactionBatching(): boolean {
    throw new Error(`TODO: implement`);
  }

  transactionToPrintableJson(_transaction: AleoTransaction): Promise<object> {
    throw new Error(`TODO: implement`);
  }

  async sendAndConfirmTransaction(
    _transaction: AleoTransaction,
  ): Promise<AleoReceipt> {
    throw new Error(`TODO: implement`);
  }

  async sendAndConfirmBatchTransactions(
    _transactions: AleoTransaction[],
  ): Promise<AleoReceipt> {
    throw new Error(`TODO: implement`);
  }

  // ### TX CORE ###

  private async isProgramDeployed(programName: string) {
    // TODO: is there a more efficient way for checking if a program exists
    // without downloading the entire source code again?
    try {
      await this.aleoClient.getProgram(`${programName}.aleo`);

      return true;
    } catch {
      return false;
    }
  }

  private async pollForTransactionConfirmed(
    txId: string,
  ): Promise<AleoReceipt> {
    // we try to poll for 2 minutes
    const pollAttempts = 120;
    const pollDelayMs = 1000;

    for (let i = 0; i < pollAttempts; i++) {
      try {
        return await this.programManager.networkClient.getConfirmedTransaction(
          txId,
        );
      } catch {
        await sleep(pollDelayMs);
      }
    }

    throw new Error(`reached poll limit of ${pollAttempts} attempts`);
  }

  async createMailbox(
    _req: Omit<AltVM.ReqCreateMailbox, 'signer'>,
  ): Promise<AltVM.ResCreateMailbox> {
    const mailboxAddress = 'test';
    const programs = loadPrograms('mailbox');

    for (const { programName, program } of programs) {
      const isDeployed = await this.isProgramDeployed(`${programName}.aleo`);

      // if the program is already deployed (which can be the case for some imports)
      // we simply skip it
      if (isDeployed) {
        continue;
      }

      const fee = await ProgramManagerBase.estimateDeploymentFee(program);
      console.log(`estimated fee ${fee} for program ${programName}`);

      console.log('buildDeploymentTransaction', programName, program.length);

      const tx = await this.programManager.buildDeploymentTransaction(
        program,
        Number(fee),
        false,
      );

      console.log('created tx');

      const transaction_id =
        await this.programManager.networkClient.submitTransaction(tx);

      console.log('transaction_id', transaction_id);

      const transaction =
        await this.programManager.networkClient.getConfirmedTransaction(
          transaction_id,
        );

      console.log('transaction', transaction);
    }

    return {
      mailboxAddress,
    };
  }

  async setDefaultIsm(
    _req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm> {
    throw new Error(`TODO: implement`);
  }

  async setDefaultHook(
    _req: Omit<AltVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<AltVM.ResSetDefaultHook> {
    throw new Error(`TODO: implement`);
  }

  async setRequiredHook(
    _req: Omit<AltVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<AltVM.ResSetRequiredHook> {
    throw new Error(`TODO: implement`);
  }

  async setMailboxOwner(
    _req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<AltVM.ResSetMailboxOwner> {
    throw new Error(`TODO: implement`);
  }

  async createMerkleRootMultisigIsm(
    _req: Omit<AltVM.ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleRootMultisigIsm> {
    throw new Error(`TODO: implement`);
  }

  async createMessageIdMultisigIsm(
    _req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMessageIdMultisigIsm> {
    throw new Error(`TODO: implement`);
  }

  async createRoutingIsm(
    _req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm> {
    throw new Error(`TODO: implement`);
  }

  async setRoutingIsmRoute(
    _req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute> {
    throw new Error(`TODO: implement`);
  }

  async removeRoutingIsmRoute(
    _req: Omit<AltVM.ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResRemoveRoutingIsmRoute> {
    throw new Error(`TODO: implement`);
  }

  async setRoutingIsmOwner(
    _req: Omit<AltVM.ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmOwner> {
    throw new Error(`TODO: implement`);
  }

  async createNoopIsm(
    _req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<AltVM.ResCreateNoopIsm> {
    throw new Error(`TODO: implement`);
  }

  async createMerkleTreeHook(
    _req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook> {
    throw new Error(`TODO: implement`);
  }

  async createInterchainGasPaymasterHook(
    _req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook> {
    throw new Error(`TODO: implement`);
  }

  async setInterchainGasPaymasterHookOwner(
    _req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner> {
    throw new Error(`TODO: implement`);
  }

  async setDestinationGasConfig(
    _req: Omit<AltVM.ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResSetDestinationGasConfig> {
    throw new Error(`TODO: implement`);
  }

  async createValidatorAnnounce(
    _req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce> {
    throw new Error(`TODO: implement`);
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
    await this.pollForTransactionConfirmed(txId);

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
