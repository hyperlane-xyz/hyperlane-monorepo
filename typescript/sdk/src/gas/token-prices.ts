import CoinGecko from 'coingecko-api';

import { chainMetadata } from '../consts/chainMetadata';
import { Mainnets } from '../consts/chains';
import { ChainName } from '../types';

export interface TokenPriceGetter {
  getTokenPrice(chain: ChainName): Promise<number>;
  getTokenExchangeRate(base: ChainName, quote: ChainName): Promise<number>;
}

export type CoinGeckoInterface = Pick<CoinGecko, 'simple'>;
export type CoinGeckoSimpleInterface = CoinGecko['simple'];
export type CoinGeckoSimplePriceParams = Parameters<
  CoinGeckoSimpleInterface['price']
>[0];
export type CoinGeckoResponse = ReturnType<CoinGeckoSimpleInterface['price']>;

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
    base: ChainName,
    quote: ChainName,
  ): Promise<number> {
    const [basePrice, quotePrice] = await this.getTokenPrices([base, quote]);
    return basePrice / quotePrice;
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
