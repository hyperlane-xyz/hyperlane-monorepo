import { expect } from 'chai';
import { OpticsContext } from 'optics-multi-provider-community';
import { CoreDeploy } from './CoreDeploy';
import { HomeUpdaterViolation, ReplicaUpdaterViolation, UpgradeBeaconViolation, Violation, ViolationType } from '../checks';
import { Call, CallBatch } from 'optics-multi-provider-community/dist/optics/govern';
import { PopulatedTransaction} from 'ethers';

interface DomainedTransaction {
  domain: number
  call: PopulatedTransaction
}

export class GovernanceCallBatchBuilder {
  private _deploys: CoreDeploy[];
  private _context: OpticsContext;
  private _violations: Violation[];

  constructor(deploys: CoreDeploy[], context: OpticsContext, violations: Violation[]) {
    this._deploys = deploys;
    this._context = context;
    this._violations = violations
  }

  async build(): Promise<CallBatch> {
    const governorCore = await this._context.governorCore()
    const batch = await governorCore.newGovernanceBatch()
    const calls = await Promise.all(this._violations.map(this.handleViolation))
    calls.map((call) => expect(call.call.to).to.not.be.undefined)
    calls.map((call) => batch.push(call.domain, call.call as Call))
    return batch
  }

  handleViolation(v: Violation): Promise<DomainedTransaction> {
    switch (v.type) {
      case ViolationType.UpgradeBeacon:
        return this.handleUpgradeBeaconViolation(v)
      case ViolationType.HomeUpdater:
        return this.handleHomeUpdaterViolation(v)
      case ViolationType.ReplicaUpdater:
        return this.handleReplicaUpdaterViolation(v)
      default:
        throw new Error(`No handler for violation type ${v.type}`)
        break;
    }
  }

  async handleUpgradeBeaconViolation(violation: UpgradeBeaconViolation): Promise<DomainedTransaction> {
    const domain = violation.domain
    const deploy = this.getDeploy(domain)
    const ubc = deploy.contracts.upgradeBeaconController;
    expect(ubc).to.not.be.undefined;
    const call = await ubc!.populateTransaction.upgrade(
      violation.beaconProxy.beacon.address,
      violation.expected
    );
    return { domain, call }
  }

  async handleHomeUpdaterViolation(violation: HomeUpdaterViolation): Promise<DomainedTransaction> {
    const domain = violation.domain
    const deploy = this.getDeploy(domain)
    const manager = deploy.contracts.updaterManager;
    expect(manager).to.not.be.undefined;
    const call = await manager!.populateTransaction.setUpdater(
      violation.expected
    );
    return { domain, call }
  }

  async handleReplicaUpdaterViolation(violation: ReplicaUpdaterViolation): Promise<DomainedTransaction> {
    const domain = violation.domain
    const deploy = this.getDeploy(domain)
    const replica = deploy.contracts.replicas[violation.remoteDomain];
    expect(replica).to.not.be.undefined;
    const call = await replica!.proxy.populateTransaction.setUpdater(
      violation.expected
    );
    return { domain, call }
  }

  getDeploy(domain: number): CoreDeploy {
    const deploys = this._deploys.filter((d) => d.chain.domain == domain)
    expect(deploys).to.have.lengthOf(1);
    return deploys[0]
  }
}

export function expectCalls(batch: CallBatch, domains: number[], count: number[]) {
  expect(domains).to.have.lengthOf(count.length);
  domains.forEach((domain: number, i: number) => {
    expect(batch.calls.get(domain)).to.have.lengthOf(count[i]);
  })
}
