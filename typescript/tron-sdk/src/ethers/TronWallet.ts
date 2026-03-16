import { BigNumber, Wallet, ethers, providers } from 'ethers';
import { keccak256 as ethersKeccak256 } from 'ethers/lib/utils.js';
import { TronWeb, Types } from 'tronweb';

import { assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

import {
  MAX_TRON_ORIGIN_ENERGY_LIMIT,
  TronJsonRpcProvider,
} from './TronJsonRpcProvider.js';
import { TransactionRequest } from '@ethersproject/providers';

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

  private readonly originalTronUrl: string;
  private tronWeb: TronWeb;
  private tronAddress: string;
  private tronAddressHex: string;
  private txBuilder: TronTransactionBuilder;

  constructor(privateKey: string, tronUrl: string) {
    // Derive base URL (for TronWeb HTTP API) and JSON-RPC URL (for ethers provider).
    // TronGrid/TRE serve JSON-RPC at {base}/jsonrpc; third-party providers serve it at root.
    const isTronNode =
      /^https?:\/\/(localhost|127\.0\.0\.1|[^/]*trongrid)/.test(tronUrl);
    const baseUrl = tronUrl.endsWith('/jsonrpc')
      ? tronUrl.slice(0, -8)
      : tronUrl;
    const jsonRpcUrl = tronUrl.endsWith('/jsonrpc')
      ? tronUrl
      : isTronNode
        ? `${tronUrl}/jsonrpc`
        : tronUrl;
    // TronWeb needs a full node HTTP API. Third-party JSON-RPC providers
    // don't serve it, so fall back to public TronGrid.
    const tronWebUrl = isTronNode ? baseUrl : 'https://api.trongrid.io';
    super(privateKey, new TronJsonRpcProvider(jsonRpcUrl));
    this.originalTronUrl = tronUrl;

    this.tronWeb = new TronWeb({ fullHost: tronWebUrl });
    const cleanKey = strip0x(privateKey);
    this.tronWeb.setPrivateKey(cleanKey);

    const derivedAddress = this.tronWeb.address.fromPrivateKey(cleanKey);
    assert(derivedAddress, 'Failed to derive Tron address from private key');
    this.tronAddress = derivedAddress;
    this.tronAddressHex = this.tronWeb.address.toHex(this.tronAddress);
    this.tronWeb.setAddress(this.tronAddress);

    this.txBuilder = new TronTransactionBuilder(
      tronWebUrl,
      this.tronAddress,
      tronUrl,
    );
  }

  /**
   * Override connect to preserve TronWallet type.
   * Base Wallet.connect() returns a plain Wallet, losing Tron behavior.
   */
  connect(_provider: providers.Provider): TronWallet {
    return new TronWallet(this.privateKey, this.originalTronUrl);
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

    let tronTx = await this.txBuilder.buildTransaction(tx);
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

    return this.txBuilder.getTransactionResponse(tx, tronTx);
  }

  private async makeUnique(tronTx: TronTransaction): Promise<TronTransaction> {
    const counter = ++TronWallet.txCounter;
    // Use data (memo field) instead of extension to avoid TronWeb's
    // time-based validation which fails when node clock drifts.
    const data = '0x' + counter.toString(16).padStart(8, '0');
    const altered = await this.tronWeb.transactionBuilder.alterTransaction(
      tronTx as Types.Transaction,
      {
        data,
        dataFormat: 'hex',
      },
    );

    // For deployments, recompute contract_address from the new txID.
    // genContractAddress = '41' + keccak256(txID + ownerHex)[24:]
    if ('contract_address' in tronTx) {
      const hash = ethersKeccak256(
        Buffer.from(altered.txID + this.tronAddressHex, 'hex'),
      );
      (altered as any).contract_address = '41' + hash.substring(2).slice(24);
    }

    return altered as TronTransaction;
  }
}

export class TronTransactionBuilder extends TronWeb {
  private tronAddress: string;
  private tronAddressHex: string;
  private provider: TronJsonRpcProvider;

