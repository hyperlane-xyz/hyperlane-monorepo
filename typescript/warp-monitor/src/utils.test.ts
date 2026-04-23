import { expect } from 'vitest';

import { tryFn } from '@hyperlane-xyz/utils';

import { getLogger, setLoggerBindings } from './utils.js';

describe('Warp Monitor Utils', () => {
  describe('getLogger', () => {
    it('should return a logger instance', () => {
      const logger = getLogger();
      expect(logger).toHaveProperty('info');
      expect(logger).toHaveProperty('warn');
      expect(logger).toHaveProperty('error');
    });
  });

  describe('setLoggerBindings', () => {
    it('should not throw when setting bindings', () => {
      expect(() => {
        setLoggerBindings({ warp_route: 'test-route' });
      }).not.toThrow();
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
      expect(executed).toBe(true);
    });

    // eslint-disable-next-line jest/expect-expect -- testing no-throw behavior
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
