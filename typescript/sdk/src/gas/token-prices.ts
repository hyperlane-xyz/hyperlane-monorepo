import CoinGecko from 'coingecko-api';

import { chainMetadata } from '../consts/chainMetadata';
import { Mainnets } from '../consts/chains';
import { ChainName } from '../types';

export interface TokenPriceGetter {
  getTokenPrice(chain: ChainName): Promise<number>;
  getTokenExchangeRate(chainA: ChainName, chainB: ChainName): Promise<number>;
}

// Copied from coingecko-api
export interface CoinGeckoSimplePriceParams {
  ids: string | string[];
  vs_currencies: string | string[];
  // tslint:disable-next-line no-redundant-undefined
  include_24hr_vol?: boolean | undefined;
  // tslint:disable-next-line no-redundant-undefined
  include_24hr_change?: boolean | undefined;
  // tslint:disable-next-line no-redundant-undefined
  include_last_updated_at?: boolean | undefined;
  // tslint:disable-next-line no-redundant-undefined
  include_market_cap?: boolean | undefined;
}

// Copied from coingecko-api
export interface CoinGeckoResponse<T = any> {
  success: boolean;
  message: string;
  code: number;
  data: T;
}
export interface CoinGeckoSimpleInterface {
  price: (params: CoinGeckoSimplePriceParams) => Promise<CoinGeckoResponse>;
}
export interface CoinGeckoInterface {
  simple: CoinGeckoSimpleInterface;
}

// TODO: Consider caching to avoid exceeding CoinGecko's 50 requests / min limit
export class CoinGeckoTokenPriceGetter implements TokenPriceGetter {
  protected coinGecko: CoinGeckoInterface;
  constructor(coinGecko: CoinGeckoInterface) {
    this.coinGecko = coinGecko;
  }

  async getTokenPrice(chain: ChainName): Promise<number> {
    if (Mainnets.includes(chain)) {
      const [price] = await this.getTokenPrices([chain]);
      return price;
    } else {
      // Testnet tokens are all artificially priced at 1.0 USD.
      return 1;
    }
  }

  async getTokenExchangeRate(
    chainA: ChainName,
    chainB: ChainName,
  ): Promise<number> {
    const [priceA, priceB] = await this.getTokenPrices([chainA, chainB]);
    return priceB / priceA;
  }

  private async getTokenPrices(chains: ChainName[]): Promise<number[]> {
    const currency = 'usd';
    // The CoinGecko API expects, in some cases, IDs that do not match
    // ChainNames.
    const ids = chains.map(
      (chain) => chainMetadata[chain].coinGeckoId || chain,
    );
    const response = await this.coinGecko.simple.price({
      ids,
      vs_currencies: [currency],
    });
    try {
      const prices = ids.map((id) => response.data[id][currency]);
      return prices;
    } catch (e) {
      throw new Error(
        `Unable to fetch prices for ${chains}, received ${JSON.stringify(
          response,
        )}, got error ${e}`,
      );
    }
  }
}
