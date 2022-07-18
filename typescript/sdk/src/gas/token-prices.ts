import { chainMetadata } from '../consts/chainMetadata';
import { Mainnets } from '../consts/chains';
import { ChainName } from '../types';

const CoinGecko = require('coingecko-api');

export interface TokenPriceGetter {
  getTokenPrice(chain: ChainName): Promise<number>;
  getTokenExchangeRate(chainA: ChainName, chainB: ChainName): Promise<number>;
}

// TODO: Consider caching to avoid exceeding CoinGecko's 50 requests / min limit

// TODO implement in following PR
export class DefaultTokenPriceGetter implements TokenPriceGetter {
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
    const coinGecko = new CoinGecko();
    // The CoinGecko API expects, in some cases, IDs that do not match
    // ChainNames.
    const ids = chains.map(
      (chain) => chainMetadata[chain].coinGeckoId || chain,
    );
    const response = await coinGecko.simple.price({
      ids,
      vs_currencies: [currency],
    });
    try {
      const prices = ids.map((id) => response.data[id][currency]);
      return prices;
    } catch (e) {
      console.log(e);
      throw new Error(
        `Unable to fetch prices for ${chains}, received ${JSON.stringify(
          response,
        )}`,
      );
    }
  }
}
