import { expect } from 'chai';

import { getReadRpcRevert } from './jsonRpcError.js';

describe('getReadRpcRevert', () => {
  for (const method of ['eth_call', 'eth_estimateGas']) {
    for (const code of [3, -32000]) {
      it(`recognizes code ${code} reverts for ${method} in flat and ethers-wrapped errors`, () => {
        const rpcError = {
          code,
          message: 'execution reverted: denied',
          data: '0x1234',
        };
        for (const error of [
          rpcError,
          { code: 'SERVER_ERROR', error: rpcError },
          { code: 'SERVER_ERROR', body: JSON.stringify({ error: rpcError }) },
        ]) {
          expect(getReadRpcRevert(error, method)).to.deep.equal(rpcError);
        }
      });
    }
  }

  it('recognizes a definitive code-3 revert without data', () => {
    expect(getReadRpcRevert({ code: 3 }, 'eth_call')).to.deep.equal({
      code: 3,
      message: 'execution reverted',
      data: undefined,
    });
  });

  it('does not treat other RPC methods as contract execution', () => {
    expect(
      getReadRpcRevert({ code: 3, data: '0x1234' }, 'seismic_getTeePublicKey'),
    ).to.equal(undefined);
  });

  it('does not mistake rate limits or incomplete -32000 errors for reverts', () => {
    for (const error of [
      { code: -32000, message: 'rate limit exceeded', data: '0x1234' },
      { code: -32005, message: 'execution reverted', data: '0x1234' },
      { code: -32000, message: 'execution reverted' },
      { code: -32000, message: 'execution reverted', data: '0x' },
      { code: -32000, message: 'execution reverted', data: 'not hex' },
      { code: -32000, message: 'execution revertedness', data: '0x1234' },
      new Error('connection unavailable'),
    ]) {
      expect(getReadRpcRevert(error, 'eth_call')).to.equal(undefined);
    }
  });
});
