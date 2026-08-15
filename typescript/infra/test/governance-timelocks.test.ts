import { expect } from 'chai';

import { GovernanceType } from '../src/governanceTypes.js';
import { getGovernanceTimelocks } from '../config/environments/mainnet3/governance/utils.js';

describe('mainnet3 governance timelocks', () => {
  it('associates the irregular Ethereum timelock with irregular governance', () => {
    expect(getGovernanceTimelocks(GovernanceType.Irregular)).to.deep.equal({
      ethereum: '0xfa842F02439AF6D91D7d44525956f9E5E00e339F',
    });
  });
});
