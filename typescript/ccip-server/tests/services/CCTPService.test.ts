import { expect } from 'chai';
import { ethers } from 'ethers';
import pino from 'pino';
import { Registry } from 'prom-client';
import sinon from 'sinon';

import { IMessageTransmitter__factory } from '@hyperlane-xyz/core';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { formatMessage } from '@hyperlane-xyz/utils';

import { CCTPService } from '../../src/services/CCTPService.js';
import { initializeMetrics } from '../../src/utils/prometheus.js';

const iface = IMessageTransmitter__factory.createInterface();
const event = iface.getEvent('MessageSent(bytes)');
const address = `0x${'12'.repeat(20)}`;
const hash = ethers.constants.HashZero;
const logger = pino({ level: 'silent' });

function log(data: string, topics: string[]): ethers.providers.Log {
  return {
    address,
    data,
    topics,
    blockNumber: 1,
    blockHash: hash,
    transactionHash: hash,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function receipt(
  logs: ethers.providers.Log[],
): ethers.providers.TransactionReceipt {
  return {
    to: address,
    from: address,
    contractAddress: address,
    transactionIndex: 0,
    gasUsed: ethers.BigNumber.from(0),
    logsBloom: '0x',
    blockHash: hash,
    transactionHash: hash,
    logs,
    blockNumber: 1,
    confirmations: 1,
    cumulativeGasUsed: ethers.BigNumber.from(0),
    effectiveGasPrice: ethers.BigNumber.from(0),
    byzantium: true,
    type: 2,
  };
}

function messageLog(message: string): ethers.providers.Log {
  const encoded = iface.encodeEventLog(event, [message]);
  return log(encoded.data, encoded.topics);
}

describe('CCTPService receipt decoding', () => {
  let service: CCTPService;
  beforeEach(() => {
    sinon.stub(process, 'env').value({
      ...process.env,
      HYPERLANE_EXPLORER_URL: 'https://example.com',
      CCTP_ATTESTATION_URL: 'https://example.com',
    });
    initializeMetrics(new Registry());
    service = new CCTPService({
      serviceName: 'test',
      multiProvider: new MultiProvider({}),
    });
  });
  afterEach(() => sinon.restore());

  it('decodes only MessageSent events in a receipt with unrelated and anonymous logs', async () => {
    const parse = sinon.spy(ethers.utils.Interface.prototype, 'parseLog');
    const unrelated = Array.from({ length: 100 }, () => log('0x', [hash]));
    const result = await service.getCCTPMessageFromReceipt(
      receipt([...unrelated, log('0x', []), messageLog('0x1234')]),
      '0x',
      hash,
      logger,
    );
    expect(result).to.equal('0x1234');
    expect(parse.callCount).to.equal(1);
  });

  it('retains case-insensitive topic matching and skips malformed matching logs', async () => {
    const valid = messageLog('0x1234');
    valid.topics = valid.topics.map(
      (topic) => `0x${topic.slice(2).toUpperCase()}`,
    );
    const result = await service.getCCTPMessageFromReceipt(
      receipt([log('0x', [iface.getEventTopic(event)]), valid]),
      '0x',
      hash,
      logger,
    );
    expect(result).to.equal('0x1234');
  });

  it('preserves the error when no valid MessageSent event exists', async () => {
    try {
      await service.getCCTPMessageFromReceipt(
        receipt([log('0x', [hash])]),
        '0x',
        hash,
        logger,
      );
      expect.fail('Expected a missing-message error');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).to.equal(
        'Unable to find MessageSent event in logs',
      );
    }
  });

  it('retains multi-message disambiguation after filtering unrelated events', async () => {
    const hyperlaneMessage = formatMessage(3, 0, 1, address, 2, address, '0x');
    const id = ethers.utils.keccak256(hyperlaneMessage);
    const gmp = Buffer.alloc(180);
    Buffer.from(id.slice(2), 'hex').copy(gmp, 148);
    const matchingMessage = ethers.utils.hexlify(gmp);
    const otherMessage = ethers.utils.hexlify(Buffer.alloc(180));
    const result = await service.getCCTPMessageFromReceipt(
      receipt([
        messageLog(otherMessage),
        log('0x', [hash]),
        messageLog(matchingMessage),
      ]),
      hyperlaneMessage,
      id,
      logger,
    );
    expect(result).to.equal(matchingMessage);
  });
});
