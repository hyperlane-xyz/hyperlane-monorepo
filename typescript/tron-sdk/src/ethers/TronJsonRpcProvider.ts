import { providers } from 'ethers';

/**
 * TronJsonRpcProvider extends ethers JsonRpcProvider for Tron's JSON-RPC API.
 *
 * Tron's JSON-RPC endpoint supports most standard Ethereum JSON-RPC methods,
 * but with a few notable exceptions:
 * - eth_sendRawTransaction: Not supported (must use TronWeb for transactions)
 * - eth_getTransactionCount: Not supported (Tron doesn't use nonces)
 * - eth_feeHistory: Not supported (no EIP-1559)
 *
 * This provider handles these gaps by returning appropriate defaults.
 */
export class TronJsonRpcProvider extends providers.JsonRpcProvider {
  constructor(url: string, network?: providers.Networkish) {
    // Ensure we're pointing to the /jsonrpc endpoint
    const jsonRpcUrl = url.endsWith('/jsonrpc') ? url : `${url}/jsonrpc`;
    super(jsonRpcUrl, network);
  }

  /**
   * Override perform to handle Tron-specific JSON-RPC differences.
   */
  async perform(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // Tron doesn't have nonces - return 0
    if (method === 'getTransactionCount') {
      return 0;
    }

    // Tron doesn't support EIP-1559 fee history
    if (method === 'getFeeHistory') {
      return null;
    }

    return super.perform(method, params);
  }

  /**
   * Override getFeeData to return legacy gas pricing only.
   * Tron uses energy pricing, but eth_gasPrice returns a usable value.
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
