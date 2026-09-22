import { createHash } from 'node:crypto';

import { expect } from 'chai';
import { utils } from 'ethers';

import {
  type DlnOrder,
  dlnOrderId,
  dlnSolanaEvents,
  solanaCreatedOrder,
} from './deBridgeSettlement.js';
import { DLN_SOLANA_SOURCE } from './deBridgeValidation.js';
import fixture from './fixtures/debridge-order.json' with { type: 'json' };

const order: DlnOrder = {
  ...fixture.order,
  makerOrderNonce: BigInt(fixture.order.makerOrderNonce),
  giveChainId: BigInt(fixture.order.giveChainId),
  giveAmount: BigInt(fixture.order.giveAmount),
  takeChainId: BigInt(fixture.order.takeChainId),
  takeAmount: BigInt(fixture.order.takeAmount),
};

const program = DLN_SOLANA_SOURCE.toBase58();
const event = (name: string, data: Uint8Array) =>
  `Program data: ${Buffer.concat([createHash('sha256').update(`event:${name}`).digest().subarray(0, 8), data]).toString('base64')}`;
const u64 = (value: bigint) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
};
const uint256 = (value: bigint) =>
  Buffer.from(utils.arrayify(utils.hexZeroPad(utils.hexlify(value), 32)));
const vector = (hex: string) => {
  const value = Buffer.from(utils.arrayify(hex));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(value.length);
  return Buffer.concat([length, value]);
};
const optional = (hex: string) =>
  hex === '0x'
    ? Buffer.from([0])
    : Buffer.concat([Buffer.from([1]), vector(hex)]);

// Borsh fixture follows the pinned DLN IDL, including its fee suffix.
const serialized = Buffer.concat([
  u64(order.makerOrderNonce),
  vector(order.makerSrc),
  uint256(order.giveChainId),
  vector(order.giveTokenAddress),
  uint256(order.giveAmount),
  uint256(order.takeChainId),
  vector(order.takeTokenAddress),
  uint256(order.takeAmount),
  vector(order.receiverDst),
  vector(order.givePatchAuthoritySrc),
  vector(order.orderAuthorityAddressDst),
  optional(order.allowedTakerDst),
  optional(order.allowedCancelBeneficiarySrc),
  Buffer.from([0]),
  u64(10n),
  u64(20n),
]);
const createdLogs = (data = serialized, id = fixture.orderId) => [
  `Program ${program} invoke [1]`,
  event('CreatedOrder', data),
  event('CreatedOrderId', utils.arrayify(id)),
  `Program ${program} success`,
];

describe('DLN settlement identity', () => {
  it('reproduces the ID in the captured unmodified deBridge API response', () => {
    expect(dlnOrderId(order)).to.equal(fixture.orderId);
  });

  it('binds route, amount, recipient and authorities into the order ID', () => {
    for (const mutation of [
      { takeAmount: order.takeAmount - 1n },
      { takeChainId: order.takeChainId + 1n },
      { receiverDst: order.giveTokenAddress },
      { givePatchAuthoritySrc: order.giveTokenAddress },
      { orderAuthorityAddressDst: order.giveTokenAddress },
      { allowedTakerDst: '0x' },
    ])
      expect(dlnOrderId({ ...order, ...mutation })).not.to.equal(
        fixture.orderId,
      );
  });

  it('decodes the Solana event representation into the same committed order', () => {
    expect(
      solanaCreatedOrder(createdLogs(), program, fixture.orderId),
    ).to.deep.equal(order);
  });

  it('rejects truncated events, changed fields and mismatched source IDs', () => {
    const changed = Buffer.from(serialized);
    changed[0] ^= 1;
    for (const logs of [
      createdLogs(serialized.subarray(0, -1)),
      createdLogs(changed),
      createdLogs(serialized, utils.id('another order')),
    ])
      expect(() =>
        solanaCreatedOrder(logs, program, fixture.orderId),
      ).to.throw();
  });

  it('does not accept forged events emitted by an unrelated nested program', () => {
    const foreign = '11111111111111111111111111111111';
    const logs = [
      `Program ${program} invoke [1]`,
      `Program ${foreign} invoke [2]`,
      event('CreatedOrderId', utils.arrayify(fixture.orderId)),
      `Program ${foreign} success`,
      `Program ${program} success`,
    ];
    expect(dlnSolanaEvents(logs, program, 'CreatedOrderId')).to.deep.equal([]);
    expect(() => solanaCreatedOrder(logs, program, fixture.orderId)).to.throw();
  });

  it('rejects truncated or inconsistent invocation logs', () => {
    expect(() =>
      dlnSolanaEvents(createdLogs().slice(0, -1), program, 'CreatedOrder'),
    ).to.throw('Truncated');
    expect(() =>
      dlnSolanaEvents(
        [`Program ${program} invoke [2]`],
        program,
        'CreatedOrder',
      ),
    ).to.throw('Incomplete');
  });
});
