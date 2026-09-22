import { expect } from 'chai';
import { providers, utils } from 'ethers';
import sinon from 'sinon';

import {
  DLN_FORWARDER,
  DLN_FORWARDER_INTERFACE,
  DLN_FORWARDER_IMPLEMENTATION,
  ZERO_EX_ALLOWANCE_INTERFACE,
  ZERO_EX_ACTION_INTERFACE,
  ZERO_EX_BSC_SETTLER,
  validateDeBridgeForwarderDeployment,
} from './deBridgeForwarderValidation.js';
import {
  DLN_SOURCE_INTERFACE,
  validateDeBridgeEvmTransaction,
} from './deBridgeValidation.js';
import {
  fixture,
  fixtureQuote,
  changeCall,
  changeSwap,
  withSignerSurplus,
  supportedForwarderData,
} from './fixtures/deBridgeForwarder.js';

const ATTACKER = '0x0000000000000000000000000000000000001234';

describe('deBridge strictlySwapAndCall validation', () => {
  const valid = () => supportedForwarderData();
  beforeEach(() => {
    sinon
      .stub(providers.StaticJsonRpcProvider.prototype, 'getStorageAt')
      .resolves(utils.hexZeroPad(DLN_FORWARDER_IMPLEMENTATION, 32));
  });
  afterEach(() => sinon.restore());
  const check = (data: string) =>
    validateDeBridgeEvmTransaction(fixtureQuote(), DLN_FORWARDER, data);
  const outer = (data: string, index: number, value: unknown) =>
    changeCall(DLN_FORWARDER_INTERFACE, data, (args) => {
      const next = [...args];
      next[index] = value;
      return next;
    });
  const action = (
    data: string,
    index: number,
    change: (args: utils.Result) => readonly unknown[],
  ) =>
    changeSwap(data, (args) => {
      const next = [...args];
      const actions = [...args.actions];
      actions[index] = changeCall(
        ZERO_EX_ACTION_INTERFACE,
        actions[index],
        change,
      );
      next[1] = actions;
      return next;
    });

  it('validates the unmodified provider quote, including both surplus recipients and the restricted taker', () => {
    expect(() => check(valid())).not.to.throw();
  });

  it('rejects an upgraded forwarder before querying the swap registry', async () => {
    const provider = new providers.StaticJsonRpcProvider(
      'http://localhost:1',
      56,
    );
    const storage = provider.getStorageAt as sinon.SinonStub;
    storage.resolves(utils.hexZeroPad(ATTACKER, 32));
    const call = sinon.stub(provider, 'call');
    let error: unknown;
    try {
      await validateDeBridgeForwarderDeployment(provider, valid());
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.include(
      'Unsupported deBridge forwarder implementation',
    );
    expect(call.called).to.equal(false);
  });

  it('accepts a different outer surplus recipient without weakening order funding', () => {
    expect(() => check(outer(valid(), 7, ATTACKER))).not.to.throw();
  });

  it('also accepts signer surplus without requiring the order to be unrestricted', () => {
    expect(() => check(withSignerSurplus())).not.to.throw();
  });

  for (const previous of [false, true]) {
    it(`accepts the pinned Settler as the ${previous ? 'previous' : 'current'} registry deployment`, async () => {
      const provider = new providers.StaticJsonRpcProvider(
        'http://localhost:1',
        56,
      );
      const call = sinon.stub(provider, 'call');
      call
        .onFirstCall()
        .resolves(
          utils.defaultAbiCoder.encode(
            ['address'],
            [previous ? ATTACKER : ZERO_EX_BSC_SETTLER],
          ),
        );
      call
        .onSecondCall()
        .resolves(
          utils.defaultAbiCoder.encode(['address'], [ZERO_EX_BSC_SETTLER]),
        );
      sinon
        .stub(provider, 'getBlock')
        .resolves({ timestamp: 0 } as providers.Block);
      await validateDeBridgeForwarderDeployment(provider, valid());
      expect(call.callCount).to.equal(previous ? 2 : 1);
    });
  }

  for (const failure of ['paused', 'retired', 'timeout']) {
    it(`rejects a ${failure} registry before execution`, async () => {
      const provider = new providers.StaticJsonRpcProvider(
        'http://localhost:1',
        56,
      );
      const call = sinon.stub(provider, 'call');
      if (failure === 'timeout') call.rejects(new Error('RPC timeout'));
      else
        call.resolves(
          utils.defaultAbiCoder.encode(
            ['address'],
            [
              failure === 'paused'
                ? utils.getAddress(`0x${'0'.repeat(40)}`)
                : ATTACKER,
            ],
          ),
        );
      let error: unknown;
      try {
        await validateDeBridgeForwarderDeployment(provider, valid());
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(failure);
      expect(call.callCount).to.equal(failure === 'retired' ? 2 : 1);
    });
  }

  it('rejects expired funding and fails closed when the latest block cannot be read', async () => {
    const provider = new providers.StaticJsonRpcProvider(
      'http://localhost:1',
      56,
    );
    sinon
      .stub(provider, 'call')
      .resolves(
        utils.defaultAbiCoder.encode(['address'], [ZERO_EX_BSC_SETTLER]),
      );
    const block = sinon.stub(provider, 'getBlock');
    block
      .onFirstCall()
      .resolves({ timestamp: 2_000_000_000 } as providers.Block);
    block.onSecondCall().rejects(new Error('block RPC timeout'));
    for (const message of ['deadline has expired', 'block RPC timeout']) {
      let error: unknown;
      try {
        await validateDeBridgeForwarderDeployment(provider, valid());
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(message);
    }
  });

  for (const [name, index, value] of [
    ['unrelated source asset', 0, ATTACKER],
    ['oversized source debit', 1, BigInt(fixture.fromAmount) + 1n],
    ['source permit', 2, '0x1234'],
    ['arbitrary swap router', 3, ATTACKER],
    ['wrong intermediate token', 5, ATTACKER],
    ['empty intermediate order', 6, 0],
    ['arbitrary nested target', 8, ATTACKER],
  ] as const) {
    it(`rejects ${name}`, () =>
      expect(() => check(outer(valid(), index, value))).to.throw());
  }

  it('rejects a wrapper on another source chain', () => {
    const quote = fixtureQuote();
    quote.requestParams.fromChain = 1;
    expect(() =>
      validateDeBridgeEvmTransaction(quote, DLN_FORWARDER, valid()),
    ).to.throw('source chain');
  });

  for (const [field, value] of [
    ['giveTokenAddress', ATTACKER],
    ['giveAmount', 1],
    ['takeTokenAddress', ATTACKER],
    ['takeAmount', 1],
    ['takeChainId', 42161],
    ['receiverDst', ATTACKER],
    ['givePatchAuthoritySrc', ATTACKER],
    ['orderAuthorityAddressDst', ATTACKER],
    ['allowedCancelBeneficiarySrc', ATTACKER],
    ['allowedTakerDst', '0x1234'],
    ['externalCall', '0x1234'],
  ] as const) {
    it(`rejects nested order ${field} mismatch`, () => {
      const data = changeCall(DLN_FORWARDER_INTERFACE, valid(), (args) => {
        const next = [...args];
        next[9] = changeCall(
          DLN_SOURCE_INTERFACE,
          args.targetData,
          (orderArgs) => {
            const result = [...orderArgs];
            result[0] = { ...orderArgs.order, [field]: value };
            return result;
          },
        );
        return next;
      });
      expect(() => check(data)).to.throw();
    });
  }

  for (const index of [0, 1, 2, 3]) {
    it(`rejects mismatched 0x allowance field ${index}`, () => {
      const data = changeCall(DLN_FORWARDER_INTERFACE, valid(), (args) => {
        const next = [...args];
        next[4] = changeCall(
          ZERO_EX_ALLOWANCE_INTERFACE,
          args.swapData,
          (allowance) => {
            const result = [...allowance];
            result[index] = index === 2 ? 1 : ATTACKER;
            return result;
          },
        );
        return next;
      });
      expect(() => check(data)).to.throw();
    });
  }

  for (const [name, change] of [
    [
      'attacker swap output',
      (s: utils.Result) => ({ ...s, recipient: ATTACKER }),
    ],
    ['wrong swap token', (s: utils.Result) => ({ ...s, buyToken: ATTACKER })],
    ['empty swap output', (s: utils.Result) => ({ ...s, minAmountOut: 0 })],
  ] as const) {
    it(`rejects ${name}`, () => {
      expect(() =>
        check(
          changeSwap(valid(), (args) => {
            const next = [...args];
            next[0] = change(args.slippage);
            return next;
          }),
        ),
      ).to.throw();
    });
  }

  it('rejects an arbitrary token transfer disguised as a swap action', () => {
    const erc20 = new utils.Interface(['function transfer(address,uint256)']);
    expect(() =>
      check(
        changeSwap(valid(), (args) => {
          const next = [...args];
          const actions = [...args.actions];
          actions[1] = erc20.encodeFunctionData('transfer', [ATTACKER, 1]);
          next[1] = actions;
          return next;
        }),
      ),
    ).to.throw();
  });

  it('rejects funding unrelated assets and signed permits', () => {
    for (const signed of [false, true]) {
      expect(() =>
        check(
          action(valid(), 0, (args) => {
            const next = [...args];
            if (signed) next[2] = '0x1234';
            else
              next[1] = {
                ...args.permit,
                permitted: { token: ATTACKER, amount: 1 },
              };
            return next;
          }),
        ),
      ).to.throw();
    }
  });

  it('rejects pool hooks and hidden trailing hops', () => {
    for (const trailing of [false, true]) {
      expect(() =>
        check(
          action(valid(), 1, (args) => {
            const next = [...args];
            const fills = utils.arrayify(args.fills);
            if (trailing) next[6] = utils.hexlify(utils.concat([fills, fills]));
            else {
              fills[44] = 1;
              next[6] = utils.hexlify(fills);
            }
            return next;
          }),
        ),
      ).to.throw();
    }
  });

  it('rejects redirects and over-allocation inside pool swaps', () => {
    for (const [index, value] of [
      [0, ATTACKER],
      [1, ATTACKER],
      [2, 1_000_001],
      [3, true],
      [4, 1],
    ] as const) {
      expect(() =>
        check(
          action(valid(), 1, (args) => {
            const next = [...args];
            next[index] = value;
            return next;
          }),
        ),
      ).to.throw();
    }
  });

  it('accepts a provider-selected inner surplus recipient', () => {
    expect(() =>
      check(
        action(valid(), 3, (args) => {
          const next = [...args];
          next[0] = ATTACKER;
          return next;
        }),
      ),
    ).not.to.throw();
  });

  it('rejects surplus transfers that can consume committed order funding or unrelated tokens', () => {
    const committed = DLN_FORWARDER_INTERFACE.parseTransaction({
      data: valid(),
    }).args.srcAmountOut;
    for (const [index, value] of [
      [1, ATTACKER],
      [2, committed.sub(1)],
      [3, 1_000_001],
    ] as const) {
      expect(() =>
        check(
          action(valid(), 3, (args) => {
            const next = [...args];
            next[index] = value;
            return next;
          }),
        ),
      ).to.throw('surplus');
    }
  });

  it('allows the validated destination authority to choose a cancellation beneficiary', () => {
    const data = changeCall(DLN_FORWARDER_INTERFACE, valid(), (args) => {
      const next = [...args];
      next[9] = changeCall(DLN_SOURCE_INTERFACE, args.targetData, (order) => {
        const inner = [...order];
        inner[0] = { ...order.order, allowedCancelBeneficiarySrc: '0x' };
        return inner;
      });
      return next;
    });
    expect(() => check(data)).not.to.throw();
  });

  it('rejects non-canonical wrapper, nested order and inner swap calldata', () => {
    expect(() => check(`${valid()}00`)).to.throw('canonical');
    for (const index of [4, 9]) {
      const decoded = DLN_FORWARDER_INTERFACE.parseTransaction({
        data: valid(),
      });
      expect(() =>
        check(outer(valid(), index, `${decoded.args[index]}00`)),
      ).to.throw('canonical');
    }
  });
});
