import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  OwnableState,
  buildChainHandoffPlan,
  collectOwnableCandidates,
  finalizeHandoffPlan,
} from '../src/govern/core-ownership-handoff.js';
import { GovernanceType } from '../src/governanceTypes.js';

const deployer = '0x1111111111111111111111111111111111111111';
const ica = '0x2222222222222222222222222222222222222222';
const safe = '0x3333333333333333333333333333333333333333';
const target = '0x4444444444444444444444444444444444444444';

function state(
  labels: string[],
  owner: string,
  address: string,
  beneficiary?: string,
): OwnableState {
  return {
    labels,
    owner,
    address,
    beneficiary,
    ownershipMode: 'one-step',
  };
}

describe('core ownership handoff', () => {
  it('deduplicates registry aliases and applies explicit additions', () => {
    const { candidates, missingRegistryLabels } = collectOwnableCandidates(
      {
        mailbox: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        proxyAdmin: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        zero: ethers.constants.AddressZero,
        metadata: 'not-an-address',
      },
      {
        customOwnable: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    );

    expect(candidates).to.deep.equal([
      {
        address: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB',
        labels: ['customOwnable'],
      },
      {
        address: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa',
        labels: ['mailbox', 'proxyAdmin'],
      },
    ]);
    expect(missingRegistryLabels).to.include('protocolFee');
  });

  it('rejects additional contract labels that replace registry addresses', () => {
    expect(() =>
      collectOwnableCandidates(
        { mailbox: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { mailbox: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      ),
    ).to.throw('conflicts with registry address');
  });

  it('routes deployer, ICA, and Safe calls and orders beneficiary updates first', () => {
    const plan = buildChainHandoffPlan({
      chain: 'example',
      target,
      targetType: 'eoa',
      deployer,
      sourceIca: ica,
      sourceSafe: safe,
      states: [
        state(
          ['interchainGasPaymaster'],
          deployer,
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          deployer,
        ),
        state(['mailbox'], ica, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        state(
          ['proxyAdmin'],
          safe,
          '0xcccccccccccccccccccccccccccccccccccccccc',
        ),
        state(
          ['validatorAnnounce'],
          target,
          '0xdddddddddddddddddddddddddddddddddddddddd',
        ),
      ],
    });

    expect(plan.calls.deployer.map((call) => call.operation)).to.deep.equal([
      'setBeneficiary',
      'transferOwnership',
    ]);
    expect(plan.calls.ica.map((call) => call.operation)).to.deep.equal([
      'transferOwnership',
    ]);
    expect(plan.calls.safe.map((call) => call.operation)).to.deep.equal([
      'transferOwnership',
    ]);
    expect(plan.alreadyOwned).to.have.lengthOf(1);
  });

  it('fails closed on an unexpected owner', () => {
    expect(() =>
      buildChainHandoffPlan({
        chain: 'example',
        target,
        targetType: 'eoa',
        deployer,
        sourceIca: ica,
        sourceSafe: safe,
        states: [
          state(
            ['mailbox'],
            '0x5555555555555555555555555555555555555555',
            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ),
        ],
      }),
    ).to.throw('unexpected owner');
  });

  it('fails closed on two-step ownership', () => {
    const ownable = state(
      ['mailbox'],
      deployer,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    ownable.ownershipMode = 'two-step';

    expect(() =>
      buildChainHandoffPlan({
        chain: 'example',
        target,
        targetType: 'eoa',
        deployer,
        sourceIca: ica,
        states: [ownable],
      }),
    ).to.throw('uses two-step ownership');
  });

  it('requires beneficiary completion when ownership already moved', () => {
    expect(() =>
      buildChainHandoffPlan({
        chain: 'example',
        target,
        targetType: 'eoa',
        deployer,
        sourceIca: ica,
        states: [
          state(
            ['protocolFee'],
            target,
            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            deployer,
          ),
        ],
      }),
    ).to.throw('already target-owned but beneficiary');
  });

  it('produces a deterministic plan hash', () => {
    const input = {
      environment: 'mainnet3' as const,
      governance: {
        origin: 'ethereum',
        type: GovernanceType.Regular,
        safe,
      },
      chains: [],
    };

    expect(finalizeHandoffPlan(input).hash).to.equal(
      finalizeHandoffPlan(input).hash,
    );
  });

  it('binds the plan hash to the fully encoded ICA call', () => {
    const chainPlan = buildChainHandoffPlan({
      chain: 'example',
      target,
      targetType: 'eoa',
      deployer,
      sourceIca: ica,
      states: [
        state(['mailbox'], ica, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      ],
    });
    const basePlan = {
      environment: 'mainnet3' as const,
      governance: {
        origin: 'ethereum',
        type: GovernanceType.Regular,
        safe,
      },
      chains: [chainPlan],
    };
    const first = finalizeHandoffPlan({
      ...basePlan,
      chains: [
        {
          ...chainPlan,
          icaCall: {
            to: safe,
            data: '0x01',
            value: '1',
            description: 'first',
          },
        },
      ],
    });
    const second = finalizeHandoffPlan({
      ...basePlan,
      chains: [
        {
          ...chainPlan,
          icaCall: {
            to: safe,
            data: '0x02',
            value: '1',
            description: 'first',
          },
        },
      ],
    });

    expect(first.hash).not.to.equal(second.hash);
  });
});
