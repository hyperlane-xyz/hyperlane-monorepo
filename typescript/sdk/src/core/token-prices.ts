import { FixedNumber } from "ethers";

export interface TokenPriceGetter {
  getTokenUsdPrice(): Promise<FixedNumber>;
}