import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import { type TokenType } from '@hyperlane-xyz/provider-sdk/warp';
import { assert, isNullish, retryAsync } from '@hyperlane-xyz/utils';

import { type AleoProgram } from '../artifacts.js';
import {
  RETRY_ATTEMPTS,
  RETRY_DELAY_MS,
  SUFFIX_LENGTH_LONG,
  getProgramSuffix,
  loadProgramsInDeployOrder,
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
  ): Promise<AleoSigner> {
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
}
