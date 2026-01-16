import { expect } from 'chai';

import { tryFn } from '@hyperlane-xyz/metrics';

import { getLogger, setLoggerBindings } from './utils.js';

describe('Warp Monitor Utils', () => {
  describe('getLogger', () => {
    it('should return a logger instance', () => {
      const logger = getLogger();
      expect(logger).to.have.property('info');
      expect(logger).to.have.property('warn');
      expect(logger).to.have.property('error');
    });
  });

  describe('setLoggerBindings', () => {
    it('should not throw when setting bindings', () => {
      expect(() =>
        setLoggerBindings({ warp_route: 'test-route' }),
      ).to.not.throw();
    });
  });

  describe('tryFn', () => {
    it('should execute the function successfully', async () => {
      const logger = getLogger();
      let executed = false;
      await tryFn(
        async () => {
          executed = true;
        },
        'test context',
        logger,
      );
      expect(executed).to.be.true;
    });

    it('should catch and log errors without throwing', async () => {
      const logger = getLogger();
      const errorFn = async () => {
        throw new Error('Test error');
      };

      // Should not throw
      await tryFn(errorFn, 'error test context', logger);
    });
  });
});
