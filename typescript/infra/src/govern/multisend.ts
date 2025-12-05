import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import { SafeTransaction } from '@safe-global/safe-core-sdk-types';
import chalk from 'chalk';

import {
  ChainName,
  EV5GnosisSafeTxBuilder,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  CallData,
  addBufferToGasLimit,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  createSafeTransaction,
  createSafeTransactionData,
  getSafeAndService,
  proposeSafeTransaction,
} from '../utils/safe.js';

export abstract class MultiSend {
  abstract sendTransactions(calls: CallData[]): Promise<void>;
}

export class SignerMultiSend extends MultiSend {
  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
  ) {
    super();
  }

  async sendTransactions(calls: CallData[]) {
    for (const call of calls) {
      const estimate = await this.multiProvider.estimateGas(this.chain, call);
      const receipt = await this.multiProvider.sendTransaction(this.chain, {
        gasLimit: addBufferToGasLimit(estimate),
        ...call,
      });
      console.log(chalk.green(`Confirmed tx ${receipt.transactionHash}`));
    }
  }
}

export class ManualMultiSend extends MultiSend {
  readonly chain: ChainName;

  constructor(chain: ChainName) {
    super();
    this.chain = chain;
  }

  async sendTransactions(calls: CallData[]) {
    console.log(`Please submit the following manually to ${this.chain}:`);
    console.log(JSON.stringify(calls));
  }
}

export class SafeMultiSend extends MultiSend {
  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
    public readonly safeAddress: Address,
  ) {
    super();
  }

  async sendTransactions(calls: CallData[]) {
    // Always generate JSON using EV5GnosisSafeTxBuilder as a fallback
    // This ensures we have the JSON available even if Safe API calls fail
    let jsonPayload: any = null;
    try {
      const txBuilder = await EV5GnosisSafeTxBuilder.create(
        this.multiProvider,
        {
          chain: this.chain,
          safeAddress: this.safeAddress,
          version: '1.0',
        },
      );

      // Convert CallData to AnnotatedEV5Transaction format
      const chainId = this.multiProvider.getChainId(this.chain);
      const annotatedTxs = calls.map((call) => ({
        to: call.to,
        data: call.data,
        value: call.value,
        chainId,
      }));

      jsonPayload = await txBuilder.submit(...annotatedTxs);
      rootLogger.info(
        chalk.blue(
          `Generated Safe Transaction Builder JSON for ${this.chain} (${calls.length} transaction(s))`,
        ),
      );
    } catch (error) {
      rootLogger.warn(
        chalk.yellow(
          `Failed to generate Safe Transaction Builder JSON: ${error}. Continuing with API submission attempt...`,
        ),
      );
    }

    const { safeSdk, safeService } = await getSafeAndService(
      this.chain,
      this.multiProvider,
      this.safeAddress,
    );

    // If the multiSend address is the same as the safe address, we need to
    // propose the transactions individually. See: gnosisSafe.js in the SDK.
    if (eqAddress(safeSdk.getMultiSendAddress(), this.safeAddress)) {
      console.info(
        chalk.gray(
          `MultiSend contract not deployed on ${this.chain}. Proposing transactions individually.`,
        ),
      );
      await this.proposeIndividualTransactions(
        calls,
        safeSdk,
        safeService,
        jsonPayload,
      );
    } else {
      await this.proposeMultiSendTransaction(
        calls,
        safeSdk,
        safeService,
        jsonPayload,
      );
    }
  }

  // Helper function to propose individual transactions
  private async proposeIndividualTransactions(
    calls: CallData[],
    safeSdk: Safe.default,
    safeService: SafeApiKit.default,
    jsonPayload: any,
  ) {
    for (const call of calls) {
      const safeTransactionData = createSafeTransactionData(call);
      const safeTransaction = await createSafeTransaction(
        safeSdk,
        safeService,
        this.safeAddress,
        [safeTransactionData],
      );
      try {
        await this.proposeSafeTransaction(
          safeSdk,
          safeService,
          safeTransaction,
        );
      } catch (error) {
        rootLogger.error(
          chalk.red(
            `Failed to propose Safe transaction via API: ${error}. Falling back to manual JSON upload.`,
          ),
        );
        this.displayFallbackJson(jsonPayload, call);
        throw error;
      }
    }
  }

  // Helper function to propose a multi-send transaction
  private async proposeMultiSendTransaction(
    calls: CallData[],
    safeSdk: Safe.default,
    safeService: SafeApiKit.default,
    jsonPayload: any,
  ) {
    const safeTransactionData = calls.map((call) =>
      createSafeTransactionData(call),
    );
    const safeTransaction = await createSafeTransaction(
      safeSdk,
      safeService,
      this.safeAddress,
      safeTransactionData,
      true,
    );
    try {
      await this.proposeSafeTransaction(safeSdk, safeService, safeTransaction);
    } catch (error) {
      rootLogger.error(
        chalk.red(
          `Failed to propose Safe transaction via API: ${error}. Falling back to manual JSON upload.`,
        ),
      );
      this.displayFallbackJson(jsonPayload);
      throw error;
    }
  }

  // Helper function to propose a safe transaction
  private async proposeSafeTransaction(
    safeSdk: Safe.default,
    safeService: SafeApiKit.default,
    safeTransaction: SafeTransaction,
  ) {
    const signer = this.multiProvider.getSigner(this.chain);
    await proposeSafeTransaction(
      this.chain,
      safeSdk,
      safeService,
      safeTransaction,
      this.safeAddress,
      signer,
    );
  }

  // Helper function to display JSON for manual upload when API fails
  private displayFallbackJson(jsonPayload: any, specificCall?: CallData) {
    if (!jsonPayload) {
      rootLogger.warn(
        chalk.yellow(
          `No JSON payload available for fallback. Safe API call failed and JSON generation was not successful.`,
        ),
      );
      return;
    }

    rootLogger.info(
      chalk.bold.yellow(
        `\n${'='.repeat(80)}\n` +
          `SAFE API CALL FAILED - MANUAL JSON UPLOAD REQUIRED\n` +
          `${'='.repeat(80)}\n` +
          `Chain: ${this.chain}\n` +
          `Safe Address: ${this.safeAddress}\n` +
          `\nPlease manually upload the following JSON to the Safe Transaction Builder:\n` +
          `${'='.repeat(80)}\n`,
      ),
    );

    // If we have a specific call that failed, we could filter the JSON
    // For now, we'll show the full payload
    console.log(JSON.stringify(jsonPayload, null, 2));

    rootLogger.info(
      chalk.bold.yellow(
        `\n${'='.repeat(80)}\n` +
          `Copy the JSON above and upload it to: https://app.safe.global/transactions/import?safe=${this.chain}:${this.safeAddress}\n` +
          `${'='.repeat(80)}\n`,
      ),
    );
  }
}
