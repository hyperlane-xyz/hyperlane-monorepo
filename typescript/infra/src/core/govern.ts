// @ts-nocheck
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
} from './check';
import { CoreConfig } from './types';

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
    const manager = this.app.mustGetContracts(domain).validatorManager;
    expect(manager).to.not.be.undefined;
    const tx = await manager.populateTransaction.enrollValidator(
      violation.data.remote,
      violation.expected,
    );
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
