import { expect } from 'chai';

import {
  DelayedFlowRouterHookIsmConfig,
  DispatchedMessage,
  HookType,
  IsmType,
  MailboxDefaultIsmConfig,
  MultiProvider,
  NetFlowRateLimitedHookIsmConfig,
  TestChainName,
} from '@hyperlane-xyz/sdk';
import {
  WithAddress,
  formatMessage,
  messageId,
  parseMessage,
} from '@hyperlane-xyz/utils';

import { decodeIsmMetadata } from './decode.js';
import { testTransactionReceipt } from './testUtils.js';
import type { MetadataContext } from './types.js';

const ISM_ADDRESS = '0x1111111111111111111111111111111111111111';
const HOOK_ADDRESS = '0x2222222222222222222222222222222222222222';
const WARP_ROUTER = '0x3333333333333333333333333333333333333333';
const OWNER = '0x4444444444444444444444444444444444444444';
const SENDER = '0x5555555555555555555555555555555555555555';
const RECIPIENT = '0x6666666666666666666666666666666666666666';

describe('decodeIsmMetadata', () => {
  const multiProvider = MultiProvider.createTestMultiProvider();

  function dispatchedMessage(): DispatchedMessage {
    const rawMessage = formatMessage(
      0,
      0,
      multiProvider.getDomainId(TestChainName.test1),
      SENDER,
      multiProvider.getDomainId(TestChainName.test2),
      RECIPIENT,
      '0x',
    );
    const parsed = parseMessage(rawMessage);
    parsed.originChain = TestChainName.test1;
    parsed.destinationChain = TestChainName.test2;
    return { id: messageId(rawMessage), message: rawMessage, parsed };
  }

  function contextFor<T>(ism: T): MetadataContext<T> {
    return {
      message: dispatchedMessage(),
      dispatchTx: testTransactionReceipt(),
      ism,
      hook: { type: HookType.MERKLE_TREE, address: HOOK_ADDRESS },
    };
  }

  it('decodes a net flow rate limited hybrid as a null ism', () => {
    const ism: WithAddress<NetFlowRateLimitedHookIsmConfig> = {
      type: IsmType.NET_FLOW_RATE_LIMITED,
      address: ISM_ADDRESS,
      warpRouter: WARP_ROUTER,
      thresholdBps: 10000,
      duration: 86400n,
      owner: OWNER,
    };

    expect(decodeIsmMetadata('0x', contextFor(ism))).to.deep.equal(ism);
  });

  it('decodes a delayed flow router hybrid as a null ism', () => {
    const ism: WithAddress<DelayedFlowRouterHookIsmConfig> = {
      type: IsmType.DELAYED_FLOW_ROUTER,
      address: ISM_ADDRESS,
      warpRouter: WARP_ROUTER,
      thresholdBps: 10000,
      maxDelay: 60,
      duration: 86400n,
      owner: OWNER,
    };

    expect(decodeIsmMetadata('0x', contextFor(ism))).to.deep.equal(ism);
  });

  it('decodes a mailbox default ism, surfacing the routed metadata as raw bytes', () => {
    const ism: WithAddress<MailboxDefaultIsmConfig> = {
      type: IsmType.MAILBOX_DEFAULT,
      address: ISM_ADDRESS,
    };

    expect(decodeIsmMetadata('0xabcdef', contextFor(ism))).to.deep.equal({
      type: IsmType.MAILBOX_DEFAULT,
      origin: TestChainName.test1,
      metadata: '0xabcdef',
    });
  });
});
