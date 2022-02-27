import { expect } from 'chai';
import { AbacusContext } from '@abacus-network/sdk';
import { CoreDeploy } from './CoreDeploy';
import {
  HomeUpdaterViolation,
  ReplicaUpdaterViolation,
  UpgradeBeaconViolation,
  Violation,
  ViolationType,
} from '../checks';
import { Call, CallBatch } from '@abacus-network/sdk/dist/abacus/govern';

interface DomainedCall {
  domain: number;
  call: Call;
}

export class GovernanceCallBatchBuilder {
  private _deploys: CoreDeploy[];
  private _context: AbacusContext;
  private _violations: Violation[];

  constructor(
    deploys: CoreDeploy[],
    context: AbacusContext,
    violations: Violation[],
  ) {
    this._deploys = deploys;
    this._context = context;
    this._violations = violations;
  }

  async build(): Promise<CallBatch> {
    const governorCore = await this._context.governorCore();
    const batch = await governorCore.newGovernanceBatch();
    const txs = await Promise.all(
      this._violations.map((v) => this.handleViolation(v)),
    );
    txs.map((call) => batch.push(call.domain, call.call));
    return batch;
  }

  handleViolation(v: Violation): Promise<DomainedCall> {
    switch (v.type) {
      case ViolationType.UpgradeBeacon:
        return this.handleUpgradeBeaconViolation(v);
      case ViolationType.HomeUpdater:
        return this.handleHomeUpdaterViolation(v);
      case ViolationType.ReplicaUpdater:
        return this.handleReplicaUpdaterViolation(v);
      default:
        throw new Error(`No handler for violation type ${v.type}`);
        break;
    }
  }

  async handleUpgradeBeaconViolation(
    violation: UpgradeBeaconViolation,
  ): Promise<DomainedCall> {
    const domain = violation.domain;
    const deploy = this.getDeploy(domain);
    const ubc = deploy.contracts.upgradeBeaconController;
    if (ubc === undefined) throw new Error('Undefined ubc');
    const tx = await ubc.populateTransaction.upgrade(
      violation.beaconProxy.beacon.address,
      violation.expected,
    );
    if (tx.to === undefined) throw new Error('undefined tx.to');
    return { domain, call: tx as Call };
  }

  async handleHomeUpdaterViolation(
    violation: HomeUpdaterViolation,
  ): Promise<DomainedCall> {
    const domain = violation.domain;
    const deploy = this.getDeploy(domain);
    const manager = deploy.contracts.updaterManager;
    expect(manager).to.not.be.undefined;
    const tx = await manager!.populateTransaction.setUpdater(
      violation.expected,
    );
    if (tx.to === undefined) throw new Error('undefined tx.to');
    return { domain, call: tx as Call };
  }

  async handleReplicaUpdaterViolation(
    violation: ReplicaUpdaterViolation,
  ): Promise<DomainedCall> {
    const domain = violation.domain;
    const deploy = this.getDeploy(domain);
    const replica = deploy.contracts.replicas[violation.remoteDomain];
    expect(replica).to.not.be.undefined;
    const tx = await replica!.proxy.populateTransaction.setUpdater(
      violation.expected,
    );
    if (tx.to === undefined) throw new Error('undefined tx.to');
    return { domain, call: tx as Call };
  }

  getDeploy(domain: number): CoreDeploy {
    const deploys = this._deploys.filter((d) => d.chain.domain == domain);
    expect(deploys).to.have.lengthOf(1);
    return deploys[0];
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
