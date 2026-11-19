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
const OTHER_ISM_ADDRESS = '0x' + 'cd'.repeat(20);
const OWNER = '0x' + '11'.repeat(20);
const HOOK_ADDRESS = '0x' + '22'.repeat(20);
const SENDER = '0x' + '44'.repeat(20);
const RECIPIENT = '0x' + '55'.repeat(20);
const POST_URL = 'https://ccip.example.com/lookup';
const GET_URL = 'https://ccip.example.com/lookup/{sender}/{data}.json';
const CALL_DATA = '0x12345678';
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
    /** The `sender` of the ISM's OffchainLookup revert, decoded checksummed. */
    lookupSender: string;
    /** The address of the queried ISM in its derived config. */
    ismAddress: string;
    url: string;
    error?: string;
  }

  const cases: Case[] = [
    {
      name: 'rejects a lookup from another sender before signing or fetching',
      lookupSender: utils.getAddress(OTHER_ISM_ADDRESS),
      ismAddress: ISM_ADDRESS,
      url: POST_URL,
      error: `Offchain lookup sender ${utils.getAddress(OTHER_ISM_ADDRESS)} is not the queried ISM ${ISM_ADDRESS}`,
    },
    {
      name: 'rejects a lookup from another sender before fetching a data URL',
      lookupSender: utils.getAddress(OTHER_ISM_ADDRESS),
      ismAddress: ISM_ADDRESS,
      url: GET_URL,
      error: `Offchain lookup sender ${utils.getAddress(OTHER_ISM_ADDRESS)} is not the queried ISM ${ISM_ADDRESS}`,
    },
    {
      name: 'signs and fetches a lookup from the queried ISM configured in lower case',
      lookupSender: ISM_ADDRESS,
      ismAddress: ISM_ADDRESS,
      url: POST_URL,
    },
    {
      name: 'signs and fetches a lookup from the queried ISM configured in checksummed case',
      lookupSender: ISM_ADDRESS,
      ismAddress: utils.getAddress(ISM_ADDRESS),
      url: POST_URL,
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
          [c.lookupSender, [c.url], CALL_DATA, '0x00000000', '0x'],
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
        urls: [c.url],
        address: c.ismAddress,
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

      if (c.error !== undefined) {
        const error = await build.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(error).to.be.instanceOf(Error).with.property('message', c.error);
        sinon.assert.notCalled(signMessage);
        sinon.assert.notCalled(fetchStub);
        return;
      }

      expect(await build).to.deep.equal({
        type: IsmType.OFFCHAIN_LOOKUP,
        ismAddress: c.ismAddress,
        urls: [c.url],
        metadata: METADATA,
      });
      sinon.assert.calledOnce(signMessage);
      sinon.assert.calledOnce(fetchStub);
      const [, init] = fetchStub.firstCall.args;
      expect(init?.method).to.equal('POST');
      expect(JSON.parse(String(init?.body))).to.include({
        sender: utils.getAddress(c.lookupSender),
        data: CALL_DATA,
      });
    });
  }
});
