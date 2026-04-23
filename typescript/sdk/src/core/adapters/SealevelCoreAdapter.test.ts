import { expect } from 'vitest';

import { SealevelCoreAdapter } from './SealevelCoreAdapter.js';

describe('SealevelCoreAdapter', () => {
  describe('parses dispatch messages', () => {
    it('finds message id', async () => {
      expect(
        SealevelCoreAdapter.parseMessageDispatchLogs([
          'Dispatched message to 123, ID abc',
        ]),
      ).toEqual([{ destination: '123', messageId: 'abc' }]);
    });
    it('Skips invalid', async () => {
      expect(SealevelCoreAdapter.parseMessageDispatchLogs([])).toEqual([]);
      expect(
        SealevelCoreAdapter.parseMessageDispatchLogs(['foo', 'bar']),
      ).toEqual([]);
    });
  });
});