  constructor(tronWebUrl: string, tronAddress: string, jsonRpcUrl?: string) {
    super({ fullHost: tronWebUrl });

    this.tronAddress = tronAddress;
    this.setAddress(this.tronAddress);
    // Use provided JSON-RPC URL, or derive from TronWeb URL
    const rpcUrl =
      jsonRpcUrl ??
      (tronWebUrl.endsWith('/jsonrpc') ? tronWebUrl : `${tronWebUrl}/jsonrpc`);
    this.provider = new TronJsonRpcProvider(rpcUrl);
    this.tronAddressHex = this.address.toHex(this.tronAddress);
  }

  getTransactionResponse(
    evmTx: TransactionRequest,
    tronTx: TronTransaction,
    txHash?: string,
  ): TronTransactionResponse {
    const originalTxHash = ensure0x(tronTx.txID);
    const gasPrice = evmTx.gasPrice
      ? BigNumber.from(evmTx.gasPrice)
      : BigNumber.from(0);
    const gasLimit = evmTx.gasLimit
      ? BigNumber.from(evmTx.gasLimit)
      : BigNumber.from(0);

    return {
      hash: txHash ?? originalTxHash,
      confirmations: 0,
      from: ethers.utils.getAddress(
        ensure0x(this.tronAddressHex.slice(2)).toLowerCase(),
      ),
      to: evmTx.to ?? undefined,
      nonce: 0,
      gasLimit,
      gasPrice,
      data: evmTx.data?.toString() ?? '0x',
      value: BigNumber.from(evmTx.value ?? 0),
      chainId: evmTx.chainId!,
      tronTransaction: tronTx,
      wait: (confirmations?: number) =>
        this.provider!.waitForTransaction(
          txHash ? ensure0x(txHash) : originalTxHash,
          confirmations,
        ),
    };
  }

  async buildTransaction(
    tx: providers.TransactionRequest,
  ): Promise<TronTransaction> {
    const gasPrice = tx.gasPrice
      ? BigNumber.from(tx.gasPrice)
      : BigNumber.from(0);
    const gasLimit = tx.gasLimit
      ? BigNumber.from(tx.gasLimit)
      : BigNumber.from(0);
    let feeLimit = gasLimit.mul(gasPrice).toNumber() * 1.5;
    feeLimit = Math.min(feeLimit, 1000000000);
    feeLimit = feeLimit <= 0 ? 1000000000 : feeLimit;
    const callValue = tx.value ? BigNumber.from(tx.value).toNumber() : 0;

    if (!tx.to) {
      return this.buildDeployment(tx, feeLimit, callValue, gasLimit);
    } else if (tx.data && tx.data !== '0x') {
      return this.buildContractCall(tx, feeLimit, callValue);
    } else {
      return this.buildTransfer(tx.to, callValue);
    }
  }

  private async buildDeployment(
    tx: providers.TransactionRequest,
    feeLimit: number,
    callValue: number,
    gasLimit: BigNumber,
  ): Promise<TronTransaction> {
    assert(tx.data, 'Deployment transaction must have data');
    return this.transactionBuilder.createSmartContract(
      {
        abi: [],
        bytecode: strip0x(tx.data.toString()),
        feeLimit,
        callValue,
        originEnergyLimit: Math.min(
          gasLimit.toNumber(),
          MAX_TRON_ORIGIN_ENERGY_LIMIT,
        ),
      },
      this.tronAddress,
    );
  }

  private async buildContractCall(
    tx: providers.TransactionRequest,
    feeLimit: number,
    callValue: number,
  ): Promise<TronTransaction> {
    const tronHexTo = '41' + strip0x(tx.to!).toLowerCase();
    const result = await this.transactionBuilder.triggerSmartContract(
      tronHexTo,
      '',
      {
        feeLimit,
        callValue,
        input: strip0x(tx.data!.toString()),
      },
      [],
      this.tronAddress,
    );
    assert(
      result.result?.result,
      `triggerSmartContract failed: ${result.result?.message}`,
    );
    return result.transaction;
  }

  private async buildTransfer(
    to: string,
    callValue: number,
  ): Promise<TronTransaction> {
    const tronHexTo = '41' + strip0x(to).toLowerCase();
    return this.transactionBuilder.sendTrx(
      tronHexTo,
      callValue,
      this.tronAddress,
    );
  }
}
