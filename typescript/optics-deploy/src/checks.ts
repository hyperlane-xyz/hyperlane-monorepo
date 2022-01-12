import { ExistingCoreDeploy } from './core/CoreDeploy';
import { checkCoreDeploy } from './core/checks';
import { ExistingDeployConfig } from './config';
import { UpgradeBeacon, UpgradeBeaconController } from '@optics-xyz/ts-interface/dist/optics-core';

export async function checkCoreDeploys(
  path: string,
  configs: ExistingDeployConfig[],
  governorDomain: number,
  invariantViolationHandler: InvariantViolationHandler
) {
  const coreDeploys = configs.map(
    (_) => new ExistingCoreDeploy(path, _.chain, _.coreConfig),
  );

  const checkDeploy = async (deploy: ExistingCoreDeploy) => {
    const remoteDomains = coreDeploys.filter(_ => _.chain.domain !== deploy.chain.domain).map(_ => _.chain.domain)

    console.info(`Checking core deploy on ${deploy.chain.name}`)
    return checkCoreDeploy(deploy, remoteDomains, governorDomain, invariantViolationHandler)
  }

  await Promise.all(coreDeploys.map(checkDeploy))
}

export enum InvariantViolationType {
  ProxyBeacon
}

interface ProxyBeaconInvariantViolation {
  domain: number
  upgradeBeaconController: UpgradeBeaconController,
  type: InvariantViolationType.ProxyBeacon,
  beacon: UpgradeBeacon,
  configImplementationAddress: string
  onChainImplementationAddress: string
}

type InvariantViolation = ProxyBeaconInvariantViolation

export type InvariantViolationHandler = (violation: InvariantViolation) => void

export const assertInvariantViolation = (violation: InvariantViolation) => {
  switch (violation.type) {
    case InvariantViolationType.ProxyBeacon:
      throw new Error(`BeaconProxy at ${violation.beacon.address} should point to implementation at ${violation.configImplementationAddress}, instead points to ${violation.onChainImplementationAddress}`)
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
  handleViolation = (violation: InvariantViolation) => {
    this.violations.push(violation)
  }
}