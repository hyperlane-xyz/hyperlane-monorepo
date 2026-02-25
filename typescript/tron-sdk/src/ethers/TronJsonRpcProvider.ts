import { BlockTag, FeeData, JsonRpcProvider, Networkish } from 'ethers';

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
  constructor(url: string, network?: Networkish) {
    // Ensure we're pointing to the /jsonrpc endpoint
    const jsonRpcUrl = url.endsWith('/jsonrpc') ? url : `${url}/jsonrpc`;
    super(jsonRpcUrl, network);
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
}
