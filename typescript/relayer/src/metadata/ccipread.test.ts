import { expect } from 'chai';
import { Wallet, providers, utils } from 'ethers';
import sinon from 'sinon';

import {
  AbstractCcipReadIsm__factory,
  CommitmentReadIsmService__factory,
} from '@hyperlane-xyz/core';
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
const GET_URL = 'https://ccip.example.com/lookup/{sender}/{data}.json';
const OTHER_CALL_DATA = '0x12345678';
const OTHER_MESSAGE = '0x' + '66'.repeat(77);
const METADATA = '0x01';

function revealCallData(revealMessage: string): string {
  return CommitmentReadIsmService__factory.createInterface().encodeFunctionData(
    'getCallsFromRevealMessage',
    [revealMessage],
  );
}

/** The request the builder is expected to send. */
const ExpectedRequest = {
  SignedPost: 'signed-post',
  UnsignedPost: 'unsigned-post',
  Get: 'get',
  None: 'none',
} as const;
type ExpectedRequest = (typeof ExpectedRequest)[keyof typeof ExpectedRequest];

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
    /** The lookup's call data, given the message being delivered. */
    callData: (deliveredMessage: string) => string;
    urls: string[];
    request: ExpectedRequest;
    /** Whether the first fetch rejects, so the builder tries the next URL. */
    firstFetchRejects?: boolean;
  }

  const cases: Case[] = [
    {
      name: 'signs and fetches a reveal lookup for the delivered message',
      callData: revealCallData,
      urls: [POST_URL],
      request: ExpectedRequest.SignedPost,
    },
    {
      name: 'tries the next URL when the signed reveal POST rejects',
      callData: revealCallData,
      urls: [POST_URL, GET_URL],
      request: ExpectedRequest.SignedPost,
      firstFetchRejects: true,
    },
    {
      name: 'neither signs nor fetches a reveal lookup for another message',
      callData: () => revealCallData(OTHER_MESSAGE),
      urls: [POST_URL],
      request: ExpectedRequest.None,
    },
    {
      name: 'neither signs nor fetches a reveal lookup with malformed arguments',
      callData: (deliveredMessage) =>
        utils.hexDataSlice(revealCallData(deliveredMessage), 0, 40),
      urls: [POST_URL],
      request: ExpectedRequest.None,
    },
    {
      name: 'neither signs nor fetches a reveal lookup without arguments',
      callData: (deliveredMessage) =>
        utils.hexDataSlice(revealCallData(deliveredMessage), 0, 4),
      urls: [POST_URL],
      request: ExpectedRequest.None,
    },
    {
      name: 'fetches a GET-style reveal lookup for another message without signing',
      callData: () => revealCallData(OTHER_MESSAGE),
      urls: [GET_URL],
      request: ExpectedRequest.Get,
    },
    {
      name: 'skips the POST of a reveal lookup for another message and tries the next URL',
      callData: () => revealCallData(OTHER_MESSAGE),
      urls: [POST_URL, GET_URL],
      request: ExpectedRequest.Get,
    },
    {
      name: 'fetches a lookup with another selector without signing',
      callData: () => OTHER_CALL_DATA,
      urls: [POST_URL],
      request: ExpectedRequest.UnsignedPost,
    },
    {
      name: 'fetches a lookup with call data shorter than a selector without signing',
      callData: () => '0x2b4b00',
      urls: [POST_URL],
      request: ExpectedRequest.UnsignedPost,
    },
    {
      name: 'fetches a lookup with empty call data without signing',
      callData: () => '0x',
      urls: [POST_URL],
      request: ExpectedRequest.UnsignedPost,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const multiProvider = MultiProvider.createTestMultiProvider();
      const provider = new providers.JsonRpcProvider();
      const signer = new Wallet('0x' + '01'.repeat(32), provider);
      sandbox.stub(multiProvider, 'getProvider').returns(provider);
      sandbox.stub(multiProvider, 'getSigner').returns(signer);
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
      const callData = c.callData(rawMessage);
      const revertData =
        AbstractCcipReadIsm__factory.createInterface().encodeErrorResult(
          'OffchainLookup',
          [ISM_ADDRESS, c.urls, callData, '0x00000000', '0x'],
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
      if (c.firstFetchRejects) {
        // What fetch throws for a redirect under `redirect: 'error'`.
        fetchStub.onFirstCall().rejects(new TypeError('fetch failed'));
      }

      const ism: WithAddress<OffchainLookupIsmConfig> = {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: OWNER,
        urls: c.urls,
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

      if (c.request === ExpectedRequest.None) {
        expect(await build).to.deep.equal({
          type: IsmType.OFFCHAIN_LOOKUP,
          ismAddress: ISM_ADDRESS,
          urls: c.urls,
        });
        sinon.assert.notCalled(signMessage);
        sinon.assert.notCalled(fetchStub);
        return;
      }

      expect(await build).to.deep.equal({
        type: IsmType.OFFCHAIN_LOOKUP,
        ismAddress: ISM_ADDRESS,
        urls: c.urls,
        metadata: METADATA,
      });
      const signed = c.request === ExpectedRequest.SignedPost;
      sinon.assert.callCount(signMessage, signed ? 1 : 0);
      sinon.assert.callCount(fetchStub, c.firstFetchRejects ? 2 : 1);
      const getUrl = GET_URL.replace(
        '{sender}',
        utils.getAddress(ISM_ADDRESS),
      ).replace('{data}', callData);
      const [url, init] = fetchStub.firstCall.args;
      if (c.request === ExpectedRequest.Get) {
        expect(url).to.equal(getUrl);
        expect(init).to.equal(undefined);
        return;
      }

      expect(url).to.equal(POST_URL);
      expect(init?.method).to.equal('POST');
      expect(init?.redirect).to.equal(signed ? 'error' : undefined);
      const body = JSON.parse(String(init?.body));
      expect(body).to.have.all.keys(
        signed
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
        data: callData,
        origin_tx_hash: testTransactionReceipt().transactionHash,
      });
      if (signed) expect(body.message_id).to.equal(message.id);
      if (c.firstFetchRejects) {
        expect(fetchStub.secondCall.args).to.deep.equal([getUrl]);
      }
    });
  }
});
