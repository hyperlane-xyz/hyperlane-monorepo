import {
  AbacusCoreChecker,
  ChainConnection,
  ChainMap,
  ChainName,
  CoreViolationType,
  OwnerViolation,
  ValidatorViolation,
  ValidatorViolationType,
  ViolationType,
  objMap,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

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
        case CoreViolationType.Validator: {
          await this.handleValidatorViolation(violation as ValidatorViolation);
          break;
        }
        case ViolationType.Owner: {
          await this.handleOwnerViolation(violation as OwnerViolation);
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

  async handleValidatorViolation(violation: ValidatorViolation) {
    const validatorManager = violation.data.validatorManager;
    switch (violation.data.type) {
      case ValidatorViolationType.EnrollValidator: {
        const call = await validatorManager.populateTransaction.enrollValidator(
          violation.expected,
        );
        this.pushCall(violation.chain as Chain, call as types.CallData);
        break;
      }
      case ValidatorViolationType.UnenrollValidator: {
        const call =
          await validatorManager.populateTransaction.unenrollValidator(
            violation.actual,
          );
        this.pushCall(violation.chain as Chain, call as types.CallData);
        break;
      }
      case ValidatorViolationType.Threshold: {
        const call = await validatorManager.populateTransaction.setThreshold(
          violation.expected,
        );
        this.pushCall(violation.chain as Chain, call as types.CallData);
        break;
      }
      default:
        throw new Error(
          `Unsupported validator violation type ${violation.data.type}`,
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
