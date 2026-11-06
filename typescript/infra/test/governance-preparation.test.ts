import { rejects } from 'node:assert/strict';

import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import { Mailbox__factory } from '@hyperlane-xyz/core';

import {
  CoreConfig,
  CoreViolationType,
  HyperlaneCore,
  HyperlaneCoreChecker,
  HyperlaneIsmFactory,
  InterchainAccount,
  IsmType,
  MailboxViolation,
  MailboxViolationType,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { HyperlaneAppGovernor } from '../src/govern/HyperlaneAppGovernor.js';
import { HyperlaneCoreGovernor } from '../src/govern/HyperlaneCoreGovernor.js';
import { HyperlaneHaasGovernor } from '../src/govern/HyperlaneHaasGovernor.js';
import { HyperlaneICAChecker } from '../src/govern/HyperlaneICAChecker.js';
import { AnnotatedCallData, SubmissionType } from '../src/govern/types.js';

class PreparationGovernor extends HyperlaneAppGovernor<
  HyperlaneCore,
  CoreConfig
> {
  submitted = false;
  failInference = false;

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

  protected override async inferCallSubmissionType(
    chain: string,
    call: AnnotatedCallData,
  ) {
    if (this.failInference) throw new Error('Submission inference failed');
    return { chain, call, type: SubmissionType.SAFE };
  }

  protected override async sendCalls() {
    this.submitted = true;
  }
}

describe('governance call preparation', () => {
  afterEach(() => sinon.restore());

  it('rejects a failed submission inference instead of returning a partial plan', async () => {
    const governor = new PreparationGovernor();
    governor.failInference = true;
    await rejects(
      governor.prepareGovernanceCalls(),
      /Submission inference failed/,
    );
    expect(governor.submitted).to.equal(false);
  });

  it('rejects unprovisioned core and HAAS ISMs before invoking the deployer', async () => {
    const mp = MultiProvider.createTestMultiProvider();
    const factory = new HyperlaneIsmFactory({}, mp);
    const deploy = sinon
      .stub(factory, 'deploy')
      .rejects(new Error('Deployment attempted'));
    const checker = new HyperlaneCoreChecker(
      mp,
      new HyperlaneCore({}, mp),
      {},
      factory,
      {},
    );
    const violation: MailboxViolation = {
      chain: 'test1',
      type: CoreViolationType.Mailbox,
      subType: MailboxViolationType.DefaultIsm,
      contract: Mailbox__factory.connect(
        '0x0000000000000000000000000000000000000001',
        mp.getProvider('test1'),
      ),
      actual: '0x0000000000000000000000000000000000000002',
      expected: { type: IsmType.TEST_ISM },
    };
    checker.addViolation(violation);
    const coreGovernor = new HyperlaneCoreGovernor(checker);
    const ica = new InterchainAccount({}, mp);
    const haasGovernor = new HyperlaneHaasGovernor(
      ica,
      new HyperlaneICAChecker(mp, ica, {}),
      checker,
    );
    await rejects(
      coreGovernor.prepareGovernanceCalls(),
      /ISM deployment required/,
    );
    await rejects(
      haasGovernor.prepareGovernanceCalls(),
      /ISM deployment required/,
    );
    expect(deploy.called).to.equal(false);
    // The explicitly authorized governance path retains provisioning support.
    await rejects(
      coreGovernor.prepareGovernanceCalls({ allowDeployments: true }),
      /Deployment attempted/,
    );
    expect(deploy.calledOnce).to.equal(true);
  });

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
