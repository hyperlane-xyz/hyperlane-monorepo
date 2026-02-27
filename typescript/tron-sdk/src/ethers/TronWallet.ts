import {
  BlockTag,
  Provider,
  TransactionRequest,
  TransactionResponse,
  Wallet,
  getAddress,
  hexlify,
  keccak256,
  toBigInt,
} from 'ethers';
import { TronWeb, Types } from 'tronweb';

import { assert, ensure0x, pollAsync, strip0x } from '@hyperlane-xyz/utils';

import { TronJsonRpcProvider } from './TronJsonRpcProvider.js';

/** Union of possible TronWeb transaction types */
export type TronTransaction =
  | Types.CreateSmartContractTransaction
  | Types.Transaction
  | Types.SignedTransaction;

const TRON_TX_COUNTER_KEY = '__hyperlane_tron_tx_counter__';

function nextTronTxExtension(): number {
  const globalState = globalThis as typeof globalThis & {
    [TRON_TX_COUNTER_KEY]?: number;
  };
  const next = (globalState[TRON_TX_COUNTER_KEY] ?? 0) + 1;
  globalState[TRON_TX_COUNTER_KEY] = next;
  return next;
}

function decodeTronErrorMessage(message: unknown): string | undefined {
  if (typeof message !== 'string' || message.length === 0) return undefined;
  const raw = message.startsWith('0x') ? message.slice(2) : message;
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) {
    return message;
  }
  try {
    return Buffer.from(raw, 'hex').toString('utf8');
  } catch {
    return message;
  }
}

