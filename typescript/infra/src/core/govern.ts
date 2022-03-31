import { expect } from 'chai';
import {
  Call,
  CallBatch,
  AbacusCore,
  AbacusGovernance,
} from '@abacus-network/sdk';
import { CheckerViolation, CommonViolationType, ProxiedContractViolation } from '@abacus-network/deploy';

import { AbacusCoreChecker, CoreViolationType, ValidatorViolation } from './check';
import { CoreConfig } from './types';

interface DomainedCall {
  domain: number;
  call: Call;
}

export class AbacusCoreGovernor extends AbacusCoreChecker {
  readonly governance: AbacusGovernance;

  constructor(app: AbacusCore, config: CoreConfig, governance: AbacusGovernance) {
    super(app, config, governance.routerAddresses);
    this.governance = governance;
  }

  async build(): Promise<CallBatch> {
    const governor = await this.governance.governor();
    const batch = new CallBatch(
      governor.domain,
      this.governance.mustGetContracts(governor.domain),
    );
    const txs = await Promise.all(
      this.violations.map((v) => this.handleViolation(v)),
    );
    txs.map((call) => batch.push(call.domain, call.call));
    return batch;
  }

  handleViolation(v: CheckerViolation): Promise<DomainedCall> {
    switch (v.type) {
      case CommonViolationType.ProxiedContract:
        return this.handleProxiedContractViolation(v as ProxiedContractViolation);
      case CoreViolationType.Validator:
        return this.handleValidatorViolation(v as ValidatorViolation);
      default:
        throw new Error(`No handler for violation type ${v.type}`);
        break;
    }
  }

  async handleProxiedContractViolation(
    violation: ProxiedContractViolation,
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
}

export function expectCalls(
  batch: CallBatch,
  domains: number[],
  count: number[],
) {
  expect(domains).to.have.lengthOf(count.length);
  domains.forEach((domain: number, i: number) => {
    expect(batch.calls.get(domain)).to.have.lengthOf(count[i]);
  });
}
