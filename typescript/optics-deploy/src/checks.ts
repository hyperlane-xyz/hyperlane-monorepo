import { CoreDeploy } from './core/CoreDeploy';
import { checkCoreDeploy } from './core/checks';
import { UpgradeBeacon, UpgradeBeaconController } from '@optics-xyz/ts-interface/dist/optics-core';

export async function checkCoreDeploys(
  coreDeploys: CoreDeploy[],
  governorDomain: number,
  invariantViolationHandler: InvariantViolationHandler
) {
  const checkDeploy = async (deploy: CoreDeploy) => {
    const remoteDomains = coreDeploys.filter(_ => _.chain.domain !== deploy.chain.domain).map(_ => _.chain.domain)

    console.info(`Checking core deploy on ${deploy.chain.name}`)
    return checkCoreDeploy(deploy, remoteDomains, governorDomain, invariantViolationHandler)
  }

  await Promise.all(coreDeploys.map(checkDeploy))
}

export enum InvariantViolationType {
  UpgradeBeacon
}

interface UpgradeBeaconInvariantViolation {
  domain: number
  upgradeBeaconController: UpgradeBeaconController,
  type: InvariantViolationType.UpgradeBeacon,
  beacon: UpgradeBeacon,
  expectedImplementationAddress: string
  actualImplementationAddress: string
}

export type InvariantViolation = UpgradeBeaconInvariantViolation

export type InvariantViolationHandler = (violation: InvariantViolation) => void

export const assertInvariantViolation = (violation: InvariantViolation) => {
  switch (violation.type) {
    case InvariantViolationType.UpgradeBeacon:
      throw new Error(`Expected BeaconProxy at address at ${violation.beacon.address} to point to implementation at ${violation.expectedImplementationAddress}, found ${violation.actualImplementationAddress}`)
      break;
    default:
      break;
  }
  return violation
}

export class InvariantViolationCollector {
  violations: InvariantViolation[];

  constructor() {
    this.violations = []
  }

  // Declare method this way to retain scope
  handleViolation = (v: InvariantViolation) => {
    const duplicateIndex = this.violations.findIndex((m: InvariantViolation) =>
      m.domain === v.domain &&
      m.actualImplementationAddress === v.actualImplementationAddress &&
      m.expectedImplementationAddress === v.expectedImplementationAddress
    )
    if (duplicateIndex !== -1)
      this.violations.push(v);
  }
}
