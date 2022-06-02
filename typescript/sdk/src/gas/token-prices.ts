import { FixedNumber } from 'ethers';

import { NameOrDomain } from '../types';

export interface TokenPriceGetter {
  getNativeTokenUsdPrice(chain: NameOrDomain): Promise<FixedNumber>;
}

// TODO implement in following PR
export class DefaultTokenPriceGetter implements TokenPriceGetter {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getNativeTokenUsdPrice(_chain: NameOrDomain): Promise<FixedNumber> {
    return Promise.resolve(FixedNumber.from('12.34'));
  }
}
