import { ethers } from 'ethers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
// @ts-ignore
import { getSafe, getSafeService } from '@hyperlane-xyz/sdk';
import { CallData, isZeroishAddress } from '@hyperlane-xyz/utils';

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
        gasLimit: estimate.mul(11).div(10), // 10% buffer
        ...call,
      });
      console.log(`confirmed tx ${receipt.transactionHash}`);
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
    public readonly safeAddress: string,
  ) {
    super();
  }

  async sendTransactions(calls: CallData[]) {
    const safeSdk = await getSafe(
      this.chain,
      this.multiProvider,
      this.safeAddress,
    );
    const safeService = getSafeService(this.chain, this.multiProvider);

    if (isZeroishAddress(safeSdk.getMultiSendAddress())) {
      console.log(
        `MultiSend contract not deployed on ${this.chain}. Proposing transactions individually.`,
      );
      await this.proposeIndividualTransactions(calls, safeSdk, safeService);
    } else {
      await this.proposeMultiSendTransaction(calls, safeSdk, safeService);
    }
  }

  // Helper function to delete all pending transactions
  public async deleteAllPendingTxs() {
    const safeService = getSafeService(this.chain, this.multiProvider);
    const pendingTransactions = await safeService.getPendingTransactions(
      this.safeAddress,
    );

    for (const tx of pendingTransactions.results) {
      await this.deleteTx(tx.safeTxHash);
    }
  }

  // Helper function to delete a single transaction
  public async deleteTx(safeTxHash: string) {
    const signer = this.multiProvider.getSigner(this.chain);
    const domainId = this.multiProvider.getDomainId(this.chain);
    const txServiceUrl = this.multiProvider.getChainMetadata(
      this.chain,
    ).gnosisSafeTransactionServiceUrl;

    // Fetch the transaction details to get the proposer
    const txDetailsUrl = `${txServiceUrl}/api/v1/multisig-transactions/${safeTxHash}/`;
    const txDetailsResponse = await fetch(txDetailsUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!txDetailsResponse.ok) {
      console.error(`Failed to fetch transaction details for ${safeTxHash}`);
      return;
    }

    const txDetails = await txDetailsResponse.json();
    const proposer = txDetails.proposer;

    if (!proposer) {
      console.error(`No proposer found for transaction ${safeTxHash}`);
      return;
    }

    // Compare proposer to signer
    const signerAddress = await signer.getAddress();
    if (proposer !== signerAddress) {
      console.log(
        `Skipping deletion of transaction ${safeTxHash} proposed by ${proposer}`,
      );
      return;
    }
    console.log(`Deleting transaction ${safeTxHash} proposed by ${proposer}`);

    try {
      // Generate the EIP-712 signature
      const totp = Math.floor(Date.now() / 1000 / 3600); // Generate TOTP with T0=0 and Tx=3600
      const typedData = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          DeleteRequest: [
            { name: 'safeTxHash', type: 'bytes32' },
            { name: 'totp', type: 'uint256' },
          ],
        },
        domain: {
          name: 'Safe Transaction Service',
          version: '1.0',
          chainId: domainId,
          verifyingContract: this.safeAddress,
        },
        primaryType: 'DeleteRequest',
        message: {
          safeTxHash: safeTxHash,
          totp: totp,
        },
      };

      const signature = await (signer as ethers.Wallet)._signTypedData(
        typedData.domain,
        { DeleteRequest: typedData.types.DeleteRequest },
        typedData.message,
      );

      // Make the API call to delete the transaction
      const deleteUrl = `${txServiceUrl}/api/v1/multisig-transactions/${safeTxHash}/`;
      const res = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          safeTxHash: safeTxHash,
          signature: signature,
        }),
      });

      if (res.status === 204) {
        console.log(
          `Successfully deleted transaction ${safeTxHash} (No Content)`,
        );
        return;
      }

      const errorBody = await res.text();
      console.error(
        `Failed to delete transaction ${safeTxHash}: Status ${res.status} ${res.statusText}. Response body: ${errorBody}`,
      );
    } catch (error) {
      console.error(`Failed to delete transaction ${safeTxHash}:`, error);
    }
  }

  // Helper function to propose individual transactions
  private async proposeIndividualTransactions(
    calls: CallData[],
    safeSdk: any,
    safeService: any,
  ) {
    for (const call of calls) {
      const safeTransactionData = this.createSafeTransactionData(call);
      const safeTransaction = await this.createSafeTransaction(
        safeSdk,
        safeService,
        safeTransactionData,
      );
      await this.proposeSafeTransaction(safeSdk, safeService, safeTransaction);
    }
  }

  // Helper function to propose a multi-send transaction
  private async proposeMultiSendTransaction(
    calls: CallData[],
    safeSdk: any,
    safeService: any,
  ) {
    const safeTransactionData = calls.map(this.createSafeTransactionData);
    const safeTransaction = await this.createSafeTransaction(
      safeSdk,
      safeService,
      safeTransactionData,
    );
    await this.proposeSafeTransaction(safeSdk, safeService, safeTransaction);
  }

  // Helper function to create safe transaction data
  private createSafeTransactionData(call: CallData) {
    return {
      to: call.to,
      data: call.data.toString(),
      value: call.value?.toString() || '0',
    };
  }

  // Helper function to create a safe transaction
  private async createSafeTransaction(
    safeSdk: any,
    safeService: any,
    safeTransactionData: any,
  ) {
    const nextNonce = await safeService.getNextNonce(this.safeAddress);
    return safeSdk.createTransaction({
      safeTransactionData,
      options: { nonce: nextNonce },
    });
  }

  // Helper function to propose a safe transaction
  private async proposeSafeTransaction(
    safeSdk: any,
    safeService: any,
    safeTransaction: any,
  ) {
    const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
    const senderSignature = await safeSdk.signTransactionHash(safeTxHash);
    const senderAddress = await this.multiProvider.getSignerAddress(this.chain);

    await safeService.proposeTransaction({
      safeAddress: this.safeAddress,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress,
      senderSignature: senderSignature.data,
    });

    console.log(`Proposed transaction with hash ${safeTxHash}`);
  }
}
