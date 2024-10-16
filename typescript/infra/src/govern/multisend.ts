import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import { SafeTransaction } from '@safe-global/safe-core-sdk-types';
import chalk from 'chalk';
import { BigNumber } from 'ethers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import {
  Address,
  CallData,
  addBufferToGasLimit,
  eqAddress,
} from '@hyperlane-xyz/utils';

import safeSigners from '../../config/environments/mainnet3/safe/safeSigners.json' assert { type: 'json' };
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
    const { safeSdk, safeService } = await getSafeAndService(
      this.chain,
      this.multiProvider,
      this.safeAddress,
    );

    const updateOwnerCalls = await this.updateSafeOwner(safeSdk);
    const multisendCalls = [...updateOwnerCalls, ...calls];

    // If the multiSend address is the same as the safe address, we need to
    // propose the transactions individually. See: gnosisSafe.js in the SDK.
    if (eqAddress(safeSdk.getMultiSendAddress(), this.safeAddress)) {
      console.info(
        chalk.gray(
          `MultiSend contract not deployed on ${this.chain}. Proposing transactions individually.`,
        ),
      );
      await this.proposeIndividualTransactions(
        multisendCalls,
        safeSdk,
        safeService,
      );
    } else {
      await this.proposeMultiSendTransaction(
        multisendCalls,
        safeSdk,
        safeService,
      );
    }
  }

  private async updateSafeOwner(safeSdk: Safe.default): Promise<CallData[]> {
    const threshold = await safeSdk.getThreshold();
    const owners = await safeSdk.getOwners();
    const newOwners = safeSigners.signers;
    const ownersToRemove = owners.filter(
      (owner) => !newOwners.some((newOwner) => eqAddress(owner, newOwner)),
    );
    const ownersToAdd = newOwners.filter(
      (newOwner) => !owners.some((owner) => eqAddress(newOwner, owner)),
    );

    console.log(chalk.magentaBright('Owners to remove:', ownersToRemove));
    console.log(chalk.magentaBright('Owners to add:', ownersToAdd));

    const transactions = [];

    for (const ownerToRemove of ownersToRemove) {
      const { data: removeTxData } = await safeSdk.createRemoveOwnerTx({
        ownerAddress: ownerToRemove,
        threshold,
      });
      transactions.push({
        to: removeTxData.to,
        data: removeTxData.data,
        value: BigNumber.from(removeTxData.value),
      });
    }

    for (const ownerToAdd of ownersToAdd) {
      const { data: addTxData } = await safeSdk.createAddOwnerTx({
        ownerAddress: ownerToAdd,
        threshold,
      });
      transactions.push({
        to: addTxData.to,
        data: addTxData.data,
        value: BigNumber.from(addTxData.value),
      });
    }

    return transactions;
  }

  // Helper function to propose individual transactions
  private async proposeIndividualTransactions(
    calls: CallData[],
    safeSdk: Safe.default,
    safeService: SafeApiKit.default,
  ) {
    for (const call of calls) {
      const safeTransactionData = createSafeTransactionData(call);
      const safeTransaction = await createSafeTransaction(
        safeSdk,
        safeService,
        this.safeAddress,
        [safeTransactionData],
      );
      await this.proposeSafeTransaction(safeSdk, safeService, safeTransaction);
    }
  }

  // Helper function to propose a multi-send transaction
  private async proposeMultiSendTransaction(
    calls: CallData[],
    safeSdk: Safe.default,
    safeService: SafeApiKit.default,
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
    await this.proposeSafeTransaction(safeSdk, safeService, safeTransaction);
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
}
