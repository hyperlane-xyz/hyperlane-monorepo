import { expect } from 'chai';
import { BigNumber } from 'ethers';

import { randomAddress } from '../../test/testUtils.js';
import {
  buildIcaCommitment,
  buildPostCallsPayload,
  commitmentFromIcaCalls,
} from './InterchainAccount.js';

describe('InterchainAccount helpers', () => {
  it('buildIcaCommitment returns encoded calls and matching commitment hash', () => {
    const salt = '0x' + '11'.repeat(32);
    const calls = [
      {
        to: randomAddress(),
        data: '0x1234',
        value: BigNumber.from(0),
      },
    ];

    const payload = buildIcaCommitment(calls, salt);

    expect(payload.encodedCalls.startsWith(salt)).to.equal(true);
    expect(payload.commitment).to.equal(commitmentFromIcaCalls(calls, salt));
  });

  it('buildPostCallsPayload preserves optional call values', () => {
    const calls = [
      {
        to: randomAddress(),
        data: '0x',
      },
      {
        to: randomAddress(),
        data: '0xabcd',
        value: BigNumber.from(42),
      },
    ];

    const payload = buildPostCallsPayload({
      calls,
      relayers: [randomAddress()],
      salt: '0x' + '22'.repeat(32),
      commitmentDispatchTx: '0x' + '33'.repeat(32),
      originDomain: 10,
    });

    expect(payload.calls).to.have.length(2);
    expect(payload.calls[0]).to.deep.equal({
      to: calls[0].to,
      data: calls[0].data,
    });
    expect(payload.calls[1]).to.deep.equal({
      to: calls[1].to,
      data: calls[1].data,
      value: '42',
    });
  });
});
