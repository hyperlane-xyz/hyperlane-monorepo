import { expect } from 'chai';
import { ethers } from 'ethers';
import sinon from 'sinon';

import {
  MultiProtocolProvider,
  Token,
  TokenStandard,
  WarpCore,
} from '@hyperlane-xyz/sdk';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { getXERC20Info } from './balance.js';

const abi = new ethers.utils.Interface([
  'function wrappedToken() view returns (address)',
  'function xERC20() view returns (address)',
  'function mintingCurrentLimitOf(address) view returns (uint256)',
  'function mintingMaxLimitOf(address) view returns (uint256)',
  'function burningCurrentLimitOf(address) view returns (uint256)',
  'function burningMaxLimitOf(address) view returns (uint256)',
]);
const router = `0x${'12'.repeat(20)}`;
const underlying = `0x${'34'.repeat(20)}`;
const updatedUnderlying = `0x${'56'.repeat(20)}`;

function fixture(standard: TokenStandard) {
  const provider = new ethers.providers.StaticJsonRpcProvider(undefined, {
    chainId: 1,
    name: 'test',
  });
  const multiProvider = new MultiProtocolProvider<{ mailbox?: string }>({
    test: {
      name: 'test',
      chainId: 1,
      domainId: 1,
      protocol: standard.startsWith('Tron')
        ? ProtocolType.Tron
        : ProtocolType.Ethereum,
      rpcUrls: [{ http: 'http://localhost:8545' }],
    },
  });
  sinon.stub(multiProvider, 'getEthersV5Provider').returns(provider);
  const token = new Token({
    chainName: 'test',
    standard,
    addressOrDenom: router,
    decimals: 2,
    symbol: 'TOKEN',
    name: 'Token',
  });
  const amounts: Record<string, number> = {
    mintingCurrentLimitOf: 100,
    mintingMaxLimitOf: 200,
    burningCurrentLimitOf: 300,
    burningMaxLimitOf: 400,
  };
  let address = underlying;
  const calls: Array<{
    method: string;
    to: string | undefined;
    bridge?: string;
  }> = [];
  const call = sinon.stub(provider, 'call').callsFake(async (transaction) => {
    const decoded = abi.parseTransaction({
      data: ethers.utils.hexlify((await transaction.data)!),
    });
    const to = await transaction.to;
    calls.push({ method: decoded.name, to, bridge: decoded.args[0] });
    const value =
      decoded.name === 'wrappedToken' || decoded.name === 'xERC20'
        ? address
        : amounts[decoded.name];
    return abi.encodeFunctionResult(decoded.name, [value]);
  });
  return {
    token,
    warpCore: new WarpCore(multiProvider, [token]),
    call,
    calls,
    amounts,
    setAddress: (value: string) => {
      address = value;
    },
  };
}

describe('xERC20 metric acquisition', () => {
  afterEach(() => {
    sinon.restore();
  });

  for (const standard of [
    TokenStandard.EvmHypXERC20,
    TokenStandard.EvmHypVSXERC20,
    TokenStandard.EvmHypXERC20Lockbox,
    TokenStandard.EvmHypVSXERC20Lockbox,
    TokenStandard.TronHypXERC20,
    TokenStandard.TronHypVSXERC20,
    TokenStandard.TronHypXERC20Lockbox,
    TokenStandard.TronHypVSXERC20Lockbox,
  ]) {
    it(`resolves one underlying address and reads all four current limits for ${standard}`, async () => {
      const { warpCore, token, calls } = fixture(standard);
      const result = await getXERC20Info(warpCore, token);
      expect(result).to.deep.equal({
        xERC20Address: underlying,
        limits: { mint: 1, mintMax: 2, burn: 3, burnMax: 4 },
      });
      expect(calls).to.have.length(5);
      expect(
        calls.filter(
          ({ method }) => method === 'wrappedToken' || method === 'xERC20',
        ),
      ).to.have.length(1);
      const limitCalls = calls.filter(({ bridge }) => bridge !== undefined);
      expect(limitCalls).to.have.length(4);
      expect(
        limitCalls.every(
          ({ to, bridge }) =>
            to?.toLowerCase() === underlying &&
            bridge?.toLowerCase() === router,
        ),
      ).to.equal(true);
    });
  }

  it('refreshes the address and every limit on each observation', async () => {
    const { warpCore, token, calls, amounts, setAddress } = fixture(
      TokenStandard.EvmHypXERC20,
    );
    await getXERC20Info(warpCore, token);
    setAddress(updatedUnderlying);
    amounts['mintingCurrentLimitOf'] = 500;
    const result = await getXERC20Info(warpCore, token);
    expect(result.xERC20Address).to.equal(updatedUnderlying);
    expect(result.limits.mint).to.equal(5);
    expect(calls).to.have.length(10);
    expect(
      calls.slice(6).every(({ to }) => to?.toLowerCase() === updatedUnderlying),
    ).to.equal(true);
  });

  it('rejects a failed limit sample without substituting partial or cached values', async () => {
    const { warpCore, token, call } = fixture(TokenStandard.EvmHypXERC20);
    const failure = new Error('limit unavailable');
    call.onCall(2).rejects(failure);
    try {
      await getXERC20Info(warpCore, token);
      expect.fail('Expected limit failure');
    } catch (error) {
      expect(error).to.equal(failure);
    }
    expect((await getXERC20Info(warpCore, token)).limits).to.deep.equal({
      mint: 1,
      mintMax: 2,
      burn: 3,
      burnMax: 4,
    });
    expect(call.callCount).to.equal(10);
  });

  it('propagates read failures and retries fresh on the next observation', async () => {
    const { warpCore, token, call } = fixture(
      TokenStandard.EvmHypXERC20Lockbox,
    );
    const failure = new Error('RPC unavailable');
    call.onCall(0).rejects(failure);
    try {
      await getXERC20Info(warpCore, token);
      expect.fail('Expected read failure');
    } catch (error) {
      expect(error).to.equal(failure);
    }
    expect((await getXERC20Info(warpCore, token)).limits.mint).to.equal(1);
    expect(call.callCount).to.equal(6);
  });
});
