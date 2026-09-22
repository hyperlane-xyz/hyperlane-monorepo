import { createHash } from 'node:crypto';

import { utils, type providers } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

// dln-contracts@d54e94f2b5102bff89a4df506404bb77f3edc148, DlnOrderLib.
export const DLN_ORDER_ABI =
  '(uint64 makerOrderNonce,bytes makerSrc,uint256 giveChainId,bytes giveTokenAddress,uint256 giveAmount,uint256 takeChainId,bytes takeTokenAddress,uint256 takeAmount,bytes receiverDst,bytes givePatchAuthoritySrc,bytes orderAuthorityAddressDst,bytes allowedTakerDst,bytes allowedCancelBeneficiarySrc,bytes externalCall)';
export const DLN_EVENTS = new utils.Interface([
  `event CreatedOrder(${DLN_ORDER_ABI} order,bytes32 orderId,bytes affiliateFee,uint256 nativeFixFee,uint256 percentFee,uint32 referralCode,bytes metadata)`,
  `event FulfilledOrder(${DLN_ORDER_ABI} order,bytes32 orderId,address sender,address unlockAuthority)`,
]);

export interface DlnOrder {
  makerOrderNonce: bigint;
  makerSrc: string;
  giveChainId: bigint;
  giveTokenAddress: string;
  giveAmount: bigint;
  takeChainId: bigint;
  takeTokenAddress: string;
  takeAmount: bigint;
  receiverDst: string;
  givePatchAuthoritySrc: string;
  orderAuthorityAddressDst: string;
  allowedTakerDst: string;
  allowedCancelBeneficiarySrc: string;
  externalCall: string;
}

/** The protocol's packed ID commits to both routes, amounts and authorities. */
export function dlnOrderId(order: DlnOrder): string {
  const bytes = (value: string) => {
    const size = utils.arrayify(value).length;
    assert(size <= 255, 'DLN order address is too long');
    return utils.solidityPack(['uint8', 'bytes'], [size, value]);
  };
  assert(order.externalCall === '0x', 'DLN settlement hooks are unsupported');
  return utils.keccak256(
    utils.hexConcat([
      utils.solidityPack(['uint64'], [order.makerOrderNonce]),
      bytes(order.makerSrc),
      utils.solidityPack(['uint256'], [order.giveChainId]),
      bytes(order.giveTokenAddress),
      utils.solidityPack(
        ['uint256', 'uint256'],
        [order.giveAmount, order.takeChainId],
      ),
      bytes(order.takeTokenAddress),
      utils.solidityPack(['uint256'], [order.takeAmount]),
      bytes(order.receiverDst),
      bytes(order.givePatchAuthoritySrc),
      bytes(order.orderAuthorityAddressDst),
      bytes(order.allowedTakerDst),
      bytes(order.allowedCancelBeneficiarySrc),
      '0x00',
    ]),
  );
}

export function evmDlnOrder(
  logs: providers.Log[],
  contract: string,
  event: 'CreatedOrder' | 'FulfilledOrder',
  orderId: string,
): DlnOrder {
  const matches = logs
    .filter(
      (log) =>
        log.address.toLowerCase() === contract.toLowerCase() &&
        log.topics[0] === DLN_EVENTS.getEventTopic(event),
    )
    .map((log) => DLN_EVENTS.parseLog(log))
    .filter(
      (log) => String(log.args.orderId).toLowerCase() === orderId.toLowerCase(),
    );
  assert(matches.length === 1, `Expected one matching DLN ${event} event`);
  const raw = matches[0].args.order;
  const order: DlnOrder = {
    makerOrderNonce: BigInt(raw.makerOrderNonce.toString()),
    makerSrc: raw.makerSrc,
    giveChainId: BigInt(raw.giveChainId.toString()),
    giveTokenAddress: raw.giveTokenAddress,
    giveAmount: BigInt(raw.giveAmount.toString()),
    takeChainId: BigInt(raw.takeChainId.toString()),
    takeTokenAddress: raw.takeTokenAddress,
    takeAmount: BigInt(raw.takeAmount.toString()),
    receiverDst: raw.receiverDst,
    givePatchAuthoritySrc: raw.givePatchAuthoritySrc,
    orderAuthorityAddressDst: raw.orderAuthorityAddressDst,
    allowedTakerDst: raw.allowedTakerDst,
    allowedCancelBeneficiarySrc: raw.allowedCancelBeneficiarySrc,
    externalCall: raw.externalCall,
  };
  assert(
    dlnOrderId(order).toLowerCase() === orderId.toLowerCase(),
    'DLN event order ID does not match order fields',
  );
  return order;
}

