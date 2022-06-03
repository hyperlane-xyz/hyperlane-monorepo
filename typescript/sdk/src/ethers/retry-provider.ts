// RetryProvider
//
// Mostly taken from the removed version that was in ethers.js
// See: https://github.com/ethers-io/ethers.js/discussions/3006
import { BaseProvider, JsonRpcProvider } from '@ethersproject/providers';
import { ethers } from 'ethers';

import { retryAsync } from '@abacus-network/utils/dist/src/utils';

export type RetryOptions = {
  // The wait interval in between
  interval: number;

  // Maximum number of times to rety
  retryLimit: number;
};

export class RetryProvider extends BaseProvider {
  constructor(
    readonly provider: BaseProvider,
    readonly retryOptions: RetryOptions,
  ) {
    super(provider.getNetwork());
    ethers.utils.defineReadOnly(this, 'provider', provider);
    ethers.utils.defineReadOnly(this, 'retryOptions', retryOptions);
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  perform(method: string, params: any): Promise<any> {
    return retryAsync(
      () => this.provider.perform(method, params),
      this.retryOptions.retryLimit,
      this.retryOptions.interval,
    );
  }
}

// Need this separate class for JsonRpcProvider to still expose `getSigner`, so will retry at the request level
export class RetryJsonRpcProvider extends JsonRpcProvider {
  constructor(
    readonly provider: JsonRpcProvider,
    readonly retryOptions: RetryOptions,
  ) {
    super(provider.connection, provider.network);
  }

  async send(method: string, params: Array<any>): Promise<any> {
    return retryAsync(
      async () => this.provider.send(method, params),
      this.retryOptions.retryLimit,
      this.retryOptions.interval,
    );
  }
}
