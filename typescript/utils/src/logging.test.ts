import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { PassThrough } from 'stream';

import {
  LogFormat,
  createHyperlanePinoLogger,
  ethersBigNumberSerializer,
} from './logging.js';

describe('Logging Utilities', () => {
  describe('createHyperlanePinoLogger with additionalStreams', () => {
    it('sends logs to additional stream in JSON mode', (done) => {
      const passThrough = new PassThrough();
      let data = '';

      passThrough.on('data', (chunk) => {
        data += chunk.toString();
      });

      const logger = createHyperlanePinoLogger('info', LogFormat.JSON, [
        passThrough,
      ]);

      logger.info('test message');

      // pino is async — give it a tick to flush
      setTimeout(() => {
        expect(data).to.include('test message');
        const parsed = JSON.parse(data.trim());
        expect(parsed.msg).to.equal('test message');
        done();
      }, 100);
    });

    it('without additional streams uses default behavior', () => {
      const logger = createHyperlanePinoLogger('info', LogFormat.JSON);
      expect(logger).to.exist;
      expect(logger.level).to.equal('info');
    });
  });

  describe('ethersBigNumberSerializer', () => {
    it('should serialize a BigNumber object correctly', () => {
      const key = 'testKey';
      const value = {
        type: 'BigNumber',
        hex: '0x1a',
      };
      const result = ethersBigNumberSerializer(key, value);
      expect(result).to.equal(BigNumber.from(value.hex).toString());
    });

    it('should return the value unchanged if it is not a BigNumber', () => {
      const key = 'testKey';
      const value = { some: 'object' };
      const result = ethersBigNumberSerializer(key, value);
      expect(result).to.equal(value);
    });

    it('should return the value unchanged if it is null', () => {
      const key = 'testKey';
      const value = null;
      const result = ethersBigNumberSerializer(key, value);
      expect(result).to.equal(value);
    });

    it('should return the value unchanged if it is not an object', () => {
      const key = 'testKey';
      const value = 'string';
      const result = ethersBigNumberSerializer(key, value);
      expect(result).to.equal(value);
    });
  });
});
