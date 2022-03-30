import { FixedNumber } from "ethers";
import { NameOrDomain } from "../types";

export interface TokenPriceGetter {
  getNativeTokenUsdPrice(domain: NameOrDomain): Promise<FixedNumber>;
}

export class TestTokenPriceGetter implements TokenPriceGetter {
  getNativeTokenUsdPrice(_domain: NameOrDomain): Promise<FixedNumber> {
    return Promise.resolve(
      FixedNumber.from('12.34')
    );
  }
}
