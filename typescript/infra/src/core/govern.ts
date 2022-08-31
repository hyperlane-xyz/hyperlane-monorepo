import { PopulatedTransaction } from 'ethers';

import {
  AbacusCoreChecker,
  ChainConnection,
  ChainMap,
  ChainName,
  ChainNameToDomainId,
  CoreViolationType,
  EnrolledInboxesViolation,
  OwnerViolation,
  ValidatorManagerViolation,
  ViolationType,
  objMap,
} from '@abacus-network/sdk';
import {
  AbacusConnectionManagerViolation,
  AbacusConnectionManagerViolationType,
  EnrolledValidatorsViolation,
  ValidatorManagerViolationType,
} from '@abacus-network/sdk/dist/deploy/core/types';
import { types, utils } from '@abacus-network/utils';

export class AbacusCoreGovernor<Chain extends ChainName> {
  readonly checker: AbacusCoreChecker<Chain>;
  calls: ChainMap<Chain, types.CallData[]>;

  constructor(checker: AbacusCoreChecker<Chain>) {
    this.checker = checker;
    this.calls = objMap(this.checker.app.contractsMap, () => []);
  }

  pushCall(chain: Chain, call: types.CallData) {
    this.calls[chain].push(call);
  }

  async govern() {
    for (const violation of this.checker.violations) {
      switch (violation.type) {
        case CoreViolationType.ValidatorManager: {
          await this.handleValidatorManagerViolation(
            violation as ValidatorManagerViolation,
          );
          break;
        }
        case ViolationType.Owner: {
          await this.handleOwnerViolation(violation as OwnerViolation);
          break;
        }
        case CoreViolationType.AbacusConnectionManager: {
          await this.handleAbacusConnectionManagerViolation(
            violation as AbacusConnectionManagerViolation,
          );
          break;
        }
        default:
          throw new Error(`Unsupported violation type ${violation.type}`);
      }
    }
  }

  logCalls() {
    const logFn = async (
      _: ChainConnection,
      calls: types.CallData[],
      chain?: Chain,
    ) => console.log(chain, calls);
    return this.mapCalls(this.connectionFn, logFn);
  }

  protected async mapCalls(
    connectionFn: (chain: Chain) => ChainConnection,
    mapFn: (
      connection: ChainConnection,
      calls: types.CallData[],
      chain?: Chain,
    ) => Promise<any>,
  ) {
    for (const chain of Object.keys(this.calls)) {
      const calls = this.calls[chain as Chain];
      if (calls.length > 0) {
        const connection = connectionFn(chain as Chain);
        await mapFn(connection, calls, chain as Chain);
      }
    }
  }

  connectionFn = (chain: Chain) => {
    return this.checker.multiProvider.getChainConnection(chain);
  };

  /*
  // NB: Add this back in order to run using a Ledger signer.
  import { LedgerSigner } from '@ethersproject/hardware-wallets';

  // Due to TS funkiness, this needs to be imported in order for this
  // code to build, but needs to be removed in order for the code to run.
  import '@ethersproject/hardware-wallets/thirdparty';

  ledgerConnectionFn = (chain: Chain) => {
    const connection = this.checker.multiProvider.getChainConnection(chain);
    // Ledger Live derivation path, vary the third number  to select different
    // accounts.
    const path = "m/44'/60'/2'/0/0";
    return new ChainConnection({
      signer: new LedgerSigner(connection.provider, 'hid', path),
      provider: connection.provider,
      overrides: connection.overrides,
      confirmations: connection.confirmations,
    });
  };
  */

  protected async estimateFn(
    connection: ChainConnection,
    calls: types.CallData[],
  ) {
    await Promise.all(calls.map((call) => connection.estimateGas(call)));
  }

  protected async sendFn(connection: ChainConnection, calls: types.CallData[]) {
    for (const call of calls) {
      connection.sendTransaction(call);
    }
  }

  estimateCalls() {
    return this.mapCalls(this.connectionFn, this.estimateFn);
  }

  sendCalls() {
    return this.mapCalls(this.connectionFn, this.sendFn);
  }

  protected async pushSetReconcilationCalls<T>(reconcile: {
    chain: ChainName;
    actual: Set<T>;
    expected: Set<T>;
    add: (elem: T) => Promise<PopulatedTransaction>;
    remove: (elem: T) => Promise<PopulatedTransaction>;
  }) {
    let txs: PopulatedTransaction[] = [];
    utils
      .difference(reconcile.expected, reconcile.actual)
      .forEach(async (item) => txs.push(await reconcile.add(item)));
    utils
      .difference(reconcile.actual, reconcile.expected)
      .forEach(async (item) => txs.push(await reconcile.remove(item)));
    txs.forEach((tx) =>
      this.pushCall(reconcile.chain as Chain, tx as types.CallData),
    );
  }

  async handleAbacusConnectionManagerViolation(
    violation: AbacusConnectionManagerViolation,
  ) {
    const abacusConnectionManager = violation.contract;
    switch (violation.abacusConnectionManagerType) {
      case AbacusConnectionManagerViolationType.EnrolledInboxes: {
        const typedViolation = violation as EnrolledInboxesViolation;
        const remoteId = ChainNameToDomainId[typedViolation.remote];
        this.pushSetReconcilationCalls({
          ...typedViolation,
          add: (inbox) =>
            abacusConnectionManager.populateTransaction.enrollInbox(
              remoteId,
              inbox,
            ),
          remove: (inbox) =>
            abacusConnectionManager.populateTransaction.unenrollInbox(inbox),
        });
        break;
      }
      default:
        throw new Error(
          `Unsupported abacus connection manager violation type ${violation.abacusConnectionManagerType}`,
        );
    }
  }

  async handleValidatorManagerViolation(violation: ValidatorManagerViolation) {
    const validatorManager = violation.contract;
    switch (violation.validatorManagerType) {
      case ValidatorManagerViolationType.EnrolledValidators: {
        this.pushSetReconcilationCalls({
          ...(violation as EnrolledValidatorsViolation),
          add: (validator) =>
            validatorManager.populateTransaction.enrollValidator(validator),
          remove: (validator) =>
            validatorManager.populateTransaction.unenrollValidator(validator),
        });
        break;
      }
      case ValidatorManagerViolationType.Threshold: {
        const call = await validatorManager.populateTransaction.setThreshold(
          violation.expected,
        );
        this.pushCall(violation.chain as Chain, call as types.CallData);
        break;
      }
      default:
        throw new Error(
          `Unsupported validator manager violation type ${violation.validatorManagerType}`,
        );
    }
  }

  async handleOwnerViolation(violation: OwnerViolation) {
    const call =
      await violation.data.contract.populateTransaction.transferOwnership(
        violation.expected,
      );
    this.pushCall(violation.chain as Chain, call as types.CallData);
  }
}
