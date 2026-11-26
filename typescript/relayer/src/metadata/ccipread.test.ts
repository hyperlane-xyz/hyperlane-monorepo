import { expect } from 'chai';
import { Wallet, providers, utils } from 'ethers';
import sinon from 'sinon';

import { AbstractCcipReadIsm__factory } from '@hyperlane-xyz/core';
import {
  DispatchedMessage,
  HookType,
  HyperlaneCore,
  IsmType,
  MultiProvider,
  OffchainLookupIsmConfig,
  TestChainName,
} from '@hyperlane-xyz/sdk';
import {
  WithAddress,
  formatMessage,
  messageId,
  parseMessage,
} from '@hyperlane-xyz/utils';

import { OffchainLookupMetadataBuilder } from './ccipread.js';
import { testTransactionReceipt } from './testUtils.js';

const ISM_ADDRESS = '0x' + 'ab'.repeat(20);
const OWNER = '0x' + '11'.repeat(20);
const HOOK_ADDRESS = '0x' + '22'.repeat(20);
const SENDER = '0x' + '44'.repeat(20);
const RECIPIENT = '0x' + '55'.repeat(20);
const POST_URL = 'https://ccip.example.com/lookup';
const REVEAL_CALL_DATA =
  '0x2b4b00ee' + '00'.repeat(31) + '20' + '00'.repeat(32);
const OTHER_CALL_DATA = '0x12345678';
const METADATA = '0x01';

describe('OffchainLookupMetadataBuilder', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  interface Case {
    name: string;
    callData: string;
    /** Whether the POST body carries a v2 signature. */
    signed: boolean;
  }

  const cases: Case[] = [
    {
      name: 'signs and fetches a reveal lookup',
      callData: REVEAL_CALL_DATA,
      signed: true,
    },
    {
      name: 'fetches a lookup with another selector without signing',
      callData: OTHER_CALL_DATA,
      signed: false,
    },
    {
      name: 'fetches a lookup with call data shorter than a selector without signing',
      callData: '0x2b4b00',
      signed: false,
    },
    {
      name: 'fetches a lookup with empty call data without signing',
      callData: '0x',
      signed: false,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const multiProvider = MultiProvider.createTestMultiProvider();
      const provider = new providers.JsonRpcProvider();
      const signer = new Wallet('0x' + '01'.repeat(32), provider);
      sandbox.stub(multiProvider, 'getProvider').returns(provider);
      sandbox.stub(multiProvider, 'getSigner').returns(signer);
      const revertData =
        AbstractCcipReadIsm__factory.createInterface().encodeErrorResult(
          'OffchainLookup',
          [ISM_ADDRESS, [POST_URL], c.callData, '0x00000000', '0x'],
        );
      sandbox
        .stub(provider, 'call')
        .rejects(
          Object.assign(new Error('execution reverted'), { data: revertData }),
        );
      const signMessage = sandbox.spy(signer, 'signMessage');
      const fetchStub = sandbox
        .stub(globalThis, 'fetch')
        .callsFake(
          async () =>
            new Response(JSON.stringify({ data: METADATA }), { status: 200 }),
        );

      const rawMessage = formatMessage(
        3,
        0,
        multiProvider.getDomainId(TestChainName.test1),
        SENDER,
        multiProvider.getDomainId(TestChainName.test2),
        RECIPIENT,
        '0x1234',
      );
      const message: DispatchedMessage = {
        id: messageId(rawMessage),
        message: rawMessage,
        parsed: parseMessage(rawMessage),
      };
      const ism: WithAddress<OffchainLookupIsmConfig> = {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: OWNER,
        urls: [POST_URL],
        address: ISM_ADDRESS,
      };
      const builder = new OffchainLookupMetadataBuilder(
        new HyperlaneCore({}, multiProvider),
      );
      const build = builder.build({
        message,
        dispatchTx: testTransactionReceipt(),
        ism,
        hook: { type: HookType.MERKLE_TREE, address: HOOK_ADDRESS },
      });

      expect(await build).to.deep.equal({
        type: IsmType.OFFCHAIN_LOOKUP,
        ismAddress: ISM_ADDRESS,
        urls: [POST_URL],
        metadata: METADATA,
      });
      sinon.assert.callCount(signMessage, c.signed ? 1 : 0);
      sinon.assert.calledOnce(fetchStub);
      const [, init] = fetchStub.firstCall.args;
      expect(init?.method).to.equal('POST');
      const body = JSON.parse(String(init?.body));
      expect(body).to.have.all.keys(
        c.signed
          ? [
              'sender',
              'data',
              'origin_tx_hash',
              'signature',
              'message_id',
              'issued_at',
            ]
          : ['sender', 'data', 'origin_tx_hash'],
      );
      expect(body).to.include({
        sender: utils.getAddress(ISM_ADDRESS),
        data: c.callData,
        origin_tx_hash: testTransactionReceipt().transactionHash,
      });
      if (c.signed) expect(body.message_id).to.equal(message.id);
    });
  }
});
