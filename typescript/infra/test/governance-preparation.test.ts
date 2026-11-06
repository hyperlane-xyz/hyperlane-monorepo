import { expect } from 'chai';
import { BigNumber } from 'ethers';

import {
  CoreConfig,
  HyperlaneCore,
  HyperlaneCoreChecker,
  HyperlaneIsmFactory,
  InterchainAccount,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { HyperlaneAppGovernor } from '../src/govern/HyperlaneAppGovernor.js';
import { HyperlaneHaasGovernor } from '../src/govern/HyperlaneHaasGovernor.js';
import { HyperlaneICAChecker } from '../src/govern/HyperlaneICAChecker.js';
import { SubmissionType } from '../src/govern/types.js';

class PreparationGovernor extends HyperlaneAppGovernor<
  HyperlaneCore,
  CoreConfig
> {
  submitted = false;

  constructor() {
    const mp = MultiProvider.createTestMultiProvider();
    const core = new HyperlaneCore({}, mp);
    super(
      new HyperlaneCoreChecker(
        mp,
        core,
        {},
        new HyperlaneIsmFactory({}, mp),
        {},
      ),
    );
  }

  protected override async mapViolationToCall() {
    return undefined;
  }

  protected override async mapViolationsToCalls() {
    this.pushCall('test1', {
      to: '0x0000000000000000000000000000000000000001',
      data: '0x1234',
      value: BigNumber.from(7),
      description: 'review-only call',
    });
  }

  protected override async inferCallSubmissionTypes() {
    for (const call of this.calls.test1)
      call.submissionType = SubmissionType.SAFE;
  }

  protected override async sendCalls() {
    this.submitted = true;
  }
}

describe('governance call preparation', () => {
  it('scopes both core and ICA violations before preparing a HAAS plan', () => {
    const mp = MultiProvider.createTestMultiProvider();
    const coreChecker = new HyperlaneCoreChecker(
      mp,
      new HyperlaneCore({}, mp),
      {},
      new HyperlaneIsmFactory({}, mp),
      {},
    );
    const ica = new InterchainAccount({}, mp);
    const icaChecker = new HyperlaneICAChecker(mp, ica, {});
    for (const checker of [coreChecker, icaChecker]) {
      checker.addViolation({
        chain: 'test1',
        type: 'keep',
        actual: 0,
        expected: 1,
      });
      checker.addViolation({
        chain: 'test2',
        type: 'exclude',
        actual: 0,
        expected: 1,
      });
    }
    const governor = new HyperlaneHaasGovernor(ica, icaChecker, coreChecker);
    governor.selectViolations((violation) =>
      violation.type === 'keep' ? { ...violation, expected: 2 } : undefined,
    );
    expect(governor.getCheckerViolations()).to.have.length(2);
    expect(coreChecker.violations.map((v) => v.expected)).to.deep.equal([2]);
    expect(icaChecker.violations.map((v) => v.expected)).to.deep.equal([2]);
  });

  it('prepares reviewable Safe calls without submitting transactions', async () => {
    const governor = new PreparationGovernor();
    const calls = await governor.prepareGovernanceCalls();
    expect(calls.test1).to.have.length(1);
    expect(calls.test1[0].submissionType).to.equal(SubmissionType.SAFE);
    expect(calls.test1[0].value?.toString()).to.equal('7');
    expect(governor.submitted).to.equal(false);
  });

  it('does not duplicate calls when a plan is prepared again', async () => {
    const governor = new PreparationGovernor();
    await governor.prepareGovernanceCalls();
    const calls = await governor.prepareGovernanceCalls();
    expect(calls.test1).to.have.length(1);
    expect(governor.submitted).to.equal(false);
  });
});
