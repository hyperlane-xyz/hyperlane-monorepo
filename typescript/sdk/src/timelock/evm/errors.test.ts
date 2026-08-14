import { expect } from 'chai';
import { errors as EthersError } from 'ethers';

import { isDeterministicTimelockReadError } from './errors.js';

describe('timelock EVM errors', () => {
  it('classifies direct nested JSON-RPC code 3 call exceptions as deterministic', () => {
    const error = Object.assign(new Error('execution reverted'), {
      code: EthersError.CALL_EXCEPTION,
      error: { code: 3 },
    });

    expect(isDeterministicTimelockReadError(error)).to.equal(true);
  });

  it('classifies double-nested JSON-RPC code 3 call exceptions as deterministic', () => {
    const error = Object.assign(new Error('execution reverted'), {
      code: EthersError.CALL_EXCEPTION,
      error: { error: { code: 3 } },
    });

    expect(isDeterministicTimelockReadError(error)).to.equal(true);
  });

  it('classifies body-encoded JSON-RPC code 3 call exceptions as deterministic', () => {
    const error = Object.assign(new Error('execution reverted'), {
      code: EthersError.CALL_EXCEPTION,
      error: {
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: 3, message: 'execution reverted' },
        }),
      },
    });

    expect(isDeterministicTimelockReadError(error)).to.equal(true);
  });

  it('does not classify nested transient call exceptions as deterministic', () => {
    const error = Object.assign(new Error('missing revert data'), {
      code: EthersError.CALL_EXCEPTION,
      error: { code: -32000 },
    });

    expect(isDeterministicTimelockReadError(error)).to.equal(false);
  });
});
