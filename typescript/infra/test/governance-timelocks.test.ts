import { expect } from 'chai';
import { isValidAddressEvm } from '@hyperlane-xyz/utils';

import { GovernanceType } from '../src/governanceTypes.js';
import { getGovernanceTimelocks } from '../config/environments/mainnet3/governance/utils.js';

describe('mainnet3 governance timelocks', () => {
  it('associates the irregular Ethereum timelock with irregular governance', () => {
    const timelocks = getGovernanceTimelocks(GovernanceType.Irregular);
    expect(timelocks).to.deep.equal({
      ethereum: '0xfA842f02439Af6d91d7D44525956F9E5e00e339f',
    });
    expect(isValidAddressEvm(timelocks.ethereum!)).to.equal(true);
  });
});
