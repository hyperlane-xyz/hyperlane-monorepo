import {
  AddressLike,
  BlockTag,
  FeeData,
  JsonRpcProvider,
  Networkish,
} from 'ethers';
import { TronWeb } from 'tronweb';

/**
 * TronJsonRpcProvider extends ethers JsonRpcProvider for Tron's JSON-RPC API.
 *
 * Tron's JSON-RPC endpoint supports most standard Ethereum JSON-RPC methods,
 * but with a few notable exceptions:
 * - eth_sendRawTransaction: Not supported (must use TronWeb for transactions)
 * - eth_getTransactionCount: Not supported (Tron doesn't use nonces)
 *
 * This provider handles these gaps by returning appropriate defaults.
 */
export class TronJsonRpcProvider extends JsonRpcProvider {
  private readonly tronWeb: TronWeb;

  constructor(url: string, network?: Networkish) {
    // Ensure we're pointing to the /jsonrpc endpoint
    const fullHost = url.endsWith('/jsonrpc') ? url.slice(0, -8) : url;
    const jsonRpcUrl = `${fullHost}/jsonrpc`;
    super(jsonRpcUrl, network);
    this.tronWeb = new TronWeb({ fullHost });
  }

  /**
   * Tron doesn't use nonces - always return 0.
   */
  async getTransactionCount(
    _addressOrName: string,
    _blockTag?: BlockTag,
  ): Promise<number> {
    return 0;
  }

  override async getBalance(
    address: AddressLike,
    blockTag?: BlockTag,
  ): Promise<bigint> {
    // TronWeb only supports latest balance lookups.
    if (blockTag && blockTag !== 'latest') {
      return super.getBalance(address, blockTag);
    }

    if (typeof address !== 'string') {
      return super.getBalance(address, blockTag);
    }

    const base58Address = this.toBase58Address(address);
    const balance = await this.tronWeb.trx.getBalance(base58Address);
    return BigInt(balance);
  }

  /**
   * Return legacy gas pricing only - Tron doesn't support EIP-1559.
   */
  async getFeeData(): Promise<FeeData> {
    // Avoid ethers v6 block formatting in super.getFeeData(), which can reject
    // Tron JSON-RPC blocks (e.g. empty stateRoot = "0x").
    const gasPriceHex = await this.send('eth_gasPrice', []);
    const gasPrice = typeof gasPriceHex === 'string' ? BigInt(gasPriceHex) : 0n;
    return new FeeData(gasPrice, null, null);
  }

  private toBase58Address(address: string): string {
    if (address.startsWith('T')) return address;
    if (address.startsWith('41')) return this.tronWeb.address.fromHex(address);
    if (address.startsWith('0x')) {
      return this.tronWeb.address.fromHex(`41${address.slice(2)}`);
    }
    return this.tronWeb.address.fromHex(address);
  }
}