const discriminator = (name: string) =>
  createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);

/** Accept Anchor events only while the expected program is executing. */
export function dlnSolanaEvents(
  logs: string[],
  program: string,
  event: string,
): Buffer[] {
  const stack: string[] = [];
  const events: Buffer[] = [];
  for (const log of logs) {
    const invocation = /^Program (\w+) invoke \[(\d+)\]$/.exec(log);
    if (invocation) {
      assert(
        Number(invocation[2]) === stack.length + 1,
        'Incomplete Solana invocation logs',
      );
      stack.push(invocation[1]);
      continue;
    }
    const exit = /^Program (\w+) (?:success|failed:.*)$/.exec(log);
    if (exit) {
      assert(stack.pop() === exit[1], 'Invalid Solana invocation logs');
      continue;
    }
    if (stack.at(-1) === program && log.startsWith('Program data: ')) {
      const data = Buffer.from(log.slice('Program data: '.length), 'base64');
      if (data.subarray(0, 8).equals(discriminator(event)))
        events.push(data.subarray(8));
    }
  }
  assert(stack.length === 0, 'Truncated Solana invocation logs');
  return events;
}

// abis-and-idls@1a4c5fa1b59613e824c72dfc473ba7b3d6f5042c, src CreatedOrder.
export function solanaCreatedOrder(
  logs: string[],
  program: string,
  orderId: string,
): DlnOrder {
  const ids = dlnSolanaEvents(logs, program, 'CreatedOrderId');
  const orders = dlnSolanaEvents(logs, program, 'CreatedOrder');
  assert(
    ids.length === 1 &&
      ids[0].length === 32 &&
      utils.hexlify(ids[0]) === orderId.toLowerCase(),
    'DLN source transaction order ID mismatch',
  );
  assert(orders.length === 1, 'Expected one DLN Solana CreatedOrder event');
  const data = orders[0];
  let offset = 0;
  const read = (size: number) => {
    assert(
      size >= 0 && offset + size <= data.length,
      'Truncated DLN Solana order event',
    );
    const result = data.subarray(offset, offset + size);
    offset += size;
    return result;
  };
  const vector = () => utils.hexlify(read(read(4).readUInt32LE()));
  const uint256 = () => BigInt(utils.hexlify(read(32)));
  const optional = () => {
    const flag = read(1)[0];
    assert(flag === 0 || flag === 1, 'Invalid DLN event option');
    return flag ? vector() : '0x';
  };
  const order: DlnOrder = {
    makerOrderNonce: read(8).readBigUInt64LE(),
    makerSrc: vector(),
    giveChainId: uint256(),
    giveTokenAddress: vector(),
    giveAmount: uint256(),
    takeChainId: uint256(),
    takeTokenAddress: vector(),
    takeAmount: uint256(),
    receiverDst: vector(),
    givePatchAuthoritySrc: vector(),
    orderAuthorityAddressDst: vector(),
    allowedTakerDst: optional(),
    allowedCancelBeneficiarySrc: optional(),
    externalCall: '0x',
  };
  assert(read(1)[0] === 0, 'DLN settlement hooks are unsupported');
  read(16); // Fixed native fee and percentage fee, both u64.
  assert(offset === data.length, 'Unexpected DLN Solana order event data');
  assert(
    dlnOrderId(order) === orderId.toLowerCase(),
    'DLN event order ID does not match order fields',
  );
  return order;
}
