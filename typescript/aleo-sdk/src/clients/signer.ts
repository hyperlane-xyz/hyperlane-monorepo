import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert } from '@hyperlane-xyz/utils';

import { AleoProgram } from '../artifacts.js';
import {
  fromAleoAddress,
  getProgramSuffix,
  loadProgramsInDeployOrder,
  programIdToPlaintext,
  toAleoAddress,
} from '../utils/helper.js';
import { AleoReceipt, AleoTransaction } from '../utils/types.js';

import { AnyProgramManager } from './base.js';
import { AleoProvider } from './provider.js';

export class AleoSigner
  extends AleoProvider
  implements AltVM.ISigner<AleoTransaction, AleoReceipt>
{
  private readonly programManager: AnyProgramManager;

  static async connectWithSigner(
    rpcUrls: string[],
    privateKey: string,
    extraParams?: Record<string, any>,
  ): Promise<AltVM.ISigner<AleoTransaction, AleoReceipt>> {
    assert(extraParams, `extra params not defined`);

    const metadata = extraParams.metadata as Record<string, unknown>;
    assert(metadata, `metadata not defined in extra params`);
    assert(metadata.chainId, `chainId not defined in metadata extra params`);

    const chainId = parseInt(metadata.chainId.toString());

    return new AleoSigner(rpcUrls, chainId, privateKey);
  }

  protected constructor(
    rpcUrls: string[],
    chainId: string | number,
    privateKey: string,
  ) {
    super(rpcUrls, chainId);
    this.programManager = this.getProgramManager(privateKey);
  }

  private async deployProgram(
    programName: AleoProgram,
    coreSuffix: string,
    warpSuffix?: string,
  ): Promise<Partial<Record<AleoProgram, string>>> {
    const programs = loadProgramsInDeployOrder(
      programName,
      coreSuffix,
      warpSuffix,
    );

    for (const { id, program } of programs) {
      try {
        const tx = this.skipProofs
          ? await this.programManager.buildDevnodeDeploymentTransaction({
              program,
              priorityFee: 0,
              privateFee: false,
            })
          : await this.programManager.buildDeploymentTransaction(
              program,
              0,
              false,
              undefined,
              undefined,
              undefined,
            );

        const txId =
          await this.programManager.networkClient.submitTransaction(tx);

        await this.aleoClient.waitForTransactionConfirmation(txId);
      } catch (err) {
        if (
          err instanceof Error &&
          err.message ===
            `Error validating program: Program ${id} already exists on the network, please rename your program`
        ) {
          continue;
        }

        throw err;
      }
    }

    return programs.reduce((acc, p) => ({ ...acc, [p.name]: p.id }), {});
  }

  getSignerAddress(): string {
    return this.programManager.account!.address().to_string();
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
    const tx = this.skipProofs
      ? await this.programManager.buildDevnodeExecutionTransaction(transaction)
      : await this.programManager.buildExecutionTransaction(transaction);

    const txId = await this.programManager.networkClient.submitTransaction(tx);
    const receipt = await this.aleoClient.waitForTransactionConfirmation(txId);

    return {
      ...receipt,
      transactionHash: receipt.transaction.id,
    };
  }

  async sendAndConfirmBatchTransactions(
    _transactions: AleoTransaction[],
  ): Promise<AleoReceipt> {
    throw new Error(`${AleoSigner.name} does not support transaction batching`);
  }

  // ### TX CORE ###

  async createMailbox(
    req: Omit<AltVM.ReqCreateMailbox, 'signer'>,
  ): Promise<AltVM.ResCreateMailbox> {
    const mailboxSuffix = this.generateSuffix(12);
    const programs = await this.deployProgram('dispatch_proxy', mailboxSuffix);

    const tx = await this.getCreateMailboxTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const mailboxProgramId = programs['mailbox'];
    assert(mailboxProgramId, `mailbox program not deployed`);

    const dispatchProxyProgramId = programs['dispatch_proxy'];
    assert(dispatchProxyProgramId, `dispatch proxy program not deployed`);

    tx.programName = mailboxProgramId;

    await this.sendAndConfirmTransaction(tx);
    await this.sendAndConfirmTransaction({
      programName: mailboxProgramId,
      functionName: 'set_dispatch_proxy',
      priorityFee: 0,
      privateFee: false,
      inputs: [dispatchProxyProgramId],
    });

    return {
      mailboxAddress: toAleoAddress(mailboxProgramId),
    };
  }

  async setDefaultIsm(
    req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm> {
    const tx = await this.getSetDefaultIsmTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

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

    await this.sendAndConfirmTransaction(tx);

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

    await this.sendAndConfirmTransaction(tx);

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

    await this.sendAndConfirmTransaction(tx);

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
    const mailboxSuffix = this.generateSuffix(12);
    const programs = await this.deployProgram('ism_manager', mailboxSuffix);

    const ismManagerProgramId = programs['ism_manager'];
    assert(ismManagerProgramId, `ism manager program not deployed`);

    let nonce = await this.aleoClient.getProgramMappingValue(
      ismManagerProgramId,
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

    await this.sendAndConfirmTransaction(tx);

    const ismAddress = await this.aleoClient.getProgramMappingValue(
      ismManagerProgramId,
      'ism_addresses',
      nonce,
    );

    if (ismAddress === null) {
      throw new Error(
        `could not read ism address with nonce ${nonce} from ism_manager`,
      );
    }

    return {
      ismAddress: `${ismManagerProgramId}/${ismAddress}`,
    };
  }

  async createRoutingIsm(
    req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm> {
    const mailboxSuffix = this.generateSuffix(12);
    const programs = await this.deployProgram('ism_manager', mailboxSuffix);

    const ismManagerProgramId = programs['ism_manager'];
    assert(ismManagerProgramId, `ism manager program not deployed`);

    let nonce = await this.aleoClient.getProgramMappingValue(
      ismManagerProgramId,
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

    await this.sendAndConfirmTransaction(tx);

    const ismAddress = await this.aleoClient.getProgramMappingValue(
      ismManagerProgramId,
      'ism_addresses',
      nonce,
    );

    if (ismAddress === null) {
      throw new Error(
        `could not read ism address with nonce ${nonce} from ism_manager`,
      );
    }

    for (const route of req.routes) {
      const routeTx = await this.getSetRoutingIsmRouteTransaction({
        signer: this.getSignerAddress(),
        ismAddress: `${ismManagerProgramId}/${ismAddress}`,
        route,
      });

      await this.sendAndConfirmTransaction(routeTx);
    }

    return {
      ismAddress: `${ismManagerProgramId}/${ismAddress}`,
    };
  }

  async setRoutingIsmRoute(
    req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute> {
    const tx = await this.getSetRoutingIsmRouteTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

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

    await this.sendAndConfirmTransaction(tx);

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

    await this.sendAndConfirmTransaction(tx);

    return {
      newOwner: req.newOwner,
    };
  }

  async createNoopIsm(
    req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<AltVM.ResCreateNoopIsm> {
    const mailboxSuffix = this.generateSuffix(12);
    const programs = await this.deployProgram('ism_manager', mailboxSuffix);

    const ismManagerProgramId = programs['ism_manager'];
    assert(ismManagerProgramId, `ism manager program not deployed`);

    let nonce = await this.aleoClient.getProgramMappingValue(
      ismManagerProgramId,
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

    await this.sendAndConfirmTransaction(tx);

    const ismAddress = await this.aleoClient.getProgramMappingValue(
      ismManagerProgramId,
      'ism_addresses',
      nonce,
    );

    if (ismAddress === null) {
      throw new Error(
        `could not read ism address with nonce ${nonce} from ism_manager`,
      );
    }

    return {
      ismAddress: `${ismManagerProgramId}/${ismAddress}`,
    };
  }

  async createMerkleTreeHook(
    req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook> {
    const mailboxSuffix = getProgramSuffix(
      fromAleoAddress(req.mailboxAddress).programId,
    );
    const programs = await this.deployProgram('hook_manager', mailboxSuffix);

    const hookManagerProgramId = programs['hook_manager'];
    assert(hookManagerProgramId, `hook manager program not deployed`);

    let nonce = await this.aleoClient.getProgramMappingValue(
      hookManagerProgramId,
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

    await this.sendAndConfirmTransaction(tx);

    const hookAddress = await this.aleoClient.getProgramMappingValue(
      hookManagerProgramId,
      'hook_addresses',
      nonce,
    );

    if (hookAddress === null) {
      throw new Error(
        `could not read hook address with nonce ${nonce} from hook_manager ${hookManagerProgramId}`,
      );
    }

    return {
      hookAddress: `${hookManagerProgramId}/${hookAddress}`,
    };
  }

  async createInterchainGasPaymasterHook(
    req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook> {
    const mailboxSuffix = getProgramSuffix(
      fromAleoAddress(req.mailboxAddress).programId,
    );
    const programs = await this.deployProgram('hook_manager', mailboxSuffix);

    const hookManagerProgramId = programs['hook_manager'];
    assert(hookManagerProgramId, `hook manager program not deployed`);

    let nonce = await this.aleoClient.getProgramMappingValue(
      hookManagerProgramId,
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

    await this.sendAndConfirmTransaction(tx);

    const hookAddress = await this.aleoClient.getProgramMappingValue(
      hookManagerProgramId,
      'hook_addresses',
      nonce,
    );

    if (hookAddress === null) {
      throw new Error(
        `could not read hook address with nonce ${nonce} from hook_manager`,
      );
    }

    return {
      hookAddress: `${hookManagerProgramId}/${hookAddress}`,
    };
  }

  async setInterchainGasPaymasterHookOwner(
    req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner> {
    const tx = await this.getSetInterchainGasPaymasterHookOwnerTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

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

    await this.sendAndConfirmTransaction(tx);

    return {
      destinationGasConfig: req.destinationGasConfig,
    };
  }

  async removeDestinationGasConfig(
    req: Omit<AltVM.ReqRemoveDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResRemoveDestinationGasConfig> {
    const tx = await this.getRemoveDestinationGasConfigTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      remoteDomainId: req.remoteDomainId,
    };
  }

  async createNoopHook(
    req: Omit<AltVM.ReqCreateNoopHook, 'signer'>,
  ): Promise<AltVM.ResCreateNoopHook> {
    const mailboxSuffix = getProgramSuffix(
      fromAleoAddress(req.mailboxAddress).programId,
    );
    const programs = await this.deployProgram('hook_manager', mailboxSuffix);

    const hookManagerProgramId = programs['hook_manager'];
    assert(hookManagerProgramId, `hook manager program not deployed`);

    let nonce = await this.aleoClient.getProgramMappingValue(
      hookManagerProgramId,
      'nonce',
      'true',
    );

    if (nonce === null) {
      nonce = '0u32';
    }

    const tx = await this.getCreateNoopHookTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    const hookAddress = await this.aleoClient.getProgramMappingValue(
      hookManagerProgramId,
      'hook_addresses',
      nonce,
    );

    if (hookAddress === null) {
      throw new Error(
        `could not read hook address with nonce ${nonce} from hook_manager`,
      );
    }

    return {
      hookAddress: `${hookManagerProgramId}/${hookAddress}`,
    };
  }

  async createValidatorAnnounce(
    req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce> {
    const validatorAnnounceSuffix = getProgramSuffix(
      fromAleoAddress(req.mailboxAddress).programId,
    );
    const programs = await this.deployProgram(
      'validator_announce',
      validatorAnnounceSuffix,
    );

    const tx = await this.getCreateValidatorAnnounceTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const validatorAnnounceId = programs['validator_announce'];
    assert(validatorAnnounceId, `validator announce program not deployed`);

    tx.programName = validatorAnnounceId;

    await this.sendAndConfirmTransaction(tx);

    return {
      validatorAnnounceId: toAleoAddress(validatorAnnounceId),
    };
  }

  // ### TX WARP ###

  async createNativeToken(
    req: Omit<AltVM.ReqCreateNativeToken, 'signer'>,
  ): Promise<AltVM.ResCreateNativeToken> {
    const tokenSuffix = this.generateSuffix(12);
    const mailboxSuffix = getProgramSuffix(
      fromAleoAddress(req.mailboxAddress).programId,
    );

    const programs = await this.deployProgram(
      'hyp_native',
      mailboxSuffix,
      tokenSuffix,
    );

    const tx = await this.getCreateNativeTokenTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const tokenProgramId = programs['hyp_native'];
    assert(tokenProgramId, `hyp native program not deployed`);

    tx.programName = tokenProgramId;

    tx.inputs = [programIdToPlaintext(tokenProgramId), ...tx.inputs];

    await this.sendAndConfirmTransaction(tx);

    return {
      tokenAddress: toAleoAddress(tokenProgramId),
    };
  }

  async createCollateralToken(
    req: Omit<AltVM.ReqCreateCollateralToken, 'signer'>,
  ): Promise<AltVM.ResCreateCollateralToken> {
    const { symbol } = await this.getTokenMetadata(req.collateralDenom);

    const tokenSuffix = `${symbol}_${this.generateSuffix(6)}`;
    const mailboxSuffix = getProgramSuffix(
      fromAleoAddress(req.mailboxAddress).programId,
    );

    const programs = await this.deployProgram(
      'hyp_collateral',
      mailboxSuffix,
      tokenSuffix,
    );

    const tx = await this.getCreateCollateralTokenTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const tokenProgramId = programs['hyp_collateral'];
    assert(tokenProgramId, `hyp collateral program not deployed`);

    tx.programName = tokenProgramId;

    tx.inputs = [programIdToPlaintext(tokenProgramId), ...tx.inputs];

    await this.sendAndConfirmTransaction(tx);

    return {
      tokenAddress: toAleoAddress(tokenProgramId),
    };
  }

  async createSyntheticToken(
    req: Omit<AltVM.ReqCreateSyntheticToken, 'signer'>,
  ): Promise<AltVM.ResCreateSyntheticToken> {
    const tokenSuffix = `${req.denom.toLowerCase()}_${this.generateSuffix(6)}`;
    const mailboxSuffix = getProgramSuffix(
      fromAleoAddress(req.mailboxAddress).programId,
    );

    const programs = await this.deployProgram(
      'hyp_synthetic',
      mailboxSuffix,
      tokenSuffix,
    );

    const tx = await this.getCreateSyntheticTokenTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    const tokenProgramId = programs['hyp_synthetic'];
    assert(tokenProgramId, `hyp synthetic program not deployed`);

    tx.programName = tokenProgramId;

    tx.inputs = [programIdToPlaintext(tokenProgramId), ...tx.inputs];

    await this.sendAndConfirmTransaction(tx);

    return {
      tokenAddress: toAleoAddress(tokenProgramId),
    };
  }

  async setTokenOwner(
    req: Omit<AltVM.ReqSetTokenOwner, 'signer'>,
  ): Promise<AltVM.ResSetTokenOwner> {
    const tx = await this.getSetTokenOwnerTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      newOwner: req.newOwner,
    };
  }

  async setTokenIsm(
    req: Omit<AltVM.ReqSetTokenIsm, 'signer'>,
  ): Promise<AltVM.ResSetTokenIsm> {
    const tx = await this.getSetTokenIsmTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      ismAddress: req.ismAddress,
    };
  }

  async setTokenHook(
    req: Omit<AltVM.ReqSetTokenHook, 'signer'>,
  ): Promise<AltVM.ResSetTokenHook> {
    const tx = await this.getSetTokenHookTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      hookAddress: req.hookAddress,
    };
  }

  async enrollRemoteRouter(
    req: Omit<AltVM.ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResEnrollRemoteRouter> {
    const tx = await this.getEnrollRemoteRouterTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      receiverDomainId: req.remoteRouter.receiverDomainId,
    };
  }

  async unenrollRemoteRouter(
    req: Omit<AltVM.ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResUnenrollRemoteRouter> {
    const tx = await this.getUnenrollRemoteRouterTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      receiverDomainId: req.receiverDomainId,
    };
  }

  async transfer(
    req: Omit<AltVM.ReqTransfer, 'signer'>,
  ): Promise<AltVM.ResTransfer> {
    const tx = await this.getTransferTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      recipient: req.recipient,
    };
  }

  async remoteTransfer(
    req: Omit<AltVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<AltVM.ResRemoteTransfer> {
    const tx = await this.getRemoteTransferTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      tokenAddress: req.tokenAddress,
    };
  }
}
