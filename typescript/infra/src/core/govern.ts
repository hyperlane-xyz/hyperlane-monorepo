import { expect } from 'chai';
import { Call, AbacusCore, AbacusGovernance } from '@abacus-network/sdk';
import {
  CheckerViolation,
  ProxyViolationType,
  UpgradeBeaconViolation,
} from '@abacus-network/deploy';

import {
  AbacusCoreChecker,
  CoreViolationType,
  ValidatorViolation,
  ValidatorViolationType,
} from './check';
import { CoreConfig } from './types';
import { MultisigValidatorManager__factory } from '@abacus-network/core';
import { PopulatedTransaction } from 'ethers';

interface DomainedCall {
  domain: number;
  call: Call;
}

export class AbacusCoreGovernor extends AbacusCoreChecker {
  readonly governance: AbacusGovernance;

  constructor(
    app: AbacusCore,
    config: CoreConfig,
    governance: AbacusGovernance,
  ) {
    super(app, config);
    this.governance = governance;
  }

  async check(): Promise<void> {
    super.check(this.governance.routerAddresses);
    const txs = await Promise.all(
      this.violations.map((v) => this.handleViolation(v)),
    );
    txs.map((call) => this.governance.push(call.domain, call.call));
  }

  handleViolation(v: CheckerViolation): Promise<DomainedCall> {
    switch (v.type) {
      case ProxyViolationType.UpgradeBeacon:
        return this.handleUpgradeBeaconViolation(v as UpgradeBeaconViolation);
      case CoreViolationType.Validator:
        return this.handleValidatorViolation(v as ValidatorViolation);
      default:
        throw new Error(`No handler for violation type ${v.type}`);
        break;
    }
  }

  async handleUpgradeBeaconViolation(
    violation: UpgradeBeaconViolation,
  ): Promise<DomainedCall> {
    const domain = violation.domain;
    const ubc = this.app.mustGetContracts(domain).upgradeBeaconController;
    if (ubc === undefined) throw new Error('Undefined ubc');
    const tx = await ubc.populateTransaction.upgrade(
      violation.data.proxiedAddress.beacon,
      violation.expected,
    );
    if (tx.to === undefined) throw new Error('undefined tx.to');
    return { domain, call: tx as Call };
  }

  async handleValidatorViolation(
    violation: ValidatorViolation,
  ): Promise<DomainedCall> {
    const domain = violation.domain;
    const provider = this.app.mustGetProvider(domain);

    const validatorManager = MultisigValidatorManager__factory.connect(
      violation.data.validatorManagerAddress,
      provider,
    );

    let tx: PopulatedTransaction;

    switch (violation.data.type) {
      case ValidatorViolationType.EnrollValidator:
        // Enrolling a new validator
        tx = await validatorManager.populateTransaction.enrollValidator(
          violation.expected,
        );
        break;
      case ValidatorViolationType.UnenrollValidator:
        // Unenrolling an existing validator
        tx = await validatorManager.populateTransaction.unenrollValidator(
          violation.actual,
        );
        break;
      case ValidatorViolationType.Threshold:
        tx = await validatorManager.populateTransaction.setThreshold(
          violation.expected,
        );
        break;
      default:
        throw new Error(
          `Invalid validator violation type: ${violation.data.type}`,
        );
    }

    if (tx.to === undefined) throw new Error('undefined tx.to');
    return { domain, call: tx as Call };
  }

  expectCalls(domains: number[], count: number[]) {
    expect(domains).to.have.lengthOf(count.length);
    domains.forEach((domain: number, i: number) => {
      expect(this.governance.calls.get(domain)).to.have.lengthOf(count[i]);
    });
  }
}
