import { expect } from 'chai';
import { ethers } from 'ethers';
import sinon from 'sinon';

import {
  AEVO_OUTSTANDING_SELECTOR,
  MultiProtocolProvider,
  Token,
  TokenStandard,
  WarpCore,
} from '@hyperlane-xyz/sdk';

import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { getXERC20Info } from './balance.js';

const abi = new ethers.utils.Interface([
  'function wrappedToken() view returns (address)',
  'function xERC20() view returns (address)',
  'function mintingCurrentLimitOf(address) view returns (uint256)',
  'function mintingMaxLimitOf(address) view returns (uint256)',
  'function burningCurrentLimitOf(address) view returns (uint256)',
  'function burningMaxLimitOf(address) view returns (uint256)',
  'function authorities(address) view returns (bool)',
  'function caps(address) view returns (uint256)',
]);
// The latest block of the chain, which an Aevo token is read at.
const HEAD = 100;
const latestBlock: ethers.providers.Block = {
  number: HEAD,
  hash: ethers.utils.hexZeroPad(ethers.utils.hexlify(HEAD), 32),
  parentHash: ethers.utils.hexZeroPad(ethers.utils.hexlify(HEAD - 1), 32),
  timestamp: HEAD,
  nonce: '0x0000000000000000',
  difficulty: 0,
  _difficulty: ethers.BigNumber.from(0),
  gasLimit: ethers.BigNumber.from(0),
  gasUsed: ethers.BigNumber.from(0),
  miner: ethers.constants.AddressZero,
  extraData: '0x',
  transactions: [],
};
const router = `0x${'12'.repeat(20)}`;
const underlying = `0x${'34'.repeat(20)}`;
const updatedUnderlying = `0x${'56'.repeat(20)}`;

function fixture(
  standard: TokenStandard,
  // What the token answers each read of the cap with, in order, where it is
  // not the same every time, as it is while its cap is being lowered.
  capReads: number[] = [],
) {
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
    authorities: 1,
    caps: 500,
  };
  let address = underlying;
  const outstanding = 120;
  const calls: Array<{
    method: string;
    to: string | undefined;
    bridge?: string;
    blockTag: unknown;
  }> = [];
  const getBlock = sinon.stub(provider, 'getBlock').resolves(latestBlock);
  const call = sinon
    .stub(provider, 'call')
    .callsFake(async (transaction, blockTag) => {
      const raw = await transaction.data;
      assert(raw, 'Expected call data');
      const data = ethers.utils.hexlify(raw);
      const to = await transaction.to;
      if (data.startsWith(AEVO_OUTSTANDING_SELECTOR)) {
        calls.push({
          method: 'outstanding',
          to,
          bridge: `0x${data.slice(-40)}`,
          blockTag,
        });
        return ethers.utils.hexZeroPad(ethers.utils.hexlify(outstanding), 32);
      }
      const decoded = abi.parseTransaction({ data });
      calls.push({
        method: decoded.name,
        to,
        bridge: decoded.args[0],
        blockTag,
      });
      const value =
        decoded.name === 'wrappedToken' || decoded.name === 'xERC20'
          ? address
          : decoded.name === 'caps'
            ? (capReads.shift() ?? amounts[decoded.name])
            : amounts[decoded.name];
      return abi.encodeFunctionResult(decoded.name, [value]);
    });
  return {
    token,
    warpCore: new WarpCore(multiProvider, [token]),
    call,
    getBlock,
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

  // An Aevo token has no limit getters: its limits are what its adapter maps
  // what the token holds to. The router is authorized with a cap of 500, and has
  // minted 120 of it, in the 2 decimals of the token.
  it('observes the limits of an Aevo token as its adapter states them', async () => {
    const { warpCore, token, calls } = fixture(TokenStandard.EvmHypAevoXERC20);

    expect(await getXERC20Info(warpCore, token)).to.deep.equal({
      xERC20Address: underlying,
      limits: { mint: 3.8, mintMax: 5, burn: 1.2, burnMax: 5 },
    });
    expect(
      calls
        .filter(({ method }) => method !== 'wrappedToken')
        .every(
          ({ to, bridge }) =>
            to?.toLowerCase() === underlying &&
            bridge?.toLowerCase() === router,
        ),
    ).to.equal(true);
  });

  // What the token holds is read once, at one block: the address of the token,
  // the authority, the cap and what the router has minted, each once.
  it('reads what an Aevo token holds once, at one block, for all four limits', async () => {
    const { warpCore, token, calls, getBlock } = fixture(
      TokenStandard.EvmHypAevoXERC20,
    );

    await getXERC20Info(warpCore, token);

    expect(getBlock.callCount).to.equal(1);
    expect(calls.map(({ method }) => method)).to.have.members([
      'wrappedToken',
      'authorities',
      'caps',
      'outstanding',
    ]);
    const limitCalls = calls.filter(({ method }) => method !== 'wrappedToken');
    expect(limitCalls.map(({ blockTag }) => blockTag)).to.deep.equal([
      HEAD,
      HEAD,
      HEAD,
    ]);
  });

  // The cap of the router is lowered while its limits are read: read apart,
  // its mint limit would be what is left of the cap it had, above the maximum
  // it has by the time that is read.
  it('does not report a mint limit above the maximum when the cap is lowered while it is read', async () => {
    const { warpCore, token } = fixture(
      TokenStandard.EvmHypAevoXERC20,
      [500, 100],
    );

    const { limits } = await getXERC20Info(warpCore, token);

    expect(limits).to.deep.equal({
      mint: 3.8,
      mintMax: 5,
      burn: 1.2,
      burnMax: 5,
    });
  });

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
