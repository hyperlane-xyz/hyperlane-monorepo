import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  ETHEREUM_CHAIN_ID,
  FLUENT_BRIDGE_ADDRESS,
  FLUENT_CHAIN_ID,
  FLUENT_NATIVE_GATEWAY_ADDRESS,
  MessageStatus,
  NATIVE_TOKEN_SENTINEL,
  buildEthereumToFluentDeposit,
  buildFluentToEthereumWithdraw,
  extractMessageHashFromReceipt,
  fluentBridgeInterface,
  nativeGatewayInterface,
  sentMessageTopic,
} from './fluentUtils.js';

const TEST_RECIPIENT = '0x3e0a78a330f2b97059a4d507ca9d8292b65b6fb5';

describe('fluentUtils', () => {
  describe('constants', () => {
    it('exposes the verified mainnet contract addresses', () => {
      expect(FLUENT_BRIDGE_ADDRESS.toLowerCase()).to.equal(
        '0x9cacf613fc29015893728563f423fd26dcdb8ddc',
      );
      expect(FLUENT_NATIVE_GATEWAY_ADDRESS.toLowerCase()).to.equal(
        '0x8976ca4e0c8467097da675399fb7db454a1b56dd',
      );
      expect(NATIVE_TOKEN_SENTINEL).to.equal(ethers.constants.AddressZero);
      expect(FLUENT_CHAIN_ID).to.equal(25363);
      expect(ETHEREUM_CHAIN_ID).to.equal(1);
    });

    it('uses the empirically verified MessageStatus enum mapping', () => {
      expect(MessageStatus.None).to.equal(0);
      expect(MessageStatus.Failed).to.equal(1);
      expect(MessageStatus.Success).to.equal(2);
    });
  });

  describe('buildEthereumToFluentDeposit', () => {
    it('encodes sendNativeTokens(recipient) with value = amount + fee', () => {
      const tx = buildEthereumToFluentDeposit({
        nativeGateway: FLUENT_NATIVE_GATEWAY_ADDRESS,
        recipient: TEST_RECIPIENT,
        amount: 1_000_000_000_000_000n,
        messageFee: 0n,
      });

      expect(tx.chainId).to.equal(ETHEREUM_CHAIN_ID);
      expect(tx.to.toLowerCase()).to.equal(
        FLUENT_NATIVE_GATEWAY_ADDRESS.toLowerCase(),
      );
      expect(tx.value).to.equal(1_000_000_000_000_000n);

      const decoded = nativeGatewayInterface.decodeFunctionData(
        'sendNativeTokens',
        tx.data,
      );
      expect(decoded[0].toLowerCase()).to.equal(TEST_RECIPIENT);
    });

    it('adds the message fee to the tx value', () => {
      const tx = buildEthereumToFluentDeposit({
        nativeGateway: FLUENT_NATIVE_GATEWAY_ADDRESS,
        recipient: TEST_RECIPIENT,
        amount: 200_000_000_000_000n,
        messageFee: 449_828_643_600_000n,
      });
      expect(tx.value).to.equal(200_000_000_000_000n + 449_828_643_600_000n);
    });

    it('rejects non-positive amounts', () => {
      expect(() =>
        buildEthereumToFluentDeposit({
          nativeGateway: FLUENT_NATIVE_GATEWAY_ADDRESS,
          recipient: TEST_RECIPIENT,
          amount: 0n,
          messageFee: 0n,
        }),
      ).to.throw(/Invalid amount/);
    });
  });

  describe('buildFluentToEthereumWithdraw', () => {
    it('mirrors deposit but uses the Fluent chainId', () => {
      const tx = buildFluentToEthereumWithdraw({
        nativeGateway: FLUENT_NATIVE_GATEWAY_ADDRESS,
        recipient: TEST_RECIPIENT,
        amount: 200_000_000_000_000n,
        messageFee: 449_828_643_600_000n,
      });
      expect(tx.chainId).to.equal(FLUENT_CHAIN_ID);
      expect(tx.value).to.equal(200_000_000_000_000n + 449_828_643_600_000n);
      expect(tx.to.toLowerCase()).to.equal(
        FLUENT_NATIVE_GATEWAY_ADDRESS.toLowerCase(),
      );
    });
  });

  describe('extractMessageHashFromReceipt', () => {
    it('returns the messageHash from a SentMessage log', () => {
      const messageHash = ethers.utils.hexZeroPad('0xabcd', 32);
      const encoded = fluentBridgeInterface.encodeEventLog(
        fluentBridgeInterface.getEvent('SentMessage'),
        [
          TEST_RECIPIENT,
          FLUENT_NATIVE_GATEWAY_ADDRESS,
          1_000_000_000_000_000n,
          0n,
          ETHEREUM_CHAIN_ID,
          24_993_000,
          809,
          messageHash,
          '0xb9cca7a3',
        ],
      );
      const receipt = {
        logs: [
          {
            address: FLUENT_BRIDGE_ADDRESS,
            topics: encoded.topics,
            data: encoded.data,
          },
        ],
      } as ethers.providers.TransactionReceipt;
      expect(extractMessageHashFromReceipt(receipt)).to.equal(messageHash);
    });

    it('returns undefined when no SentMessage log is present', () => {
      const receipt = {
        logs: [
          {
            topics: [ethers.utils.id('Unrelated()')],
            data: '0x',
          },
        ],
      } as ethers.providers.TransactionReceipt;
      expect(extractMessageHashFromReceipt(receipt)).to.be.undefined;
    });

    it('exposes a deterministic SentMessage topic', () => {
      expect(sentMessageTopic).to.equal(
        ethers.utils.id(
          'SentMessage(address,address,uint256,uint256,uint256,uint256,uint256,bytes32,bytes)',
        ),
      );
    });
  });
});
