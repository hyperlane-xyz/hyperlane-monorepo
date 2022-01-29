import { expect } from 'chai';
import { ProxyNames } from '../proxyUtils';
import { OpticsContext } from 'optics-multi-provider-community';
import { CoreDeploy } from './CoreDeploy';
import { UpgradeBeaconViolation, Violation, ViolationType } from '../checks';
import { CoreInvariantChecker } from './checks';
import { Call, CallBatch } from 'optics-multi-provider-community/dist/optics/govern';

export class ImplementationUpgrader {
  private _deploys: CoreDeploy[];
  private _context: OpticsContext;
  private _checker: CoreInvariantChecker;
  private _violations: UpgradeBeaconViolation[];
  private _checked: boolean;

  constructor(deploys: CoreDeploy[], context: OpticsContext) {
    this._deploys = deploys;
    this._context = context;
    this._checker = new CoreInvariantChecker(this._deploys)
    this._violations = []
    this._checked = false;
  }

  async getViolations(): Promise<void> {
    await this._checker.checkDeploys()
    const other: Violation[] = []
    for (const v of this._checker.violations) {
      switch (v.type) {
        case ViolationType.UpgradeBeacon:
          this._violations.push(v)
          break;
        default:
          other.push(v)
          break;
      }
    }
    expect(other).to.be.empty;
  }

  expectViolations(names: ProxyNames[], count: number[]) {
    expect(names).to.have.lengthOf(count.length);
    names.forEach((name: ProxyNames, i: number) => {
      const matches = this._violations.filter((v) => v.name === name);
      expect(matches).to.have.lengthOf(count[i]);
    })
    const unmatched = this._violations.filter((v) => names.indexOf(v.name) === -1);
    expect(unmatched).to.be.empty;
    this._checked = true;
  }

  async createCallBatch(): Promise<CallBatch> {
    if (!this._checked)
      throw new Error('Must check invariants match expectation');
    const governorCore = await this._context.governorCore()
    const governanceMessages = await governorCore.newGovernanceBatch()
    for (const violation of this._violations) {
      const deploys = this._deploys.filter((d) => d.chain.domain == violation.domain)
      expect(deploys).to.have.lengthOf(1);
      const ubc = deploys[0].contracts.upgradeBeaconController;
      expect(ubc).to.not.be.undefined;
      const upgrade = await ubc!.populateTransaction.upgrade(
        violation.beaconProxy.beacon.address,
        violation.expected
      );
      if (upgrade.to === undefined) {
        throw new Error('Missing "to" field in populated transaction')
      }
      governanceMessages.push(violation.domain, upgrade as Call)
    }
    return governanceMessages;
  }
}

export function expectCalls(batch: CallBatch, domains: number[], count: number[]) {
  expect(domains).to.have.lengthOf(count.length);
  domains.forEach((domain: number, i: number) => {
    expect(batch.calls.get(domain)).to.have.lengthOf(count[i]);
  })
}
