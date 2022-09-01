import {
  AbacusConnectionManagerViolation,
  AbacusConnectionManagerViolationType,
  AbacusCoreChecker,
  ChainConnection,
  ChainMap,
  ChainName,
  ChainNameToDomainId,
  CoreViolationType,
  EnrolledInboxesViolation,
  EnrolledValidatorsViolation,
  OwnerViolation,
  ValidatorManagerViolation,
  ValidatorManagerViolationType,
  ViolationType,
  objMap,
} from '@abacus-network/sdk';
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
          this.handleValidatorManagerViolation(
            violation as ValidatorManagerViolation,
          );
          break;
        }
        case ViolationType.Owner: {
          this.handleOwnerViolation(violation as OwnerViolation);
          break;
        }
        case CoreViolationType.AbacusConnectionManager: {
          this.handleAbacusConnectionManagerViolation(
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

  // pushes calls which reconcile actual and expected sets on chain
  protected pushSetReconcilationCalls<T>(reconcile: {
    chain: ChainName;
    actual: Set<T>;
    expected: Set<T>;
    add: (elem: T) => types.CallData;
    remove: (elem: T) => types.CallData;
  }) {
    // add expected - actual elements
    utils
      .difference(reconcile.expected, reconcile.actual)
      .forEach((elem) =>
        this.pushCall(reconcile.chain as Chain, reconcile.add(elem)),
      );

    // remote actual - expected elements
    utils
      .difference(reconcile.actual, reconcile.expected)
      .forEach((elem) =>
        this.pushCall(reconcile.chain as Chain, reconcile.remove(elem)),
      );
  }

  handleAbacusConnectionManagerViolation(
    violation: AbacusConnectionManagerViolation,
  ) {
    const abacusConnectionManager = violation.contract;
    switch (violation.abacusConnectionManagerType) {
      case AbacusConnectionManagerViolationType.EnrolledInboxes: {
        const typedViolation = violation as EnrolledInboxesViolation;
        const remoteId = ChainNameToDomainId[typedViolation.remote];
        this.pushSetReconcilationCalls({
          ...typedViolation,
          add: (inbox) => ({
            to: abacusConnectionManager.address,
            data: abacusConnectionManager.interface.encodeFunctionData(
              'enrollInbox',
              [remoteId, inbox],
            ),
          }),
          remove: (inbox) => ({
            to: abacusConnectionManager.address,
            data: abacusConnectionManager.interface.encodeFunctionData(
              'unenrollInbox',
              [inbox],
            ),
          }),
        });
        break;
      }
      default:
        throw new Error(
          `Unsupported abacus connection manager violation type ${violation.abacusConnectionManagerType}`,
        );
    }
  }

  handleValidatorManagerViolation(violation: ValidatorManagerViolation) {
    const validatorManager = violation.contract;
    switch (violation.validatorManagerType) {
      case ValidatorManagerViolationType.EnrolledValidators: {
        this.pushSetReconcilationCalls({
          ...(violation as EnrolledValidatorsViolation),
          add: (validator) => ({
            to: validatorManager.address,
            data: validatorManager.interface.encodeFunctionData(
              'enrollValidator',
              [validator],
            ),
          }),
          remove: (validator) => ({
            to: validatorManager.address,
            data: validatorManager.interface.encodeFunctionData(
              'unenrollValidator',
              [validator],
            ),
          }),
        });
        break;
      }
      case ValidatorManagerViolationType.Threshold: {
        this.pushCall(violation.chain as Chain, {
          to: validatorManager.address,
          data: validatorManager.interface.encodeFunctionData('setThreshold', [
            violation.expected,
          ]),
        });
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
