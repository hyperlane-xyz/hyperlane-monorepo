import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { type ExtendedSubmissionStrategy } from '../../../submitters/types.js';

import { getSubmitterChains } from './chainResolver.js';

type Submitter = ExtendedSubmissionStrategy['submitter'];

describe('getSubmitterChains', () => {
  it('should return chain for a JSON_RPC submitter', () => {
    const submitter: Submitter = {
      type: TxSubmitterType.JSON_RPC,
      chain: 'ethereum',
    };
    expect(getSubmitterChains(submitter)).to.deep.equal(['ethereum']);
  });

  it('should return chain for a Gnosis Safe submitter', () => {
    const submitter: Submitter = {
      type: TxSubmitterType.GNOSIS_SAFE,
      chain: 'arbitrum',
      safeAddress: '0x0000000000000000000000000000000000000001',
    };
    expect(getSubmitterChains(submitter)).to.deep.equal(['arbitrum']);
  });

  it('should return origin, destination, and internal submitter chains for an ICA submitter', () => {
    const submitter: Submitter = {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: 'ethereum',
      owner: '0x0000000000000000000000000000000000000001',
      destinationChain: 'arbitrum',
      internalSubmitter: {
        type: TxSubmitterType.JSON_RPC,
        chain: 'ethereum',
      },
    };
    expect(getSubmitterChains(submitter)).to.deep.equal([
      'ethereum',
      'arbitrum',
      'ethereum',
    ]);
  });

  it('should return chain and proposer submitter chains for a Timelock submitter', () => {
    const submitter: Submitter = {
      type: TxSubmitterType.TIMELOCK_CONTROLLER,
      chain: 'optimism',
      timelockAddress: '0x0000000000000000000000000000000000000002',
      proposerSubmitter: {
        type: TxSubmitterType.JSON_RPC,
        chain: 'optimism',
      },
    };
    const result = getSubmitterChains(submitter);
    expect(result).to.deep.equal(['optimism', 'optimism']);
  });

  it('should handle nested ICA with Gnosis Safe internal submitter', () => {
    const submitter: Submitter = {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: 'ethereum',
      owner: '0x0000000000000000000000000000000000000001',
      destinationChain: 'arbitrum',
      internalSubmitter: {
        type: TxSubmitterType.GNOSIS_SAFE,
        chain: 'ethereum',
        safeAddress: '0x0000000000000000000000000000000000000003',
      },
    };
    expect(getSubmitterChains(submitter)).to.deep.equal([
      'ethereum',
      'arbitrum',
      'ethereum',
    ]);
  });
});
