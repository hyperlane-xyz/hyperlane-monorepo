import { ExecuteInstruction } from '@cosmjs/cosmwasm-stargate';

import {
  Address,
  difference,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { BaseCosmWasmAdapter } from '../../app/MultiProtocolApp.js';
import {
  EnrolledValidatorsResponse,
  ExecuteMsg as MultisigExecute,
  QueryMsg as MultisigQuery,
} from '../../cw-types/IsmMultisig.types.js';
import { MultisigConfig } from '../../ism/types.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainMap, ChainName } from '../../types.js';

type MultisigResponse = EnrolledValidatorsResponse;

export class CosmWasmMultisigAdapter extends BaseCosmWasmAdapter {
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { multisig: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async queryMultisig<R extends MultisigResponse>(
    msg: MultisigQuery,
  ): Promise<R> {
    const provider = await this.getProvider();
    const response: R = await provider.queryContractSmart(
      this.addresses.multisig,
      msg,
    );
    return response;
  }

  async getConfig(chain: ChainName): Promise<MultisigConfig> {
    return this.queryMultisig<EnrolledValidatorsResponse>({
      multisig_ism: {
        enrolled_validators: {
          domain: this.multiProvider.getDomainId(chain),
        },
      },
    });
  }

  prepareMultisig(msg: MultisigExecute): ExecuteInstruction {
    return {
      contractAddress: this.addresses.multisig,
      msg,
    };
  }

  async configureMultisig(
    configMap: ChainMap<MultisigConfig>,
  ): Promise<ExecuteInstruction[]> {
    const configuredMap = await promiseObjAll(
      objMap(configMap, (origin, _) => this.getConfig(origin)),
    );

    const validatorInstructions = Object.entries(configMap).flatMap(
      ([origin, config]) => {
        const domain = this.multiProvider.getDomainId(origin);
        const configuredSet = new Set(configuredMap[origin].validators);
        const configSet = new Set(config.validators);
        const unenrollList = Array.from(
          difference(configuredSet, configSet).values(),
        );
        const enrollList = Array.from(
          difference(configSet, configuredSet).values(),
        );
        return unenrollList
          .map((validator) =>
            this.prepareMultisig({
              unenroll_validator: {
                domain,
                validator,
              },
            }),
          )
          .concat(
            enrollList.map((validator) =>
              this.prepareMultisig({
                enroll_validator: {
                  set: {
                    domain,
                    validator,
                  },
                },
              }),
            ),
          );
      },
    );

    const setThresholds = Object.entries(configMap)
      .filter(
        ([origin, { threshold }]) =>
          threshold !== configuredMap[origin].threshold,
      )
      .map(([origin, config]) => ({
        domain: this.multiProvider.getDomainId(origin),
        threshold: config.threshold,
      }));

    if (setThresholds.length > 0) {
      const thresholdInstruction = this.prepareMultisig({
        set_thresholds: {
          set: setThresholds,
        },
      });
      return [...validatorInstructions, thresholdInstruction];
    }

    return validatorInstructions;
  }
}
