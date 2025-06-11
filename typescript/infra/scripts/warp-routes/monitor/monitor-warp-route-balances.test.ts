import nock from 'nock';
import { getWarpRouteBalances } from './monitor-warp-route-balances';

describe('getWarpRouteBalances', () => {
  afterEach(() => {
    nock.cleanAll();
    jest.useRealTimers();
  });

  it('should handle zero balance response correctly', async () => {
    const mockResponse = { balances: [{ route: 'route1', balance: 0 }] };
    nock('https://warp.api')
      .get('/balances')
      .reply(200, mockResponse);

    const result = await getWarpRouteBalances();
    expect(result).toContain('route1: 0');
  });

  it('should handle large numeric balances without precision loss', async () => {
    const bigNumber = Number.MAX_SAFE_INTEGER;
    const mockResponse = { balances: [{ route: 'routeBig', balance: bigNumber }] };
    nock('https://warp.api')
      .get('/balances')
      .reply(200, mockResponse);

    const result = await getWarpRouteBalances();
    expect(result).toContain(`routeBig: ${bigNumber}`);
  });

  it('should treat undefined balances as zero', async () => {
    const mockResponse = { balances: [{ route: 'routeUndef' }] };
    nock('https://warp.api')
      .get('/balances')
      .reply(200, mockResponse);

    const result = await getWarpRouteBalances();
    expect(result).toContain('routeUndef: 0');
  });

  it('should throw an error on network failure', async () => {
    nock('https://warp.api')
      .get('/balances')
      .replyWithError('Network error');

    await expect(getWarpRouteBalances()).rejects.toThrow('Network error');
  });

  it('should throw on malformed response structure', async () => {
    const mockResponse = { invalid: true };
    nock('https://warp.api')
      .get('/balances')
      .reply(200, mockResponse);

    await expect(getWarpRouteBalances()).rejects.toThrow(/Invalid response/);
  });

  it('should timeout if request takes too long', async () => {
    nock('https://warp.api')
      .get('/balances')
      .delay(5000)
      .reply(200, { balances: [] });

    jest.useFakeTimers();
    const promise = getWarpRouteBalances();
    jest.advanceTimersByTime(5000);
    await expect(promise).rejects.toThrow(/timeout/);
  });
});