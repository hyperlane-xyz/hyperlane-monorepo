import { BigNumber, Wallet, providers } from 'ethers';
import { TronWeb } from 'tronweb';

import { assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

/**
 * TronWallet extends ethers Wallet to handle Tron's transaction format.
 *
 * Tron's JSON-RPC doesn't support eth_sendRawTransaction, so we override
 * sendTransaction to use TronWeb for building, signing, and broadcasting.
 *
 * Gas estimation is handled by ethers (via eth_estimateGas), and we convert
 * gasLimit to Tron's feeLimit using: feeLimit = gasLimit × gasPrice.
 */
export class TronWallet extends Wallet {
  private tronWeb: TronWeb;
  private tronAddress: string;

  constructor(
    privateKey: string,
    provider: providers.Provider,
    tronGridUrl: string,
  ) {
    super(privateKey, provider);

    this.tronWeb = new TronWeb({ fullHost: tronGridUrl });
    const cleanKey = strip0x(privateKey);
    this.tronWeb.setPrivateKey(cleanKey);

    const derivedAddress = this.tronWeb.address.fromPrivateKey(cleanKey);
    assert(derivedAddress, 'Failed to derive Tron address from private key');
    this.tronAddress = derivedAddress;
    this.tronWeb.setAddress(this.tronAddress);
  }

  /** Convert ethers 0x address to Tron 41-prefixed hex */
  private toTronHex(address: string): string {
    return '41' + strip0x(address);
  }

  /** Convert Tron address to ethers 0x address */
  private toEvmAddress(tronAddress: string): string {
    const hex = this.tronWeb.address.toHex(tronAddress);
    return ensure0x(hex.slice(2));
  }

  /** Tron doesn't use nonces */
  async getTransactionCount(_blockTag?: providers.BlockTag): Promise<number> {
    return 0;
  }

  async sendTransaction(
    transaction: providers.TransactionRequest,
  ): Promise<providers.TransactionResponse> {
    // Populate transaction (estimates gas and gas price if not set)
    const tx = await this.populateTransaction(transaction);
    assert(tx.gasLimit, 'gasLimit is required');
    assert(tx.gasPrice, 'gasPrice is required');

    // Convert gasLimit to feeLimit: feeLimit = gasLimit × gasPrice
    const gasPrice = BigNumber.from(tx.gasPrice);
    const gasLimit = BigNumber.from(tx.gasLimit);
    const feeLimit = gasLimit.mul(gasPrice).toNumber();
    const callValue = tx.value ? BigNumber.from(tx.value).toNumber() : 0;

    let tronTx: any;
    let contractAddress: string | undefined;

    if (!tx.to) {
      // Contract deployment
      assert(tx.data, 'Deployment transaction must have data');
      tronTx = await this.tronWeb.transactionBuilder.createSmartContract(
        {
          abi: [],
          bytecode: strip0x(tx.data.toString()),
          feeLimit,
          callValue,
          originEnergyLimit: gasLimit.toNumber(),
        },
        this.tronAddress,
      );

      contractAddress = this.toEvmAddress(tronTx.contract_address);
    } else if (tx.data && tx.data !== '0x') {
      // Contract call
      const result = await this.tronWeb.transactionBuilder.triggerSmartContract(
        this.toTronHex(tx.to),
        '',
        { feeLimit, callValue, rawParameter: strip0x(tx.data.toString()) },
        [],
        this.tronAddress,
      );
      assert(
        result.result?.result,
        `triggerSmartContract failed: ${result.result?.message}`,
      );
      tronTx = result.transaction;
    } else {
      // Simple TRX transfer
      tronTx = await this.tronWeb.transactionBuilder.sendTrx(
        this.toTronHex(tx.to),
        callValue,
        this.tronAddress,
      );
    }

    // Sign and broadcast
    const signedTx = await this.tronWeb.trx.sign(tronTx);
    const result = await this.tronWeb.trx.sendRawTransaction(signedTx);
    assert(result.result, `Broadcast failed: ${result.message}`);

    const txHash = ensure0x(tronTx.txID);

    // Build the transaction response
    const response: providers.TransactionResponse = {
      hash: txHash,
      confirmations: 0,
      from: this.address,
      to: tx.to ?? undefined,
      nonce: 0,
      gasLimit: BigNumber.from(feeLimit),
      gasPrice,
      data: tx.data?.toString() || '0x',
      value: BigNumber.from(tx.value || 0),
      chainId: (await this.provider!.getNetwork()).chainId,
      wait: async (_confirmations?: number) => {
        const receipt = await this.provider!.waitForTransaction(txHash);
        // Always use the contract address from TronWeb for deployments
        if (contractAddress) {
          (receipt as any).contractAddress = contractAddress;
        }
        // Check if transaction reverted
        if (receipt.status === 0) {
          throw new Error(
            `Transaction ${txHash} reverted on Tron (status=0). Receipt: ${JSON.stringify(receipt)}`,
          );
        }
        return receipt;
      },
    };

    return response;
  }
}
