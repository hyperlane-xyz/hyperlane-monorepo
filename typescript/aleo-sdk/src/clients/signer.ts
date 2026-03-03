import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import { type TokenType } from '@hyperlane-xyz/provider-sdk/warp';
import { assert, isNullish, retryAsync } from '@hyperlane-xyz/utils';

import { type AleoProgram } from '../artifacts.js';
import {
  RETRY_ATTEMPTS,
  RETRY_DELAY_MS,
  SUFFIX_LENGTH_LONG,
  SUFFIX_LENGTH_SHORT,
  fromAleoAddress,
  getProgramIdFromSuffix,
  getProgramSuffix,
  loadProgramsInDeployOrder,
  programIdToPlaintext,
  toAleoAddress,
} from '../utils/helper.js';
import { type AleoReceipt, type AleoTransaction } from '../utils/types.js';

import { type AnyProgramManager } from './base.js';
import { AleoProvider } from './provider.js';

export class AleoSigner
  extends AleoProvider
  implements AltVM.ISigner<AleoTransaction, AleoReceipt>
{
  private static readonly WARP_SUFFIX_ALREADY_DEPLOYED_ERROR =
    'already deployed, please choose another suffix';
  private readonly programManager: AnyProgramManager;

  static async connectWithSigner(
    rpcUrls: string[],
    privateKey: string,
    extraParams?: Record<string, any>,
  ): Promise<AltVM.ISigner<AleoTransaction, AleoReceipt>> {
    assert(extraParams, `extra params not defined`);

    const metadata = extraParams.metadata as Record<string, unknown>;
    assert(metadata, `metadata not defined in extra params`);
    assert(
      !isNullish(metadata.chainId),
      `chainId not defined in metadata extra params`,
    );

    const chainId = parseInt(metadata.chainId!.toString());

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

  async getIsmManager(): Promise<string> {
    // Use the configured ISM manager program ID (from env or default)
    const ismManagerProgramId = this.ismManager;

    // Check if it's already deployed
    const isDeployed = await this.isProgramDeployed(ismManagerProgramId);

    if (!isDeployed) {
      const suffix = getProgramSuffix(ismManagerProgramId);
      await this.deployProgram('ism_manager', suffix);
    }

    return ismManagerProgramId;
  }

  private async isProgramDeployed(programId: string): Promise<boolean> {
    try {
      await this.aleoClient.getProgram(programId);
      return true;
    } catch {
      return false;
    }
  }

  private isProgramAlreadyExistsError(
    err: unknown,
    programId: string,
  ): boolean {
    return (
      err instanceof Error &&
      err.message.includes('already exists on the network') &&
      err.message.includes(programId)
    );
  }

  private async getUnusedSuffix(
    programName: AleoProgram,
    length: number,
    maxAttempts = 20,
  ): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      const suffix = this.generateSuffix(length);
      const programId = getProgramIdFromSuffix(
        this.prefix,
        programName,
        suffix,
      );
      if (!(await this.isProgramDeployed(programId))) {
        return suffix;
      }
    }

    throw new Error(
      `Could not find an unused suffix for ${programName} after ${maxAttempts} attempts`,
    );
  }

  async getWarpTokenSuffix(
    tokenType: TokenType,
    preferredSuffix?: string,
    maxAttempts = 20,
  ): Promise<string> {
    const configuredSuffix = preferredSuffix || this.warpSuffix;

    if (configuredSuffix) {
      const tokenProgramId = `${this.prefix}_${tokenType}_${configuredSuffix}.aleo`;

      const isAlreadyDeployed = await this.isProgramDeployed(tokenProgramId);
      assert(
        !isAlreadyDeployed,
        `Warp route with suffix ${configuredSuffix} ${AleoSigner.WARP_SUFFIX_ALREADY_DEPLOYED_ERROR}`,
      );

      return configuredSuffix;
    }

    for (let i = 0; i < maxAttempts; i++) {
      const suffix = this.generateSuffix(SUFFIX_LENGTH_LONG);
      const tokenProgramId = `${this.prefix}_${tokenType}_${suffix}.aleo`;

      if (!(await this.isProgramDeployed(tokenProgramId))) {
        return suffix;
      }
    }

    throw new Error(
      `Could not find an unused suffix for ${tokenType} after ${maxAttempts} attempts`,
    );
  }

  public async deployProgram(
    programName: AleoProgram,
    coreSuffix: string,
    warpSuffix?: string,
  ): Promise<Partial<Record<AleoProgram, string>>> {
    const programs = loadProgramsInDeployOrder(
      this.prefix,
      programName,
      coreSuffix,
      warpSuffix,
    );

    for (const { id, program } of programs) {
      if (await this.isProgramDeployed(id)) {
        continue;
      }

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
        if (this.isProgramAlreadyExistsError(err, id)) {
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

  getNetworkPrefix(): string {
    return this.prefix;
  }

  /**
   * Get the hook manager program ID for a given mailbox suffix.
   * Deploys the hook_manager program if it's not already deployed.
   *
   * @param suffix - The mailbox suffix
   * @returns The hook manager program ID
   */
  async getHookManager(suffix: string): Promise<string> {
    const programs = await this.deployProgram('hook_manager', suffix);
    const hookManagerProgramId = programs['hook_manager'];
    assert(hookManagerProgramId, `hook_manager program not deployed`);
    return hookManagerProgramId;
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

    const txId = await retryAsync(
      () => this.programManager.networkClient.submitTransaction(tx),
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
    );
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
    if (req.proxyAdminAddress) {
      throw new Error(
        'ProxyAdmin is not supported on Aleo. Remove proxyAdmin from config.',
      );
    }

    const mailboxSuffix = await this.getUnusedSuffix(
      'mailbox',
      SUFFIX_LENGTH_LONG,
    );
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
    const mailboxSuffix = this.generateSuffix(SUFFIX_LENGTH_LONG);
    const programs = await this.deployProgram('ism_manager', mailboxSuffix);

    const ismManagerProgramId = programs['ism_manager'];
    assert(ismManagerProgramId, `ism manager program not deployed`);

    let nonce = await retryAsync(
      () =>
        this.aleoClient.getProgramMappingValue(
          ismManagerProgramId,
          'nonce',
          'true',
        ),
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
    );

    if (nonce === null) {
      nonce = '0u32';
    }

    const tx = await this.getCreateMessageIdMultisigIsmTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    const ismAddress = await this.queryMappingString(
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
    const mailboxSuffix = this.generateSuffix(SUFFIX_LENGTH_LONG);
    const programs = await this.deployProgram('ism_manager', mailboxSuffix);

    const ismManagerProgramId = programs['ism_manager'];
    assert(ismManagerProgramId, `ism manager program not deployed`);

    let nonce = await retryAsync(
      () =>
        this.aleoClient.getProgramMappingValue(
          ismManagerProgramId,
          'nonce',
          'true',
        ),
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
    );

    if (nonce === null) {
      nonce = '0u32';
    }

    const tx = await this.getCreateRoutingIsmTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    const ismAddress = await this.queryMappingString(
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
    const mailboxSuffix = this.generateSuffix(SUFFIX_LENGTH_LONG);
    const programs = await this.deployProgram('ism_manager', mailboxSuffix);

    const ismManagerProgramId = programs['ism_manager'];
    assert(ismManagerProgramId, `ism manager program not deployed`);

    let nonce = await retryAsync(
      () =>
        this.aleoClient.getProgramMappingValue(
          ismManagerProgramId,
          'nonce',
          'true',
        ),
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
    );

    if (nonce === null) {
      nonce = '0u32';
    }

    const tx = await this.getCreateNoopIsmTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    const ismAddress = await this.queryMappingString(
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

    let nonce = await retryAsync(
      () =>
        this.aleoClient.getProgramMappingValue(
          hookManagerProgramId,
          'nonce',
          'true',
        ),
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
    );

    if (nonce === null) {
      nonce = '0u32';
    }

    const tx = await this.getCreateMerkleTreeHookTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    const hookAddress = await this.queryMappingString(
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

    let nonce = await retryAsync(
      () =>
        this.aleoClient.getProgramMappingValue(
          hookManagerProgramId,
          'nonce',
          'true',
        ),
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
    );

    if (nonce === null) {
      nonce = '0u32';
    }

    const tx = await this.getCreateInterchainGasPaymasterHookTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    const hookAddress = await this.queryMappingString(
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

    let nonce = await retryAsync(
      () =>
        this.aleoClient.getProgramMappingValue(
          hookManagerProgramId,
          'nonce',
          'true',
        ),
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
    );

    if (nonce === null) {
      nonce = '0u32';
    }

    const tx = await this.getCreateNoopHookTransaction({
      signer: this.getSignerAddress(),
      ...req,
    });

    await this.sendAndConfirmTransaction(tx);

    const hookAddress = await this.queryMappingString(
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
    const validatorAnnounceSuffix = this.generateSuffix(SUFFIX_LENGTH_SHORT);
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

  async createProxyAdmin(
    _req: Omit<AltVM.ReqCreateProxyAdmin, 'signer'>,
  ): Promise<AltVM.ResCreateProxyAdmin> {
    throw new Error('ProxyAdmin is not supported on Aleo');
  }

  async setProxyAdminOwner(
    _req: Omit<AltVM.ReqSetProxyAdminOwner, 'signer'>,
  ): Promise<AltVM.ResSetProxyAdminOwner> {
    throw new Error('ProxyAdmin is not supported on Aleo');
  }

  // ### TX WARP ###

  async createNativeToken(
    req: Omit<AltVM.ReqCreateNativeToken, 'signer'>,
  ): Promise<AltVM.ResCreateNativeToken> {
    if (req.proxyAdminAddress) {
      throw new Error(
        'ProxyAdmin is not supported on Aleo. Remove proxyAdmin from config.',
      );
    }

    const tokenSuffix = await this.getWarpTokenSuffix('native', req.warpSuffix);
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
    if (req.proxyAdminAddress) {
      throw new Error(
        'ProxyAdmin is not supported on Aleo. Remove proxyAdmin from config.',
      );
    }

    const tokenSuffix = await this.getWarpTokenSuffix(
      'collateral',
      req.warpSuffix,
    );
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
    if (req.proxyAdminAddress) {
      throw new Error(
        'ProxyAdmin is not supported on Aleo. Remove proxyAdmin from config.',
      );
    }

    const tokenSuffix = await this.getWarpTokenSuffix(
      'synthetic',
      req.warpSuffix,
    );
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
      ismAddress:
        req.ismAddress ?? '0x0000000000000000000000000000000000000000',
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
      hookAddress:
        req.hookAddress ?? '0x0000000000000000000000000000000000000000',
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
