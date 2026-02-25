import { BigNumber, Wallet, ethers, providers } from 'ethers';
import { keccak256 as ethersKeccak256 } from 'ethers/lib/utils.js';
import { TronWeb, Types } from 'tronweb';

import { assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

import { TronJsonRpcProvider } from './TronJsonRpcProvider.js';

/** Union of possible TronWeb transaction types */
export type TronTransaction =
  | Types.CreateSmartContractTransaction
  | Types.Transaction
  | Types.SignedTransaction;

/**
 * Extended transaction response that includes Tron-specific fields.
 */
export interface TronTransactionResponse extends providers.TransactionResponse {
  /** Raw TronWeb transaction object */
  tronTransaction: TronTransaction;
}

/**
 * TronWallet extends ethers Wallet to handle Tron's transaction format.
 *
 * Takes a single Tron node URL (e.g. http://localhost:9090) and derives:
 * - JSON-RPC provider at {url}/jsonrpc for ethers compatibility
 * - TronWeb HTTP client at {url} for transaction building/signing
 *
 * Tron's JSON-RPC doesn't support eth_sendRawTransaction, so we override
 * sendTransaction to use TronWeb for building, signing, and broadcasting.
 *
 * Gas estimation is handled by ethers (via eth_estimateGas), and we convert
 * gasLimit to Tron's feeLimit using: feeLimit = gasLimit × gasPrice.
 */
export class TronWallet extends Wallet {
  /**
   * Static counter to ensure unique txIDs across all wallet instances.
   * Must be static because connect() creates new instances, and Tron txIDs
   * are derived from transaction content + expiration. Without a shared counter,
   * two instances could generate identical txIDs in the same block.
   */
  private static txCounter = 0;

  private readonly tronUrl: string;
  private tronWeb: TronWeb;
  private tronAddress: string;
  private tronAddressHex: string;

  constructor(privateKey: string, tronUrl: string) {
    super(privateKey, new TronJsonRpcProvider(tronUrl));
    this.tronUrl = tronUrl;

    this.tronWeb = new TronWeb({ fullHost: tronUrl });
    const cleanKey = strip0x(privateKey);
    this.tronWeb.setPrivateKey(cleanKey);

    const derivedAddress = this.tronWeb.address.fromPrivateKey(cleanKey);
    assert(derivedAddress, 'Failed to derive Tron address from private key');
    this.tronAddress = derivedAddress;
    this.tronAddressHex = this.tronWeb.address.toHex(this.tronAddress);
    this.tronWeb.setAddress(this.tronAddress);
  }

  /**
   * Override connect to preserve TronWallet type.
   * Base Wallet.connect() returns a plain Wallet, losing Tron behavior.
   */
  connect(_provider: providers.Provider): TronWallet {
    return new TronWallet(this.privateKey, this.tronUrl);
  }

  /** Convert ethers 0x address to Tron 41-prefixed hex */
  private toTronHex(address: string): string {
    return '41' + strip0x(address).toLowerCase();
  }

  /** Convert Tron address (base58 or 41-hex) to ethers 0x address */
  toEvmAddress(tronAddress: string): string {
    const hex = this.tronWeb.address.toHex(tronAddress);
    const rawAddress = ensure0x(hex.slice(2)).toLowerCase();
    return ethers.utils.getAddress(rawAddress);
  }

  /** Tron doesn't use nonces */
  async getTransactionCount(_blockTag?: providers.BlockTag): Promise<number> {
    return 0;
  }

  async sendTransaction(
    transaction: providers.TransactionRequest,
  ): Promise<TronTransactionResponse> {
    // Populate transaction (estimates gas and gas price if not set)
    const tx = await this.populateTransaction(transaction);
    assert(tx.gasLimit, 'gasLimit is required');
    assert(tx.gasPrice, 'gasPrice is required');

    // Convert gasLimit to feeLimit in SUN (1 TRX = 1,000,000 SUN)
    const gasPrice = BigNumber.from(tx.gasPrice);
    const gasLimit = BigNumber.from(tx.gasLimit);
    let feeLimit = gasLimit.mul(gasPrice).toNumber() * 1.5; // Add 50% buffer to feeLimit to avoid "Out of energy" errors
    feeLimit = Math.min(feeLimit, 1000000000); // Tron max fee is 1000000000 SUN (1000 TRX)
    feeLimit = feeLimit <= 0 ? 1000000000 : feeLimit; // Ensure we have at least some fee limit
    const callValue = tx.value ? BigNumber.from(tx.value).toNumber() : 0;

    let tronTx: TronTransaction;

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
    } else if (tx.data && tx.data !== '0x') {
      // Contract call - use 'input' option for raw ABI-encoded calldata
      const tronHexTo = this.toTronHex(tx.to);
      const result = await this.tronWeb.transactionBuilder.triggerSmartContract(
        tronHexTo,
        '', // Empty functionSelector since we pass raw encoded data via input
        {
          feeLimit,
          callValue,
          input: strip0x(tx.data.toString()),
        },
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

    // Ensure unique txID by extending expiration with a counter.
    // Tron has no nonces, so identical txs in the same block produce the same txID.
    tronTx = await this.makeUnique(tronTx);

    // Sign and broadcast
    const signedTx = await this.tronWeb.trx.sign(tronTx);
    const broadcastResult = await this.tronWeb.trx.sendRawTransaction(signedTx);
    assert(
      broadcastResult.result,
      `Broadcast failed: ${broadcastResult.message}`,
    );

    const txHash = ensure0x(tronTx.txID);

    // Build the transaction response with Tron-specific fields
    const response: TronTransactionResponse = {
      hash: txHash,
      confirmations: 0,
      from: this.address,
      to: tx.to ?? undefined,
      nonce: 0,
      gasLimit,
      gasPrice,
      data: tx.data?.toString() ?? '0x',
      value: BigNumber.from(tx.value ?? 0),
      chainId: tx.chainId!,
      tronTransaction: tronTx,
      wait: (confirmations?: number) =>
        this.provider!.waitForTransaction(txHash, confirmations),
    };

    return response;
  }

  private async makeUnique(tronTx: TronTransaction): Promise<TronTransaction> {
    const extension = ++TronWallet.txCounter;
    const altered = await this.tronWeb.transactionBuilder.alterTransaction(
      tronTx as Types.Transaction,
      {
        extension,
      },
    );

    // For deployments, recompute contract_address from the new txID.
    // genContractAddress = '41' + keccak256(txID + ownerHex)[24:]
    if ('contract_address' in tronTx) {
      const hash = ethersKeccak256(
        Buffer.from(altered.txID + this.tronAddressHex, 'hex'),
      );
      const alteredWithContractAddress = altered as TronTransaction & {
        contract_address?: string;
      };
      alteredWithContractAddress.contract_address =
        '41' + hash.substring(2).slice(24);
    }

    return altered as TronTransaction;
  }
}
