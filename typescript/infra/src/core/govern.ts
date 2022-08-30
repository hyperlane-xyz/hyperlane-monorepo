import { LedgerSigner } from '@ethersproject/hardware-wallets';
// NB: To provide ledger type declarations.
// Needs to be commented out to run.
import '@ethersproject/hardware-wallets/thirdparty';

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
  promiseObjAll,
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
      chain: Chain,
      _: ChainConnection,
      calls: types.CallData[],
    ) => console.log(chain, calls);
    return this.executeCalls(this.connectionFn, logFn);
  }

  protected async executeCalls(
    connectionFn: (chain: Chain) => ChainConnection,
    executeFn: (
      chain: Chain,
      connection: ChainConnection,
      calls: types.CallData[],
    ) => Promise<any>,
  ) {
    await promiseObjAll(
      objMap(this.calls, async (chain, calls) => {
        const connection = connectionFn(chain);
        await executeFn(chain, connection, calls);
      }),
    );
  }

  protected connectionFn(chain: Chain) {
    return this.checker.multiProvider.getChainConnection(chain);
  }

  protected ledgerConnectionFn(chain: Chain) {
    const connection = this.checker.multiProvider.getChainConnection(chain);
    return new ChainConnection({
      signer: new LedgerSigner(connection.provider),
      provider: connection.provider,
      overrides: connection.overrides,
      confirmations: connection.confirmations,
    });
  }

  protected async estimateFn(
    chain: Chain,
    connection: ChainConnection,
    calls: types.CallData[],
  ) {
    const signer = connection.signer;
    if (!signer) throw new Error(`no signer found for ${chain}`);
    const from = await signer.getAddress();
    await Promise.all(
      calls.map((call) =>
        signer.estimateGas({
          ...call,
          from,
        }),
      ),
    );
  }

  protected async sendFn(
    chain: Chain,
    connection: ChainConnection,
    calls: types.CallData[],
  ) {
    const signer = connection.signer;
    if (!signer) throw new Error(`no signer found for ${chain}`);
    for (const call of calls) {
      const response = await signer.sendTransaction(call);
      console.log(`sent tx ${response.hash} to ${chain}`);
      await response.wait(connection.confirmations);
      console.log(`confirmed tx ${response.hash} on ${chain}`);
    }
  }

  estimateCalls() {
    return this.executeCalls(this.connectionFn, this.estimateFn);
  }

  sendCalls() {
    return this.executeCalls(this.connectionFn, this.sendFn);
  }

  estimateCallsLedger() {
    return this.executeCalls(this.ledgerConnectionFn, this.estimateFn);
  }

  sendCallsLedger() {
    return this.executeCalls(this.ledgerConnectionFn, this.sendFn);
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
