import { expect } from 'chai';
import type { providers } from 'ethers';
import sinon from 'sinon';

import { IRoutingIsm, IRoutingIsm__factory } from '@hyperlane-xyz/core';
import {
  DispatchedMessage,
  EvmIsmReader,
  HookType,
  IsmType,
  MailboxDefaultIsmConfig,
  MultiProvider,
  TestChainName,
  TrustedRelayerIsmConfig,
} from '@hyperlane-xyz/sdk';
import {
  WithAddress,
  formatMessage,
  messageId,
  parseMessage,
} from '@hyperlane-xyz/utils';

import type { BaseMetadataBuilder } from './builder.js';
import { DynamicRoutingMetadataBuilder } from './routing.js';
import type { MetadataContext, NullMetadataBuildResult } from './types.js';

const ISM_ADDRESS = '0x1111111111111111111111111111111111111111';
const HOOK_ADDRESS = '0x2222222222222222222222222222222222222222';
const ROUTED_ISM_ADDRESS = '0x3333333333333333333333333333333333333333';
const SENDER = '0x4444444444444444444444444444444444444444';
const RECIPIENT = '0x5555555555555555555555555555555555555555';

describe('DynamicRoutingMetadataBuilder', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('routes a mailbox default ism via on-chain route() and recurses on the resolved ism', async () => {
    const originDomain = multiProvider.getDomainId(TestChainName.test1);
    const destinationDomain = multiProvider.getDomainId(TestChainName.test2);
    const rawMessage = formatMessage(
      0,
      0,
      originDomain,
      SENDER,
      destinationDomain,
      RECIPIENT,
      '0x',
    );
    const message: DispatchedMessage = {
      id: messageId(rawMessage),
      message: rawMessage,
      parsed: parseMessage(rawMessage),
    };

    const routeStub = sandbox.stub().resolves(ROUTED_ISM_ADDRESS);
    sandbox.stub(IRoutingIsm__factory, 'connect').returns({
      route: routeStub,
    } as unknown as IRoutingIsm);

    const derivedRoutedIsm: WithAddress<TrustedRelayerIsmConfig> = {
      type: IsmType.TRUSTED_RELAYER,
      relayer: SENDER,
      address: ROUTED_ISM_ADDRESS,
    };
    const deriveStub = sandbox
      .stub(EvmIsmReader.prototype, 'deriveIsmConfig')
      .resolves(derivedRoutedIsm);

    const routedIsmResult: NullMetadataBuildResult = {
      type: IsmType.TRUSTED_RELAYER,
      ismAddress: ROUTED_ISM_ADDRESS,
      metadata: '0x',
    };
    const buildStub = sandbox.stub().resolves(routedIsmResult);
    const baseMetadataBuilder = {
      multiProvider,
      build: buildStub,
    } as unknown as BaseMetadataBuilder;

    const ism: WithAddress<MailboxDefaultIsmConfig> = {
      type: IsmType.MAILBOX_DEFAULT,
      address: ISM_ADDRESS,
    };
    const context: MetadataContext<WithAddress<MailboxDefaultIsmConfig>> = {
      message,
      // not read by the routing builder — placeholder receipt double
      dispatchTx: {} as unknown as providers.TransactionReceipt,
      ism,
      hook: { type: HookType.MERKLE_TREE, address: HOOK_ADDRESS },
    };

    const builder = new DynamicRoutingMetadataBuilder(baseMetadataBuilder);
    const result = await builder.build(context);

    // the mailbox default ism has no domains table: it must be resolved via
    // the on-chain route(message) call with the raw dispatched message
    expect(routeStub.calledOnceWith(rawMessage)).to.be.true;
    expect(deriveStub.calledOnceWith(ROUTED_ISM_ADDRESS)).to.be.true;
    expect(buildStub.calledOnce).to.be.true;
    expect(buildStub.firstCall.args[0].ism).to.deep.equal(derivedRoutedIsm);

    expect(result).to.deep.equal({
      type: IsmType.MAILBOX_DEFAULT,
      ismAddress: ISM_ADDRESS,
      originChain: TestChainName.test1,
      selectedIsm: routedIsmResult,
      metadata: '0x',
    });
  });
});
