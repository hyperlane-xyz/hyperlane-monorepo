import { BigNumber, Wallet, ethers, providers } from 'ethers';
import { keccak256 as ethersKeccak256 } from 'ethers/lib/utils.js';
import { TronWeb, Types } from 'tronweb';

import {
  assert,
  ensure0x,
  isNullish,
  retryAsync,
  sleep,
  strip0x,
} from '@hyperlane-xyz/utils';

import {
  MAX_TRON_ORIGIN_ENERGY_LIMIT,
  TronJsonRpcProvider,
} from './TronJsonRpcProvider.js';
import { TransactionRequest } from '@ethersproject/providers';
import { assertTronReceiptSuccess, toTronHex } from '../utils/index.js';
import { stripCustomRpcHeaders, toHttpApiUrl } from './urlUtils.js';

/**
 * Max time to wait for a broadcast Tron transaction to be mined before failing.
 * Bounds the confirmation poll so a dropped/never-mined tx rejects loudly
 * instead of hanging forever.
 */
const TX_CONFIRMATION_TIMEOUT_MS = 90_000;

/** Interval between confirmation polls while waiting for a receipt. */
const TX_CONFIRMATION_POLL_MS = 1_000;

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
    // `tronUrl` is the chain's HTTP RPC endpoint (root URL or a .../jsonrpc URL).
    // TronWeb needs the Tron HTTP API base host; use the caller-provided host
    // directly (matching the AltVM TronProvider) so a private/custom RPC is
    // honored for building, signing and broadcasting instead of being silently
    // redirected to the public TronGrid endpoint. Custom headers (e.g. API keys)
    // are preserved via `custom_rpc_header`.
    const { headers } = stripCustomRpcHeaders(tronUrl);
    const tronWebUrl = toHttpApiUrl(tronUrl);
    super(privateKey, new TronJsonRpcProvider(tronUrl));
    this.originalTronUrl = tronUrl;

    this.tronWeb = new TronWeb({ fullHost: tronWebUrl, headers });
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
      headers,
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
        txLocal: true,
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
  private confirmationTimeoutMs: number;
  private confirmationPollMs: number;

  constructor(
    tronWebUrl: string,
    tronAddress: string,
    _jsonRpcUrl?: string,
    headers?: Record<string, string>,
    confirmationTimeoutMs: number = TX_CONFIRMATION_TIMEOUT_MS,
    confirmationPollMs: number = TX_CONFIRMATION_POLL_MS,
  ) {
    // Strip custom_rpc_header from the URL and merge with any provided headers
    const { url: cleanTronWebUrl, headers: parsedHeaders } =
      stripCustomRpcHeaders(tronWebUrl);
    const mergedHeaders = { ...parsedHeaders, ...headers };
    super({ fullHost: cleanTronWebUrl, headers: mergedHeaders });

    this.tronAddress = tronAddress;
    this.setAddress(this.tronAddress);
    this.tronAddressHex = this.address.toHex(this.tronAddress);
    this.confirmationTimeoutMs = confirmationTimeoutMs;
    this.confirmationPollMs = confirmationPollMs;
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
      data: isNullish(evmTx.data) ? '0x' : ethers.utils.hexlify(evmTx.data),
      value: BigNumber.from(evmTx.value ?? 0),
      chainId: evmTx.chainId!,
      tronTransaction: tronTx,
      wait: async (confirmations?: number) => {
        const hash = txHash ? ensure0x(txHash) : originalTxHash;
        return this.waitForTransactionReceipt(hash, confirmations, evmTx);
      },
    };
  }

  private async waitForTransactionReceipt(
    txHash: string,
    confirmations = 1,
    evmTx: TransactionRequest,
  ): Promise<providers.TransactionReceipt> {
    const txid = strip0x(txHash);
    const deadline = Date.now() + this.confirmationTimeoutMs;
    while (Date.now() < deadline) {
      const info = await retryAsync(
        () => this.trx.getUnconfirmedTransactionInfo(txid),
        5,
        500,
      );
      if (info?.id && info.blockNumber) {
        assertTronReceiptSuccess(info, this, txid);
        const currentBlock =
          confirmations > 1
            ? await retryAsync(() => this.trx.getCurrentBlock(), 5, 500)
            : undefined;
        const actualConfirmations =
          (currentBlock?.block_header.raw_data.number ?? info.blockNumber) -
          info.blockNumber +
          1;
        if (actualConfirmations >= confirmations) {
          return this.toEthersReceipt(info, actualConfirmations, evmTx);
        }
      }
      await sleep(this.confirmationPollMs);
    }
    throw new Error(
      `Tron transaction ${txid} not confirmed within ${this.confirmationTimeoutMs}ms`,
    );
  }

  private toEthersReceipt(
    info: Types.TransactionInfo,
    confirmations: number,
    evmTx: TransactionRequest,
  ): providers.TransactionReceipt {
    const transactionHash = ensure0x(info.id);
    // Tron transaction info omits blockHash. Avoid another rate-limited RPC;
    // Hyperlane receipt consumers only require logs and blockNumber.
    const blockHash = `0x${'0'.repeat(64)}`;
    const logs = (info.log ?? []).map((log, logIndex) => ({
      blockNumber: info.blockNumber,
      blockHash,
      transactionIndex: 0,
      removed: false,
      address: ethers.utils.getAddress(
        ensure0x(
          log.address.startsWith('41') && log.address.length === 42
            ? log.address.slice(2)
            : log.address,
        ),
      ),
      data: ensure0x(log.data ?? ''),
      topics: (log.topics ?? []).map((topic) => ensure0x(topic)),
      transactionHash,
      logIndex,
    }));
    const gasUsed = BigNumber.from(info.receipt?.energy_usage_total ?? 0);

    const receipt: providers.TransactionReceipt = {
      to: evmTx.to ?? ethers.constants.AddressZero,
      from: ethers.utils.getAddress(
        ensure0x(this.tronAddressHex.slice(2)).toLowerCase(),
      ),
      contractAddress: ethers.constants.AddressZero,
      transactionIndex: 0,
      gasUsed,
      logsBloom: `0x${'0'.repeat(512)}`,
      blockHash,
      transactionHash,
      logs,
      blockNumber: info.blockNumber,
      confirmations,
      cumulativeGasUsed: gasUsed,
      effectiveGasPrice: BigNumber.from(0),
      byzantium: true,
      type: 0,
      status: 1,
    };
    return receipt;
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
        bytecode: strip0x(ethers.utils.hexlify(tx.data)),
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
    assert(tx.to, 'Contract call transaction must have a destination');
    assert(tx.data, 'Contract call transaction must have data');
    const tronHexTo = toTronHex(this, tx.to);
    const result = await this.transactionBuilder.triggerSmartContract(
      tronHexTo,
      '',
      {
        feeLimit,
        callValue,
        input: strip0x(ethers.utils.hexlify(tx.data)),
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
    const tronHexTo = toTronHex(this, to);
    return this.transactionBuilder.sendTrx(
      tronHexTo,
      callValue,
      this.tronAddress,
    );
  }
}