function isContractAddressCollision(message: string | undefined): boolean {
  return (
    !!message &&
    message.includes(
      'Trying to create a contract with existing contract address',
    )
  );
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
  private readonly tronUrl: string;
  private tronWeb: TronWeb;
  private tronAddress: string;
  private tronAddressHex: string;
  private readonly tronTransactions = new Map<string, TronTransaction>();

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
  override connect(_provider: Provider | null): Wallet {
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
    return getAddress(rawAddress);
  }

  /** Tron doesn't use nonces */
  async getTransactionCount(_blockTag?: BlockTag): Promise<number> {
    return 0;
  }

  getTronTransaction(hash: string): TronTransaction | undefined {
    return this.tronTransactions.get(hash.toLowerCase());
  }

  override async sendTransaction(
    transaction: TransactionRequest,
  ): Promise<TransactionResponse> {
    // Populate transaction (estimates gas and gas price if not set)
    const tx = await this.populateTransaction(transaction);
    const provider = this.provider;
    assert(provider, 'TronWallet provider is not configured');
    const normalizedData = tx.data ? hexlify(tx.data) : '0x';
    const hasNoCalldata = normalizedData === '0x' || normalizedData === '0x00';
    const isSimpleTransfer = !!tx.to && hasNoCalldata;
    const rawGasLimit =
      tx.gasLimit ??
      (isSimpleTransfer
        ? 21_000n
        : await provider.estimateGas(tx as TransactionRequest));
    const gasLimit =
      isSimpleTransfer && toBigInt(rawGasLimit || 0n) === 0n
        ? 21_000n
        : rawGasLimit;
    const feeData = tx.gasPrice ? null : await provider.getFeeData();
    const gasPrice = tx.gasPrice ?? feeData?.gasPrice;
    assert(gasLimit, 'gasLimit is required');
    assert(gasPrice, 'gasPrice is required');

    // Convert gasLimit to feeLimit in SUN (1 TRX = 1,000,000 SUN)
    const gasPriceBigInt = toBigInt(gasPrice);
    const gasLimitBigInt = toBigInt(gasLimit);
    let feeLimit = (gasLimitBigInt * gasPriceBigInt * 15n) / 10n; // Add 50% buffer to avoid "Out of energy"
    feeLimit = feeLimit > 1_000_000_000n ? 1_000_000_000n : feeLimit; // Tron max fee is 1000 TRX
    feeLimit = feeLimit <= 0n ? 1_000_000_000n : feeLimit;
    const rawValue = tx.value ?? transaction.value ?? 0n;
    const callValue = toSafeNumber(toBigInt(rawValue), 'value');
    const feeLimitNumber = toSafeNumber(feeLimit, 'feeLimit');
    const gasLimitNumber = toSafeNumber(gasLimitBigInt, 'gasLimit');

    let tronTx: TronTransaction;

    if (!tx.to) {
      // Contract deployment
      assert(tx.data, 'Deployment transaction must have data');
      tronTx = await this.tronWeb.transactionBuilder.createSmartContract(
        {
          abi: [],
          bytecode: strip0x(hexlify(tx.data)),
          feeLimit: feeLimitNumber,
          callValue,
          originEnergyLimit: gasLimitNumber,
        },
        this.tronAddress,
      );
    } else if (tx.data && tx.data !== '0x') {
      // Contract call - use 'input' option for raw ABI-encoded calldata
      assert(typeof tx.to === 'string', 'Transaction target must be a string');
      const tronHexTo = this.toTronHex(tx.to);
      const result = await this.tronWeb.transactionBuilder.triggerSmartContract(
        tronHexTo,
        '', // Empty functionSelector since we pass raw encoded data via input
        {
          feeLimit: feeLimitNumber,
          callValue,
          input: strip0x(hexlify(tx.data)),
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
      assert(typeof tx.to === 'string', 'Transfer target must be a string');
      const recipient = this.tronWeb.address.fromHex(this.toTronHex(tx.to));
      tronTx = await this.tronWeb.transactionBuilder.sendTrx(
        recipient,
        callValue,
        this.tronAddress,
      );
    }

    // Ensure unique txID by extending expiration with a counter.
    // Tron has no nonces, so identical txs in the same block produce the same txID.
    tronTx = await this.makeUnique(tronTx);

    // Sign and broadcast. Retry contract deployments when another process
    // races and generates the same contract address on the shared local node.
    for (let attempt = 0; ; attempt += 1) {
      // tronWeb.trx.sign mutates the transaction object by appending
      // signatures, so sign a clone to keep tronTx reusable across retries.
      const signedTx = await this.tronWeb.trx.sign(
        structuredClone(tronTx as Types.Transaction),
      );
      const broadcastResult =
        await this.tronWeb.trx.sendRawTransaction(signedTx);

      if (broadcastResult.result) break;

      const decodedMessage = decodeTronErrorMessage(broadcastResult.message);
      if (attempt < 5 && isContractAddressCollision(decodedMessage)) {
        tronTx = await this.makeUnique(tronTx);
        continue;
      }

      assert(broadcastResult.result, `Broadcast failed: ${decodedMessage}`);
    }

    const txHash = ensure0x(tronTx.txID);
    this.tronTransactions.set(txHash.toLowerCase(), tronTx);

    return pollAsync(
      async () => {
        const response = await provider.getTransaction(txHash);
        assert(response, `Transaction ${txHash} not available yet`);
        return response;
      },
      100,
      100,
    );
  }

  private async makeUnique(tronTx: TronTransaction): Promise<TronTransaction> {
    // Use a process-global counter so uniqueness survives duplicated module
    // instances in bundled test/runtime environments.
    const extension = nextTronTxExtension();
    const altered = await this.tronWeb.transactionBuilder.alterTransaction(
      tronTx as Types.Transaction,
      {
        extension,
      },
    );

    // For deployments, recompute contract_address from the new txID.
    // genContractAddress = '41' + keccak256(txID + ownerHex)[24:]
    if ('contract_address' in tronTx) {
      const hash = keccak256(ensure0x(altered.txID + this.tronAddressHex));
      (altered as any).contract_address = '41' + hash.substring(2).slice(24);
    }

    return altered as TronTransaction;
  }
}

function toSafeNumber(value: bigint, field: string): number {
  assert(value >= 0n, `${field} must be non-negative`);
  assert(
    value <= BigInt(Number.MAX_SAFE_INTEGER),
    `${field} exceeds Number.MAX_SAFE_INTEGER`,
  );
  return Number(value);
}
