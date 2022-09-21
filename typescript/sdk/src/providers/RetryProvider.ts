// RetryProvider
//
// Mostly taken from the removed version that was in ethers.js
// See: https://github.com/ethers-io/ethers.js/discussions/3006
import { ethers } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

export type RetryOptions = {
  // Maximum number of times to make the RPC
  maxRequests: number;

  // Exponential backoff base value
  baseRetryMs: number;
};

export class RetryProvider extends ethers.providers.BaseProvider {
  constructor(
    readonly provider: ethers.providers.BaseProvider,
    readonly retryOptions: RetryOptions,
  ) {
    super(provider.getNetwork());
    utils.assert(
      retryOptions.maxRequests >= 1,
      'RetryOptions.maxRequests must be >= 1',
    );
    ethers.utils.defineReadOnly(this, 'provider', provider);
    ethers.utils.defineReadOnly(this, 'retryOptions', retryOptions);
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  perform(method: string, params: any): Promise<any> {
    return utils.retryAsync(
      () => this.provider.perform(method, params),
      this.retryOptions.maxRequests,
      this.retryOptions.baseRetryMs,
    );
  }
}

// Need this separate class for JsonRpcProvider to still expose `getSigner`, so will retry at the request level
export class RetryJsonRpcProvider extends ethers.providers.JsonRpcProvider {
  constructor(
    readonly provider: ethers.providers.JsonRpcProvider,
    readonly retryOptions: RetryOptions,
  ) {
    super(provider.connection, provider.network);
    utils.assert(
      retryOptions.maxRequests >= 1,
      'RetryOptions.maxRequests must be >= 1',
    );
  }

  async send(method: string, params: Array<any>): Promise<any> {
    return utils.retryAsync(
      async () => this.provider.send(method, params),
      this.retryOptions.maxRequests,
      this.retryOptions.baseRetryMs,
    );
  }
}
