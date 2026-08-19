import { expect } from 'chai';
import { errors as EthersError } from 'ethers';

import { isDeterministicTimelockReadError } from './errors.js';

describe('timelock EVM errors', () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['direct nested code 3', { error: { code: 3 } }, true],
    ['double-nested code 3', { error: { error: { code: 3 } } }, true],
    [
      'body-encoded code 3',
      {
        error: {
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: 3, message: 'execution reverted' },
          }),
        },
      },
      true,
    ],
    ['nested transient call exception', { error: { code: -32000 } }, false],
  ];

  for (const [name, errorShape, expected] of cases) {
    it(`classifies ${name}`, () => {
      const error = Object.assign(new Error('execution reverted'), {
        code: EthersError.CALL_EXCEPTION,
        ...errorShape,
      });

      expect(isDeterministicTimelockReadError(error)).to.equal(expected);
    });
  }
});
