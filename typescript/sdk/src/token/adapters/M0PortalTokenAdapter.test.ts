import { expect } from 'vitest';
import sinon from 'sinon';

import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { test1, test2 } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import { M0PortalTokenAdapter } from './M0PortalTokenAdapter.js';

describe('M0PortalTokenAdapter', () => {
  const PORTAL_ADDRESS = '0xD925C84b55E4e44a53749fF5F2a5A13F63D128fd';
  const MTOKEN_ADDRESS = '0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b';
  const RECIPIENT = '0x1111111111111111111111111111111111111111';
  const SENDER = '0x2222222222222222222222222222222222222222';
  const DESTINATION_DOMAIN = test2.domainId!;
  const DESTINATION_CHAIN_ID = test2.chainId;
  const HYPERLANE_BRIDGE_ADAPTER = '0xfCc1d596Ad6cAb0b5394eAa447d8626813180f32';

  let adapter: M0PortalTokenAdapter;
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    const multiProvider =
      MultiProtocolProvider.createTestMultiProtocolProvider();
    adapter = new M0PortalTokenAdapter(
      multiProvider,
      test1.name,
      PORTAL_ADDRESS,
      MTOKEN_ADDRESS,
    );
  });

  afterEach(() => sandbox.restore());

  describe('quoteTransferRemoteGas', () => {
    it('returns native-gas quote from Portal.quote()', async () => {
      const quote = sandbox.stub().resolves(500n);
      // @ts-ignore Mock portal contract for unit test
      adapter.portalContract = { quote };

      const result = await adapter.quoteTransferRemoteGas({
        destination: DESTINATION_DOMAIN,
      });

      expect(result.igpQuote.amount).toBe(500n);
      expect(result.igpQuote.addressOrDenom).toBe(undefined);
      expect(result.tokenFeeQuote).toBe(undefined);

      expect(quote.calledOnce).toBe(true);
      const args = quote.getCall(0).args;
      expect(args[0]).toBe(DESTINATION_CHAIN_ID);
      expect(args[1]).toBe(0); // TOKEN_TRANSFER_PAYLOAD_TYPE
      expect(args[2]).toBe(HYPERLANE_BRIDGE_ADAPTER);
    });
  });

  describe('populateTransferRemoteTx', () => {
    it('calls sendToken with correct args and tx value', async () => {
      const sendToken = sandbox.stub().resolves({});
      // @ts-ignore Mock portal contract for unit test
      adapter.portalContract = {
        quote: sandbox.stub().resolves(200n),
        populateTransaction: { sendToken },
      };

      const amount = 1000n;
      await adapter.populateTransferRemoteTx({
        weiAmountOrId: amount,
        recipient: RECIPIENT,
        destination: DESTINATION_DOMAIN,
        fromAccountOwner: SENDER,
      });

      expect(sendToken.calledOnce).toBe(true);
      const args = sendToken.getCall(0).args;
      expect(args[0]).toBe(amount); // amount
      expect(args[1]).toBe(MTOKEN_ADDRESS); // sourceToken
      expect(args[2]).toBe(DESTINATION_CHAIN_ID); // destinationChainId
      expect(args[3]).toBe(addressToBytes32(MTOKEN_ADDRESS)); // destinationToken
      expect(args[4]).toBe(addressToBytes32(RECIPIENT)); // recipient
      expect(args[5]).toBe(addressToBytes32(SENDER)); // refundAddress
      expect(args[6]).toBe(HYPERLANE_BRIDGE_ADAPTER);
      expect(args[7]).toBe('0x'); // empty bridge adapter args
      expect(args[8].value).toBe(200n); // tx value = gas quote
    });
  });

  describe('regression: zero igpQuote does not re-quote', () => {
    it('uses provided interchainGas amount of 0n without calling quote()', async () => {
      const quote = sandbox.stub().rejects(new Error('should not be called'));
      const sendToken = sandbox.stub().resolves({});
      // @ts-ignore Mock portal contract for unit test
      adapter.portalContract = {
        quote,
        populateTransaction: { sendToken },
      };

      await adapter.populateTransferRemoteTx({
        weiAmountOrId: 500n,
        recipient: RECIPIENT,
        destination: DESTINATION_DOMAIN,
        fromAccountOwner: SENDER,
        interchainGas: {
          igpQuote: { addressOrDenom: '', amount: 0n },
        },
      });

      expect(quote.called).toBe(false);
      expect(sendToken.calledOnce).toBe(true);
      const args = sendToken.getCall(0).args;
      expect(args[8].value).toBe(0n);
    });
  });
});
