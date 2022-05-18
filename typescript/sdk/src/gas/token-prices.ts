import { FixedNumber } from 'ethers';

import { NameOrDomain } from '../types';

export interface TokenPriceGetter {
  getNativeTokenUsdPrice(chain: NameOrDomain): Promise<FixedNumber>;
}

// TODO implement in following PR
export class DefaultTokenPriceGetter implements TokenPriceGetter {
  getNativeTokenUsdPrice(_chain: NameOrDomain): Promise<FixedNumber> {
    return Promise.resolve(FixedNumber.from('12.34'));
  }
}
