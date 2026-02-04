import { TronWeb } from 'tronweb';

import { assert } from '@hyperlane-xyz/utils';

/**
 * TronProvider wraps TronWeb for direct Tron API access.
 *
 * This is a utility class for Tron-specific operations that don't go through
 * the Ethereum JSON-RPC interface. For most operations, use TronJsonRpcProvider
 * and TronWallet instead.
 *
 * Use cases for this provider:
 * - Getting energy/bandwidth prices
 * - Tron-specific account information
 * - Direct TronWeb API access when needed
 */
export class TronProvider {
  public readonly tronWeb: TronWeb;
  protected rpcUrls: string[];
  protected chainId: number;

  constructor(rpcUrl: string | string[], chainId: number) {
    this.rpcUrls = Array.isArray(rpcUrl) ? rpcUrl : [rpcUrl];
    this.chainId = chainId;

    assert(this.rpcUrls.length > 0, 'At least one RPC URL required');

    // TronWeb requires fullHost or individual endpoints
    // Remove /jsonrpc suffix if present
    const fullHost = this.rpcUrls[0].replace(/\/jsonrpc$/, '');
    this.tronWeb = new TronWeb({ fullHost });
  }

  /**
   * Create a TronProvider from RPC URLs and chain ID.
   */
  static connect(rpcUrl: string | string[], chainId: number): TronProvider {
    return new TronProvider(rpcUrl, chainId);
  }

  /**
   * Check if the provider is connected and healthy.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.tronWeb.trx.getBlock('latest');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the configured RPC URLs.
   */
  getRpcUrls(): string[] {
    return this.rpcUrls;
  }

  /**
   * Get the current block height.
   */
  async getBlockHeight(): Promise<number> {
    const block = await this.tronWeb.trx.getCurrentBlock();
    return block.block_header.raw_data.number;
  }

  /**
   * Get the balance of an address in sun (1 TRX = 1,000,000 sun).
   */
  async getBalance(address: string): Promise<bigint> {
    const balance = await this.tronWeb.trx.getBalance(address);
    return BigInt(balance);
  }

  /**
   * Get current energy price from the network.
   * Energy price is returned as a comma-separated string of "timestamp:price" pairs.
   * Returns the latest (last) price in sun per energy unit.
   */
  async getEnergyPrice(): Promise<number> {
    const pricesStr = await this.tronWeb.trx.getEnergyPrices();
    // Format: "timestamp1:price1,timestamp2:price2,..."
    const pairs = pricesStr.split(',');
    const lastPair = pairs[pairs.length - 1];
    const price = parseInt(lastPair.split(':')[1]);
    assert(!isNaN(price), 'Failed to parse energy price from network');
    return price;
  }

  /**
   * Get current bandwidth price from the network.
   */
  async getBandwidthPrice(): Promise<number> {
    const pricesStr = await this.tronWeb.trx.getBandwidthPrices();
    const pairs = pricesStr.split(',');
    const lastPair = pairs[pairs.length - 1];
    const price = parseInt(lastPair.split(':')[1]);
    assert(!isNaN(price), 'Failed to parse bandwidth price from network');
    return price;
  }

  /**
   * Estimate energy for a contract call.
   */
  async estimateEnergy(
    contractAddress: string,
    functionSelector: string,
    parameters: { type: string; value: unknown }[] = [],
    options: { callValue?: number; feeLimit?: number } = {},
  ): Promise<number> {
    const result = await this.tronWeb.transactionBuilder.estimateEnergy(
      contractAddress,
      functionSelector,
      options,
      parameters,
    );

    if (!result.result?.result) {
      throw new Error(
        `Energy estimation failed: ${(result.result as any)?.message || 'Unknown error'}`,
      );
    }

    return result.energy_required;
  }

  /**
   * Call a contract view function (read-only, no transaction).
   */
  async callContractView(
    contractAddress: string,
    functionSelector: string,
    parameters: { type: string; value: unknown }[] = [],
  ): Promise<unknown> {
    const result =
      await this.tronWeb.transactionBuilder.triggerConstantContract(
        contractAddress,
        functionSelector,
        {},
        parameters,
      );

    if (!result.result?.result) {
      throw new Error(
        `Contract view call failed: ${result.result?.message || 'Unknown error'}`,
      );
    }

    return result.constant_result?.[0];
  }

  /**
   * Convert a Base58Check address to hex format.
   */
  addressToHex(address: string): string {
    return this.tronWeb.address.toHex(address);
  }

  /**
   * Convert a hex address to Base58Check format.
   */
  addressFromHex(hexAddress: string): string {
    return this.tronWeb.address.fromHex(hexAddress);
  }
}
