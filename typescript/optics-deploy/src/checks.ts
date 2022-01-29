import { expect } from 'chai';
import { Contract, ethers } from 'ethers';
import { Deploy } from './deploy';
import { ProxyNames, BeaconProxy } from './proxyUtils';
import { UpgradeBeaconController } from 'optics-ts-interface/dist/optics-core';

export enum InvariantViolationType {
  UpgradeBeacon
}

interface UpgradeBeaconInvariantViolation {
  domain: number
  name: ProxyNames
  upgradeBeaconController: UpgradeBeaconController,
  type: InvariantViolationType.UpgradeBeacon,
  beaconProxy: BeaconProxy<ethers.Contract>,
  expectedImplementationAddress: string
  actualImplementationAddress: string
}

export type InvariantViolation = UpgradeBeaconInvariantViolation

export type InvariantViolationHandler = (violation: InvariantViolation) => void

export const assertInvariantViolation = (violation: InvariantViolation) => {
  switch (violation.type) {
    case InvariantViolationType.UpgradeBeacon:
      throw new Error(`Expected UpgradeBeacon at address at ${violation.beaconProxy.beacon.address} to point to implementation at ${violation.expectedImplementationAddress}, found ${violation.actualImplementationAddress}`)
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
    if (duplicateIndex === -1)
      this.violations.push(v);
  }
}

export function checkVerificationInput(
  deploy: Deploy<any>,
  name: string,
  addr: string,
) {
  const match = deploy.verificationInput.find(
    (contract) => contract.name == name && contract.address === addr
  )
  expect(match).to.not.be.undefined;
}

export function assertBeaconProxy(beaconProxy: BeaconProxy<Contract>) {
  expect(beaconProxy.beacon).to.not.be.undefined;
  expect(beaconProxy.proxy).to.not.be.undefined;
  expect(beaconProxy.implementation).to.not.be.undefined;
}

export async function checkBeaconProxyImplementation(
  domain: number,
  name: ProxyNames,
  upgradeBeaconController: UpgradeBeaconController,
  beaconProxy: BeaconProxy<Contract>,
  invariantViolationHandler: InvariantViolationHandler,
) {
  assertBeaconProxy(beaconProxy)

  // Assert that the implementation is actually set
  const provider = beaconProxy.beacon.provider;
  const storageValue = await provider.getStorageAt(
    beaconProxy.beacon.address,
    0,
  );
  const actualImplementationAddress = ethers.utils.getAddress(
    storageValue.slice(26),
  );

  if (actualImplementationAddress != beaconProxy.implementation.address) {
    invariantViolationHandler({
      type: InvariantViolationType.UpgradeBeacon,
      name,
      domain,
      upgradeBeaconController,
      beaconProxy,
      actualImplementationAddress,
      expectedImplementationAddress: beaconProxy.implementation.address,
    });
  }
}

