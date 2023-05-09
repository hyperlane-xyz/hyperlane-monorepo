// RetryProvider Mostly taken from the removed version that was in ethers.js
// See: https://github.com/ethers-io/ethers.js/discussions/3006
import { ethers } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

export type RetryProviderOptions = {
  // Maximum number of times to make the RPC
  maxRequests: number;

  // Exponential backoff base value
  baseRetryMs: number;
};

export class RetryJsonRpcProvider extends ethers.providers
  .StaticJsonRpcProvider {
  public readonly retryOptions: RetryProviderOptions;
  constructor(
    retryOptions: RetryProviderOptions,
    url?: ethers.utils.ConnectionInfo | string,
    network?: ethers.providers.Networkish,
  ) {
    super(url, network);
    utils.assert(
      retryOptions.maxRequests >= 1,
      'RetryOptions.maxRequests must be >= 1',
    );
    utils.assert(
      retryOptions.baseRetryMs >= 1,
      'RetryOptions.baseRetryMs must be >= 1',
    );
    this.retryOptions = retryOptions;
  }

  async send(method: string, params: Array<any>): Promise<any> {
    return utils.retryAsync(
      () => super.send(method, params),
      this.retryOptions.maxRequests,
      this.retryOptions.baseRetryMs,
    );
  }
}
