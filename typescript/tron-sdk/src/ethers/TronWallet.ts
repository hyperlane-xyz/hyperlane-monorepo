import { BigNumber, Wallet, providers, utils } from 'ethers';
import { TronWeb } from 'tronweb';

import { assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

// Multiplier for energy estimation to add safety buffer (1.5x)
const ENERGY_BUFFER_MULTIPLIER = 1.5;
// Maximum fee limit allowed by Tron (1000 TRX = 1,000,000,000 sun)
const MAX_FEE_LIMIT = 1_000_000_000;
// Minimum fee limit for deployments (100 TRX) - fallback if estimation fails
const MIN_DEPLOY_FEE_LIMIT = 100_000_000;
// Minimum fee limit for calls (10 TRX) - fallback if estimation fails
const MIN_CALL_FEE_LIMIT = 10_000_000;

/**
 * TronWallet extends ethers Wallet to handle Tron's transaction format.
 *
 * Tron's JSON-RPC doesn't support eth_sendRawTransaction, so we override
 * sendTransaction to use TronWeb for building, signing, and broadcasting
 * transactions.
 *
 * Key differences from standard ethers Wallet:
 * - Transactions are built using TronWeb's transactionBuilder
 * - Signing uses TronWeb's trx.sign() method
 * - Broadcasting uses TronWeb's trx.sendRawTransaction()
 * - Nonces are not used (getTransactionCount returns 0)
 * - Contract addresses come from TronWeb transaction results
 * - Fee limits are dynamically calculated based on energy estimation
 */
export class TronWallet extends Wallet {
  private tronWeb: TronWeb;
  private tronAddress: string; // Address in Tron format (41-prefixed hex or Base58)

  /**
   * Create a TronWallet from a private key.
   *
   * @param privateKey - The private key (hex string with or without 0x prefix)
   * @param provider - The TronJsonRpcProvider to use for read operations
   * @param tronGridUrl - The TronGrid/HTTP API URL for TronWeb (e.g. https://api.trongrid.io)
   */
  constructor(
    privateKey: string,
    provider: providers.Provider,
    tronGridUrl: string,
  ) {
    super(privateKey, provider);

    // Initialize TronWeb with the TronGrid HTTP API URL
    this.tronWeb = new TronWeb({ fullHost: tronGridUrl });

    // Set the private key on TronWeb
    const cleanKey = strip0x(privateKey);
    this.tronWeb.setPrivateKey(cleanKey);

    // Derive Tron address from private key
    const derivedAddress = this.tronWeb.address.fromPrivateKey(cleanKey);
    assert(derivedAddress, 'Failed to derive Tron address from private key');
    this.tronAddress = derivedAddress;
    this.tronWeb.setAddress(this.tronAddress);
  }

  /**
   * Create a TronWallet connected to a provider.
   */
  static fromPrivateKey(
    privateKey: string,
    provider: providers.Provider,
    tronGridUrl: string,
  ): TronWallet {
    return new TronWallet(privateKey, provider, tronGridUrl);
  }

  /**
   * Get the Tron address in Base58 format.
   */
  getTronAddress(): string {
    return this.tronAddress;
  }

  /**
   * Convert an ethers-style 0x address to Tron 41-prefixed hex.
   */
  private toTronHexAddress(ethersAddress: string): string {
    return '41' + strip0x(ethersAddress);
  }

  /**
   * Convert a Tron address (Base58 or 41-hex) to ethers-style 0x address.
   */
  private toEthersAddress(tronAddress: string): string {
    const hex = this.tronWeb.address.toHex(tronAddress);
    // Remove 41 prefix and add 0x
    return ensure0x(hex.slice(2));
  }

  /**
   * Get the current energy price from the network.
   * Returns sun per energy unit.
   */
  private async getEnergyPrice(): Promise<number> {
    try {
      const pricesStr = await this.tronWeb.trx.getEnergyPrices();
      // Format: "timestamp1:price1,timestamp2:price2,..."
      const pairs = pricesStr.split(',');
      const lastPair = pairs[pairs.length - 1];
      const price = parseInt(lastPair.split(':')[1]);
      return isNaN(price) ? 420 : price; // Default to 420 if parsing fails
    } catch {
      return 420; // Default energy price
    }
  }

  /**
   * Estimate the fee limit for a contract deployment.
   * Uses TronWeb's estimateEnergy when possible, with fallback.
   */
  private async estimateDeployFeeLimit(bytecode: string): Promise<number> {
    try {
      // For deployments, we estimate based on bytecode size and CREATE opcode costs
      // Each CREATE opcode costs 32000 energy, plus execution costs
      const bytecodeSize = bytecode.length / 2; // hex string, 2 chars per byte

      // Base energy: CREATE (32000) + memory expansion + execution
      // Rough estimate: 32000 base + 200 per byte of bytecode
      const estimatedEnergy = 32000 + bytecodeSize * 200;

      // Apply buffer
      const energyWithBuffer = Math.ceil(
        estimatedEnergy * ENERGY_BUFFER_MULTIPLIER,
      );

      // Convert energy to sun using current energy price
      const energyPrice = await this.getEnergyPrice();
      const feeLimit = energyWithBuffer * energyPrice;

      // Clamp to min/max limits
      return Math.min(Math.max(feeLimit, MIN_DEPLOY_FEE_LIMIT), MAX_FEE_LIMIT);
    } catch {
      return MIN_DEPLOY_FEE_LIMIT;
    }
  }

  /**
   * Estimate the fee limit for a contract call.
   */
  private async estimateCallFeeLimit(
    toAddress: string,
    data: string,
    callValue: number,
  ): Promise<number> {
    try {
      // Try to estimate energy using TronWeb
      const result = await this.tronWeb.transactionBuilder.estimateEnergy(
        toAddress,
        'fallback()', // Function selector - TronWeb will use the raw data
        {
          callValue,
          feeLimit: MIN_CALL_FEE_LIMIT,
        },
        [], // Parameters - we pass raw data instead
        this.tronAddress,
      );

      if (result.result?.result && result.energy_required) {
        const energyWithBuffer = Math.ceil(
          result.energy_required * ENERGY_BUFFER_MULTIPLIER,
        );
        const energyPrice = await this.getEnergyPrice();
        const feeLimit = energyWithBuffer * energyPrice;
        return Math.min(Math.max(feeLimit, MIN_CALL_FEE_LIMIT), MAX_FEE_LIMIT);
      }
    } catch {
      // Estimation failed, use data-based estimate
    }

    // Fallback: estimate based on data size
    const dataSize = data.length / 2;
    const estimatedEnergy = 21000 + dataSize * 68; // Base + per-byte cost
    const energyWithBuffer = Math.ceil(
      estimatedEnergy * ENERGY_BUFFER_MULTIPLIER,
    );
    const energyPrice = await this.getEnergyPrice();
    const feeLimit = energyWithBuffer * energyPrice;

    return Math.min(Math.max(feeLimit, MIN_CALL_FEE_LIMIT), MAX_FEE_LIMIT);
  }

  /**
   * Override getTransactionCount to return 0 (Tron doesn't use nonces).
   */
  async getTransactionCount(_blockTag?: providers.BlockTag): Promise<number> {
    return 0;
  }

  /**
   * Override sendTransaction to use TronWeb instead of eth_sendRawTransaction.
   *
   * This method:
   * 1. Estimates energy and calculates fee limit dynamically
   * 2. Builds the transaction using TronWeb's transactionBuilder
   * 3. Signs using TronWeb
   * 4. Broadcasts using TronWeb
   * 5. Returns an ethers-compatible TransactionResponse
   */
  async sendTransaction(
    transaction: providers.TransactionRequest,
  ): Promise<providers.TransactionResponse> {
    // Determine if this is a deployment or a call
    const isDeployment = !transaction.to;

    let tronTx: any;
    let contractAddress: string | undefined;
    let feeLimit: number;

    if (isDeployment) {
      // Contract deployment
      assert(
        transaction.data,
        'Deployment transaction must have data (bytecode)',
      );

      const bytecode = strip0x(transaction.data.toString());

      // Convert gasLimit (energy) to feeLimit (sun), or estimate dynamically
      if (transaction.gasLimit) {
        // gasLimit from ethers is in energy units, convert to sun
        const energyLimit = BigNumber.from(transaction.gasLimit).toNumber();
        const energyPrice = await this.getEnergyPrice();
        // Apply buffer since eth_estimateGas may underestimate for CREATE
        const energyWithBuffer = Math.ceil(
          energyLimit * ENERGY_BUFFER_MULTIPLIER,
        );
        const calculatedFee = energyWithBuffer * energyPrice;
        feeLimit = Math.min(
          Math.max(calculatedFee, MIN_DEPLOY_FEE_LIMIT),
          MAX_FEE_LIMIT,
        );
      } else {
        feeLimit = await this.estimateDeployFeeLimit(bytecode);
      }

      tronTx = await this.tronWeb.transactionBuilder.createSmartContract(
        {
          abi: [], // ABI not needed for deployment, bytecode contains constructor
          bytecode,
          feeLimit,
          callValue: transaction.value
            ? BigNumber.from(transaction.value).toNumber()
            : 0,
          parameters: [], // Constructor params are encoded in bytecode
        },
        this.tronAddress,
      );

      // Get the contract address directly from TronWeb's response
      // TronWeb computes this during createSmartContract
      contractAddress = this.toEthersAddress(tronTx.contract_address);
    } else {
      // Contract call or simple transfer
      assert(transaction.to, 'Transaction must have a to address for calls');
      const toAddress = this.toTronHexAddress(transaction.to);
      const callValue = transaction.value
        ? BigNumber.from(transaction.value).toNumber()
        : 0;

      if (transaction.data && transaction.data !== '0x') {
        const data = strip0x(transaction.data.toString());

        // Convert gasLimit (energy) to feeLimit (sun), or estimate dynamically
        if (transaction.gasLimit) {
          // gasLimit from ethers is in energy units, convert to sun
          const energyLimit = BigNumber.from(transaction.gasLimit).toNumber();
          const energyPrice = await this.getEnergyPrice();
          const energyWithBuffer = Math.ceil(
            energyLimit * ENERGY_BUFFER_MULTIPLIER,
          );
          const calculatedFee = energyWithBuffer * energyPrice;
          feeLimit = Math.min(
            Math.max(calculatedFee, MIN_CALL_FEE_LIMIT),
            MAX_FEE_LIMIT,
          );
        } else {
          feeLimit = await this.estimateCallFeeLimit(
            toAddress,
            data,
            callValue,
          );
        }

        // Contract call - use triggerSmartContract with raw data
        tronTx = await this.tronWeb.transactionBuilder.triggerSmartContract(
          toAddress,
          '', // Empty function selector - data contains everything
          {
            feeLimit,
            callValue,
            rawParameter: data, // Pass the full calldata
          },
          [], // Empty parameters - using rawParameter instead
          this.tronAddress,
        );

        // triggerSmartContract returns { result, transaction }
        if (!tronTx.result?.result) {
          throw new Error(
            `TronWeb triggerSmartContract failed: ${tronTx.result?.message || 'Unknown error'}`,
          );
        }
        tronTx = tronTx.transaction;
      } else {
        // Simple TRX transfer
        feeLimit = MIN_CALL_FEE_LIMIT;
        tronTx = await this.tronWeb.transactionBuilder.sendTrx(
          toAddress,
          callValue,
          this.tronAddress,
        );
      }
    }

    // Sign the transaction
    const signedTx = await this.tronWeb.trx.sign(tronTx);

    // Broadcast the transaction
    const result = await this.tronWeb.trx.sendRawTransaction(signedTx);

    if (!result.result) {
      throw new Error(
        `TronWeb broadcast failed: ${result.message || JSON.stringify(result)}`,
      );
    }

    // Get the transaction hash (txID)
    const txHash = ensure0x(tronTx.txID);

    // Create a minimal TransactionResponse
    // The provider's getTransaction/getTransactionReceipt will fill in details
    const response: providers.TransactionResponse = {
      hash: txHash,
      confirmations: 0,
      from: this.address,
      to: transaction.to || undefined,
      nonce: 0,
      gasLimit: BigNumber.from(feeLimit),
      gasPrice: BigNumber.from(await this.provider!.getGasPrice()),
      data: transaction.data?.toString() || '0x',
      value: BigNumber.from(transaction.value || 0),
      chainId: (await this.provider!.getNetwork()).chainId,
      wait: async (confirmations?: number) => {
        // Poll for the transaction receipt using the provider
        const receipt = await this.waitForTransaction(
          txHash,
          contractAddress,
          confirmations,
        );
        return receipt;
      },
    };

    return response;
  }

  /**
   * Wait for a transaction to be confirmed and return the receipt.
   */
  private async waitForTransaction(
    txHash: string,
    contractAddress?: string,
    _confirmations?: number,
  ): Promise<providers.TransactionReceipt> {
    // Poll using the provider's getTransactionReceipt (works on Tron JSON-RPC)
    const maxAttempts = 60; // 2 minutes with 2-second intervals
    const intervalMs = 2000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const receipt = await this.provider!.getTransactionReceipt(txHash);
        if (receipt) {
          // Override contract address if we have it from TronWeb
          // contractAddress is already in EVM format (0x-prefixed)
          if (contractAddress && !receipt.contractAddress) {
            (receipt as any).contractAddress = contractAddress;
          }
          return receipt;
        }
      } catch {
        // Receipt not available yet
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `Transaction ${txHash} not confirmed after ${maxAttempts} attempts`,
    );
  }

  /**
   * Override signTransaction to throw - we handle signing in sendTransaction.
   */
  async signTransaction(
    _transaction: providers.TransactionRequest,
  ): Promise<string> {
    throw new Error(
      'TronWallet does not support signTransaction directly. Use sendTransaction instead.',
    );
  }

  /**
   * Override populateTransaction to skip nonce population.
   */
  async populateTransaction(
    transaction: utils.Deferrable<providers.TransactionRequest>,
  ): Promise<providers.TransactionRequest> {
    const tx = await utils.resolveProperties(transaction);

    // Don't populate nonce (Tron doesn't use them)
    // Don't populate gasPrice if not set (TronWeb handles fees differently)

    if (tx.from == null) {
      tx.from = this.address;
    }

    return tx;
  }
}
