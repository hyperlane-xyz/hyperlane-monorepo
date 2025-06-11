import { BigNumber } from 'ethers';
import axios from 'axios';
import { fetchTokenPrices, getTokenPrice } from './token-prices';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

afterEach(() => {
  jest.clearAllMocks();
});

describe('fetchTokenPrices', () => {
  it('returns a map of token symbols to USD prices on success', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        ethereum: { usd: 2000 },
        dai: { usd: 1 },
      },
    });
    const symbols = ['ethereum', 'dai'];
    const prices = await fetchTokenPrices(symbols);
    expect(prices).toEqual({ ethereum: 2000, dai: 1 });
  });

  it('returns an empty object when API call fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('network error'));
    const prices = await fetchTokenPrices(['ethereum']);
    expect(prices).toEqual({});
  });

  it('returns an empty object when given an empty symbol array', async () => {
    const prices = await fetchTokenPrices([]);
    expect(prices).toEqual({});
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});

describe('getTokenPrice', () => {
  const numericMap = { eth: 2000, dai: 1 };

  it('returns the correct numeric price for a known symbol', () => {
    expect(getTokenPrice('eth', numericMap)).toBe(2000);
  });

  it('returns 0 for an unknown symbol', () => {
    expect(getTokenPrice('btc', numericMap)).toBe(0);
  });

  it('handles BigNumber values in the price map', () => {
    const bnMap = { usdc: BigNumber.from('1000000') };
    const result = getTokenPrice('usdc', bnMap);
    const asString = BigNumber.isBigNumber(result) ? result.toString() : result;
    expect(asString).toBe('1000000');
  });

  it('returns 0 when price map is undefined', () => {
    // @ts-ignore Testing undefined input
    expect(getTokenPrice('eth', undefined)).toBe(0);
  });
});