// RetryProvider
//
// Mostly taken from the removed version that was in ethers.js
// See: https://github.com/ethers-io/ethers.js/discussions/3006
import { BaseProvider, JsonRpcProvider } from '@ethersproject/providers';
import { ethers } from 'ethers';

export type RetryOptions = {
  // The wait interval in between
  interval: number;

  // Maximum number of times to rety
  retryLimit: number;
};

type InFunction<T extends any[], U> = (...params: T) => Promise<U>;
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Retries an async function when it raises an exeption
// if all the tries fail it raises the last thrown exeption
export const retryAsync = async <InputArgs extends any[], ReturnType>(
  inFunction: InFunction<InputArgs, ReturnType>,
  tries: number,
  params: InputArgs,
  delay = 100,
): Promise<ReturnType> => {
  let saveError;
  for (let i = 0; i < tries; i++) {
    try {
      // it awaits otherwise it'd always do all the retries
      return await inFunction(...params);
    } catch (error) {
      await sleep(delay);
      saveError = error;
    }
  }

  throw saveError;
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
      async () => this.provider.perform(method, params),
      this.retryOptions.retryLimit,
      [],
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
      [],
      this.retryOptions.interval,
    );
  }
}
