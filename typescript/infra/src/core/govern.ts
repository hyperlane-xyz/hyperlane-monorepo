import {
  AbacusCoreChecker,
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

  async logCalls() {
    await this.estimateCalls();
    objMap(this.calls, (chain, calls) => {
      console.log(chain, calls);
    });
  }

  estimateCalls() {
    objMap(this.calls, async (chain, calls) => {
      const connection = this.checker.multiProvider.getChainConnection(chain);
      const owner = this.checker.configMap[chain].owner;
      for (const call of calls) {
        await connection.provider.estimateGas({
          ...call,
          from: owner,
        });
      }
    });
  }

  async executeCalls() {
    await this.estimateCalls();
    objMap(this.calls, async (chain, calls) => {
      const connection = this.checker.multiProvider.getChainConnection(chain);
      const signer = connection.signer;
      if (!signer) {
        throw new Error(`signer not found for ${chain}`);
      }
      for (const call of calls) {
        const response = await signer.sendTransaction(call);
        console.log(`sent tx ${response.hash} to ${chain}`);
        await response.wait(connection.confirmations);
        console.log(`confirmed tx ${response.hash} on ${chain}`);
      }
    });
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

  // This function is an exception in that it assumes the MultiProvider
  // is configured with the privileged signers. All other functions assume
  // governance is done via multisig.
  async handleOwnerViolation(violation: OwnerViolation) {
    const chainConnection = this.checker.multiProvider.getChainConnection(
      violation.chain as Chain,
    );
    console.log(
      `${violation.chain}: transferring ownership of ${violation.data.contract.address} from ${violation.actual} to ${violation.expected}`,
    );
    const response = await violation.data.contract.transferOwnership(
      violation.expected,
      chainConnection.overrides,
    );
    await response.wait(chainConnection.confirmations);
  }
}
