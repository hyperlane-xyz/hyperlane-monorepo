import { expect } from 'chai';
import { PopulatedTransaction } from 'ethers';

import { MultisigValidatorManager__factory } from '@abacus-network/core';
import {
  CheckerViolation,
  ProxyViolationType,
  UpgradeBeaconViolation,
} from '@abacus-network/deploy';
import {
  AbacusCore,
  AbacusGovernance,
  Call,
  ChainName,
  MultiProvider,
} from '@abacus-network/sdk';

import {
  AbacusCoreChecker,
  CoreViolationType,
  ValidatorViolation,
  ValidatorViolationType,
} from './check';
import { CoreConfig } from './types';

interface DomainedCall {
  network: ChainName;
  call: Call;
}

export class AbacusCoreGovernor<
  Networks extends ChainName,
> extends AbacusCoreChecker<Networks> {
  readonly governance: AbacusGovernance<Networks>;

  constructor(
    multiProvider: MultiProvider<Networks>,
    app: AbacusCore<Networks>,
    governance: AbacusGovernance<Networks>,
    config: CoreConfig<Networks>,
  ) {
    super(multiProvider, app, config);
    this.governance = governance;
  }

  async check(): Promise<void> {
    super.checkOwners(this.governance.routerAddresses());
    const txs = await Promise.all(
      this.violations.map((v) => this.handleViolation(v)),
    );
    txs.map((call) =>
      this.governance.pushCall(call.network as Networks, call.call),
    );
  }

  handleViolation(v: CheckerViolation): Promise<DomainedCall> {
    switch (v.type) {
      case ProxyViolationType.UpgradeBeacon:
        return this.handleUpgradeBeaconViolation(v as UpgradeBeaconViolation);
      case CoreViolationType.Validator:
        return this.handleValidatorViolation(v as ValidatorViolation);
      default:
        throw new Error(`No handler for violation type ${v.type}`);
    }
  }

  async handleUpgradeBeaconViolation(
    violation: UpgradeBeaconViolation,
  ): Promise<DomainedCall> {
    const network = violation.network;
    const ubc = this.app.getContracts(
      network as Networks,
    ).upgradeBeaconController;
    if (ubc === undefined) throw new Error('Undefined ubc');
    const tx = await ubc.populateTransaction.upgrade(
      violation.data.proxiedAddress.beacon,
      violation.expected,
    );
    if (tx.to === undefined) throw new Error('undefined tx.to');
    return { network, call: tx as Call };
  }

  async handleValidatorViolation(
    violation: ValidatorViolation,
  ): Promise<DomainedCall> {
    const dc = this.multiProvider.getDomainConnection(
      violation.network as Networks,
    );
    const provider = dc.provider!;

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
    return { network: violation.network, call: tx as Call };
  }

  expectCalls(networks: Networks[], count: number[]) {
    expect(networks).to.have.lengthOf(count.length);
    networks.forEach((network, i) => {
      expect(this.governance.getCalls(network)).to.have.lengthOf(count[i]);
    });
  }
}
