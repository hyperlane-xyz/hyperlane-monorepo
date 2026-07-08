import { expect } from 'chai';

import { missingSelectorError, wrappedError } from '../test/errors.js';

import {
  isMissingSelectorCallException,
  isMissingSelectorRevert,
} from './contract.js';

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

    it('matches deeply wrapped empty call exceptions', () => {
      expect(
        isMissingSelectorCallException(
          wrappedError(wrappedError(missingSelectorError())),
        ),
      ).to.equal(true);
    });

    it('matches HyperlaneJsonRpcProvider empty responses', () => {
      expect(
        isMissingSelectorCallException(
          new Error('Invalid response from provider'),
        ),
      ).to.equal(true);
      expect(
        isMissingSelectorRevert(new Error('Invalid response from provider')),
      ).to.equal(false);
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
