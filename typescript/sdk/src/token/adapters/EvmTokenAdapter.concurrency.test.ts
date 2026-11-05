import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import {
  ERC20__factory,
  HypXERC20Lockbox__factory,
  IXERC20__factory,
} from '@hyperlane-xyz/core';

import { test1 } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import {
  EvmHypXERC20LockboxAdapter,
  EvmXERC20Adapter,
} from './EvmTokenAdapter.js';

const TOKEN = '0x1111111111111111111111111111111111111111';
const WRAPPED_TOKEN = '0x2222222222222222222222222222222222222222';
const LOCKBOX = '0x3333333333333333333333333333333333333333';
const BRIDGE = '0x4444444444444444444444444444444444444444';

// Keep ethers contract calldata/return decoding intact; gate provider calls to
// verify actual RPC admission, result ordering, and failure draining.
describe('EVM token adapter concurrent reads', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProtocolProvider;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProtocolProvider.createTestMultiProtocolProvider();
  });

  afterEach(() => sandbox.restore());

  for (const failFirst of [false, true]) {
    it(`overlaps limit reads and ${failFirst ? 'drains the sibling after failure' : 'keeps mint/burn result order'}`, async () => {
      const adapter = new EvmXERC20Adapter(test1.name, multiProvider, {
        token: TOKEN,
      });
      const iface = IXERC20__factory.createInterface();
      const mint = sinon.promise<BigNumber>();
      const burn = sinon.promise<BigNumber>();
      const mintStarted = sinon.promise<void>();
      const burnStarted = sinon.promise<void>();
      let active = 0;
      let peak = 0;
      const calls = sandbox
        .stub(adapter.getProvider(), 'call')
        .callsFake(async (tx) => {
          if (typeof tx.data !== 'string') throw new Error('Missing calldata');
          const { name, args } = iface.parseTransaction({ data: tx.data });
          expect(args[0]).to.equal(BRIDGE);
          active++;
          peak = Math.max(peak, active);
          try {
            if (name === 'mintingMaxLimitOf') {
              void mintStarted.resolve(undefined);
              return iface.encodeFunctionResult(name, [await mint]);
            }
            if (name === 'burningMaxLimitOf') {
              void burnStarted.resolve(undefined);
              return iface.encodeFunctionResult(name, [await burn]);
            }
            throw new Error(`Unexpected call ${name}`);
          } finally {
            active--;
          }
        });
      let settled = false;
      const result = adapter.getLimits(BRIDGE).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await Promise.all([mintStarted, burnStarted]);
      expect(peak).to.equal(2);
      const error = new Error('mint RPC failed');
      if (failFirst) void mint.reject(error);
      else void burn.resolve(BigNumber.from(20));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).to.equal(false);
      if (failFirst) void burn.resolve(BigNumber.from(20));
      else void mint.resolve(BigNumber.from(10));
      if (failFirst) expect(await result).to.equal(error);
      else expect(await result).to.deep.equal({ mint: 10n, burn: 20n });
      expect(active).to.equal(0);
      expect(calls.callCount).to.equal(2);
    });
  }

  it('overlaps lockbox address reads before reading the pinned balance', async () => {
    const adapter = new EvmHypXERC20LockboxAdapter(test1.name, multiProvider, {
      token: TOKEN,
    });
    const iface = HypXERC20Lockbox__factory.createInterface();
    const erc20 = ERC20__factory.createInterface();
    const lockbox = sinon.promise<string>();
    const wrapped = sinon.promise<string>();
    const lockboxStarted = sinon.promise<void>();
    const wrappedStarted = sinon.promise<void>();
    const calls = sandbox
      .stub(adapter.getProvider(), 'call')
      .callsFake(async (tx, blockTag) => {
        if (typeof tx.data !== 'string') throw new Error('Missing calldata');
        if (tx.data.startsWith(erc20.getSighash('balanceOf'))) {
          const { args } = erc20.parseTransaction({ data: tx.data });
          expect(args[0]).to.equal(LOCKBOX);
          expect(tx.to).to.equal(WRAPPED_TOKEN);
          expect(await blockTag).to.equal(123);
          return erc20.encodeFunctionResult('balanceOf', [42]);
        }
        const { name } = iface.parseTransaction({ data: tx.data });
        if (name === 'lockbox') {
          void lockboxStarted.resolve(undefined);
          return iface.encodeFunctionResult(name, [await lockbox]);
        }
        if (name === 'wrappedToken') {
          void wrappedStarted.resolve(undefined);
          return iface.encodeFunctionResult(name, [await wrapped]);
        }
        throw new Error(`Unexpected call ${name}`);
      });
    const result = adapter.getBridgedSupply({ blockTag: 123 });
    await Promise.all([lockboxStarted, wrappedStarted]);
    expect(calls.callCount).to.equal(2);
    void wrapped.resolve(WRAPPED_TOKEN);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls.callCount).to.equal(2);
    void lockbox.resolve(LOCKBOX);
    expect(await result).to.equal(42n);
    expect(calls.callCount).to.equal(3);
  });
});
