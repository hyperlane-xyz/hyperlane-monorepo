import { providers } from 'ethers';

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
export class TronJsonRpcProvider extends providers.JsonRpcProvider {
  public host: string;
  constructor(url: string, network?: providers.Networkish) {
    // Ensure we're pointing to the /jsonrpc endpoint
    const jsonRpcUrl = url.endsWith('/jsonrpc') ? url : `${url}/jsonrpc`;
    super(jsonRpcUrl, network);
    this.host = jsonRpcUrl;
  }

  /**
   * Tron doesn't use nonces - always return 0.
   */
  async getTransactionCount(
    _addressOrName: string,
    _blockTag?: providers.BlockTag,
  ): Promise<number> {
    return 0;
  }

  /**
   * Tron doesn't support ENS - return the name as-is.
   */
  async resolveName(name: string): Promise<string> {
    return name;
  }

  /**
   * Return legacy gas pricing only - Tron doesn't support EIP-1559.
   */
  async getFeeData(): Promise<providers.FeeData> {
    const gasPrice = await this.getGasPrice();
    return {
      gasPrice,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      lastBaseFeePerGas: null,
    };
  }
}
