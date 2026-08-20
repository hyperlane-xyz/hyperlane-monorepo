import { expect } from 'chai';

import {
  filterBlockedRpcUrls,
  isRpcUrlBlocked,
} from '../src/config/rpcBlocklist.js';

describe('rpcBlocklist', () => {
  it('blocks configured hosts regardless of scheme, path, or trailing slash', () => {
    expect(isRpcUrlBlocked('arbitrum', 'https://arbitrum.drpc.org')).to.equal(
      true,
    );
    expect(
      isRpcUrlBlocked('arbitrum', 'https://arb1.arbitrum.io/rpc'),
    ).to.equal(true);
    expect(isRpcUrlBlocked('arbitrum', 'https://arbitrum.drpc.org/')).to.equal(
      true,
    );
  });

  it('does not block healthy providers on the same chain', () => {
    expect(
      isRpcUrlBlocked('arbitrum', 'https://arbitrum.gateway.tenderly.co'),
    ).to.equal(false);
    expect(
      isRpcUrlBlocked('arbitrum', 'https://arbitrum-one-rpc.publicnode.com'),
    ).to.equal(false);
  });

  it('only blocks on the chain the host is listed under', () => {
    expect(isRpcUrlBlocked('ethereum', 'https://arbitrum.drpc.org')).to.equal(
      false,
    );
  });

  it('filters blocked hosts out of a url list', () => {
    const urls = [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum.drpc.org',
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.gateway.tenderly.co',
    ];
    expect(filterBlockedRpcUrls('arbitrum', urls)).to.deep.equal([
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.gateway.tenderly.co',
    ]);
  });

  it('leaves lists untouched for chains with no blocklist', () => {
    const urls = ['https://rpc.ankr.com/eth', 'https://cloudflare-eth.com'];
    expect(filterBlockedRpcUrls('ethereum', urls)).to.deep.equal(urls);
  });
});
