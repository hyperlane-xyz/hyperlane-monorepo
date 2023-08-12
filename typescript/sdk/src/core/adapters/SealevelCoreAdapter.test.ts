import { expect } from 'chai';

import { SealevelCoreAdapter } from './SealevelCoreAdapter';

describe('SealevelCoreAdapter', () => {
  describe('parses dispatch messages', () => {
    it('finds message id', async () => {
      expect(
        SealevelCoreAdapter.parseMessageDispatchLogs([
          'Dispatched message to 123, ID abc',
        ]),
      ).to.eql({ destination: '123', messageId: 'abc' });
    });
    it('Skips invalid', async () => {
      expect(SealevelCoreAdapter.parseMessageDispatchLogs([])).to.be.undefined;
      expect(SealevelCoreAdapter.parseMessageDispatchLogs(['foo', 'bar'])).to.be
        .undefined;
    });
  });
});
