import { FixedNumber } from 'ethers';

import { NameOrDomain } from '../types';

export interface TokenPriceGetter {
  getNativeTokenUsdPrice(domain: NameOrDomain): Promise<FixedNumber>;
}

// TODO implement in following PR
export class DefaultTokenPriceGetter implements TokenPriceGetter {
  getNativeTokenUsdPrice(_domain: NameOrDomain): Promise<FixedNumber> {
    return Promise.resolve(FixedNumber.from('12.34'));
  }
}
