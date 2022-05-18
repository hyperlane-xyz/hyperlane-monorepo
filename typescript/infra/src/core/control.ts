import { expect } from 'chai';
import { PopulatedTransaction } from 'ethers';

import { MultisigValidatorManager__factory } from '@abacus-network/core';
import {
  CheckerViolation,
  CoreConfig,
  ProxyViolationType,
  UpgradeBeaconViolation,
} from '@abacus-network/deploy';
import {
  AbacusCore,
  Call,
  ChainMap,
  ChainName,
  ControllerApp,
  MultiProvider,
  objMap,
} from '@abacus-network/sdk';

import {
  AbacusCoreChecker,
  CoreViolationType,
  ValidatorViolation,
  ValidatorViolationType,
} from './check';

interface CallWithTarget {
  chain: ChainName;
  call: Call;
}

export class AbacusCoreControllerChecker<
  Chain extends ChainName,
> extends AbacusCoreChecker<Chain> {
  readonly controllerApp: ControllerApp<Chain>;

  constructor(
    multiProvider: MultiProvider<Chain>,
    app: AbacusCore<Chain>,
    controllerApp: ControllerApp<Chain>,
    config: ChainMap<Chain, CoreConfig>,
  ) {
    const owners = controllerApp.routerAddresses();
    const joinedConfigMap = objMap(config, (chain, coreConfig) => {
      return {
        ...coreConfig,
        owner: owners[chain],
      };
    });
    super(multiProvider, app, joinedConfigMap);
    this.controllerApp = controllerApp;
  }

  async check(): Promise<void[]> {
    await super.check();
    const txs = await Promise.all(
      this.violations.map((v) => this.handleViolation(v)),
    );
    txs.map((call) =>
      this.controllerApp.pushCall(call.chain as Chain, call.call),
    );
    return [];
  }

  handleViolation(v: CheckerViolation): Promise<CallWithTarget> {
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
  ): Promise<CallWithTarget> {
    const chain = violation.chain;
    const ubc = this.app.getContracts(chain as Chain).upgradeBeaconController;
    if (ubc === undefined) throw new Error('Undefined ubc');
    const tx = await ubc.populateTransaction.upgrade(
      violation.data.proxiedAddress.beacon,
      violation.expected,
    );
    if (tx.to === undefined) throw new Error('undefined tx.to');
    return { chain, call: tx as Call };
  }

  async handleValidatorViolation(
    violation: ValidatorViolation,
  ): Promise<CallWithTarget> {
    const dc = this.multiProvider.getChainConnection(violation.chain as Chain);
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
    return { chain: violation.chain, call: tx as Call };
  }

  expectCalls(chains: Chain[], count: number[]) {
    expect(chains).to.have.lengthOf(count.length);
    chains.forEach((chain, i) => {
      expect(this.controllerApp.getCalls(chain)).to.have.lengthOf(count[i]);
    });
  }
}
