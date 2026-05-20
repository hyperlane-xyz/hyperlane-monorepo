import { expect } from 'chai';

import { isMissingSelectorCallException } from './contract.js';

function missingSelectorError(): Error & { code: string; data: string } {
  return Object.assign(new Error('call revert exception'), {
    code: 'CALL_EXCEPTION',
    data: '0x',
  });
}

function wrappedError(cause: Error): Error {
  return new Error('wrapped provider error', { cause });
}

describe('contract utils', () => {
  describe('isMissingSelectorCallException', () => {
    it('matches empty call exceptions', () => {
      expect(isMissingSelectorCallException(missingSelectorError())).to.equal(
        true,
      );
    });

    it('matches SmartProvider-wrapped empty call exceptions', () => {
      expect(
        isMissingSelectorCallException(wrappedError(missingSelectorError())),
      ).to.equal(true);
    });

    it('matches HyperlaneJsonRpcProvider empty responses', () => {
      expect(
        isMissingSelectorCallException(
          new Error('Invalid response from provider'),
        ),
      ).to.equal(true);
    });

    it('matches SmartProvider-wrapped empty provider responses', () => {
      expect(
        isMissingSelectorCallException(
          wrappedError(new Error('Invalid response from provider')),
        ),
      ).to.equal(true);
    });

    it('does not match non-call exceptions with formatted empty data', () => {
      expect(
        isMissingSelectorCallException(
          new Error('request failed with data="0x"'),
        ),
      ).to.equal(false);
    });
  });
});
