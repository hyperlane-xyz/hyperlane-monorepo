import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { type ExtendedSubmissionStrategy } from '../../../submitters/types.js';

import { getSubmitterChains, resolveChains } from './chainResolver.js';

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

describe('resolveChains — STATUS command', () => {
  const statusArgv = (overrides: Record<string, any> = {}) => ({
    _: ['status'],
    ...overrides,
  });

  it('returns only origin when origin provided', async () => {
    const result = await resolveChains(statusArgv({ origin: 'bsc' }));
    expect(result).to.deep.equal(['bsc']);
  });

  it('returns empty array when origin not provided', async () => {
    const result = await resolveChains(statusArgv());
    expect(result).to.deep.equal([]);
  });
});

describe('resolveChains — HOOK_APPLY command', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hook-apply-chains-'),
    );
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  function writeStrategy(
    strategy: Record<string, ExtendedSubmissionStrategy>,
  ): string {
    const filepath = path.join(temporaryDirectory, 'strategy.json');
    fs.writeFileSync(filepath, JSON.stringify(strategy));
    return filepath;
  }

  it('includes the ICA origin needed by its internal submitter', async () => {
    const strategy = writeStrategy({
      arbitrum: {
        submitter: {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT,
          chain: 'ethereum',
          destinationChain: 'arbitrum',
          owner: '0x0000000000000000000000000000000000000001',
          internalSubmitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: 'ethereum',
          },
        },
      },
    });

    expect(
      await resolveChains({
        _: ['hook', 'apply'],
        chain: 'arbitrum',
        strategy,
      }),
    ).to.deep.equal(['arbitrum', 'ethereum']);
  });

  it('does not provision chains from unrelated strategy entries', async () => {
    const strategy = writeStrategy({
      arbitrum: {
        submitter: { type: TxSubmitterType.JSON_RPC, chain: 'arbitrum' },
      },
      optimism: {
        submitter: {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT,
          chain: 'ethereum',
          destinationChain: 'optimism',
          owner: '0x0000000000000000000000000000000000000001',
          internalSubmitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: 'ethereum',
          },
        },
      },
    });

    expect(
      await resolveChains({
        _: ['hook', 'apply'],
        chain: 'arbitrum',
        strategy,
      }),
    ).to.deep.equal(['arbitrum']);
  });

  it('preserves direct submission without a strategy', async () => {
    expect(
      await resolveChains({ _: ['hook', 'apply'], chain: 'arbitrum' }),
    ).to.deep.equal(['arbitrum']);
  });
});
