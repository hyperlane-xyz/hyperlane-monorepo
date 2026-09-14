import { readFileSync } from 'node:fs';

import { expect } from 'chai';
import { utils } from 'ethers';

import type { BridgeQuote } from '../interfaces/IExternalBridge.js';
import {
  MAYAN_FORWARDER_INTERFACE,
  MAYAN_SWIFT_INTERFACE,
  SWAPS_UTB_INTERFACE,
  validateSwapsEvmPayload,
} from './swapsPayloadValidation.js';

// Unsigned real provider payload, 2026-09-14. No signing or broadcast occurred.
const { request, response } = JSON.parse(
  readFileSync(
    new URL('./fixtures/swaps-mayan-arbitrum-ethereum.json', import.meta.url),
    'utf8',
  ),
);
const quote: BridgeQuote = {
  id: SWAPS_UTB_INTERFACE.parseTransaction(response.tx).args.instructions.txId,
  tool: 'mayan',
  fromAmount: BigInt(response.amountIn.amount),
  toAmount: BigInt(response.amountOut.amount),
  toAmountMin: BigInt(response.amountOutMin.amount),
  executionDuration: 60,
  gasCosts: 0n,
  feeCosts: 0n,
  route: response,
  requestParams: {
    fromChain: request.srcChainId,
    toChain: request.dstChainId,
    fromToken: request.srcToken,
    toToken: request.dstToken,
    fromAddress: request.sender,
    toAddress: request.recipient,
  },
};
const now = 1789397930;
const attacker = '0x1111111111111111111111111111111111111111';
const cloneArgs = (value: utils.Result): any[] =>
  value.map((v) => (Array.isArray(v) ? cloneArgs(v) : v));
function modified(
  change: (outer: any[], forward: any[], order: any[]) => void,
) {
  const outer = cloneArgs(
    SWAPS_UTB_INTERFACE.parseTransaction(response.tx).args,
  );
  const forward = cloneArgs(
    MAYAN_FORWARDER_INTERFACE.parseTransaction({ data: outer[0][5] }).args,
  );
  const order = cloneArgs(
    MAYAN_SWIFT_INTERFACE.parseTransaction({ data: forward[4] }).args,
  );
  change(outer, forward, order);
  forward[4] = MAYAN_SWIFT_INTERFACE.encodeFunctionData(
    'createOrderWithToken',
    order,
  );
  outer[0][5] = MAYAN_FORWARDER_INTERFACE.encodeFunctionData(
    'forwardERC20',
    forward,
  );
  return {
    ...response.tx,
    data: SWAPS_UTB_INTERFACE.encodeFunctionData('swapAndExecute', outer),
  };
}
const validate = (tx = response.tx, decimals = 6) =>
  validateSwapsEvmPayload(quote, tx, async () => decimals, 250, now);

describe('swaps.xyz executable payload validation', () => {
  it('accepts the actual UTB → Mayan Forwarder → Swift order with matching recipient and input', async () => {
    await validate();
  });

  const mutations: [
    string,
    (outer: any[], forward: any[], order: any[]) => void,
  ][] = [
    [
      'unrelated fee asset',
      (outer) => {
        outer[1][5][0][1] = attacker;
      },
    ],
    [
      'excess source fee',
      (outer) => {
        outer[1][5][0][2] = quote.fromAmount;
      },
    ],
    [
      'arbitrary nested target',
      (outer) => {
        outer[0][1] = attacker;
      },
    ],
    [
      'arbitrary payment operator',
      (outer) => {
        outer[0][2] = attacker;
      },
    ],
    [
      'wrong refund',
      (outer) => {
        outer[0][3] = attacker;
      },
    ],
    [
      'arbitrary source swap',
      (outer) => {
        outer[0][0][1][7] = '0x12345678';
      },
    ],
    [
      'unrelated nested token',
      (_outer, forward) => {
        forward[0] = attacker;
      },
    ],
    [
      'forward permit',
      (_outer, forward) => {
        forward[2][0] = 1;
      },
    ],
    [
      'wrong Swift contract',
      (_outer, forward) => {
        forward[3] = attacker;
      },
    ],
    [
      'wrong recipient',
      (_outer, _forward, order) => {
        order[2][2] = utils.hexZeroPad(attacker, 32);
      },
    ],
    [
      'wrong refund trader',
      (_outer, _forward, order) => {
        order[2][1] = utils.hexZeroPad(attacker, 32);
      },
    ],
    [
      'wrong destination chain',
      (_outer, _forward, order) => {
        order[2][3] = 23;
      },
    ],
    [
      'wrong destination token',
      (_outer, _forward, order) => {
        order[2][5] = utils.hexZeroPad(attacker, 32);
      },
    ],
    [
      'insufficient destination amount',
      (_outer, _forward, order) => {
        order[2][6] = quote.toAmountMin - 1n;
      },
    ],
    [
      'arbitrary destination hook',
      (_outer, _forward, order) => {
        order[3] = '0x12345678';
      },
    ],
    [
      'excess refund fee',
      (_outer, _forward, order) => {
        order[2][9] = quote.fromAmount;
      },
    ],
    [
      'expired order',
      (_outer, _forward, order) => {
        order[2][10] = now - 1;
      },
    ],
  ];
  for (const [name, mutation] of mutations) {
    it(`rejects ${name} even when accepted and refreshed API metadata agree`, async () => {
      const error = await validate(modified(mutation)).then(
        () => undefined,
        (error) => error,
      );
      expect(error).to.be.instanceOf(Error);
    });
  }

  it('rejects an arbitrary top-level asset target', async () => {
    const error = await validate({ ...response.tx, to: attacker }).then(
      () => undefined,
      (error) => error,
    );
    expect(error).to.be.instanceOf(Error);
  });
});
