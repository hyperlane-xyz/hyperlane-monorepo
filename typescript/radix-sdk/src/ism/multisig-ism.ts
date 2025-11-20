import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  IsmModuleAddresses,
  MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  HypModule,
  HypModuleArgs,
  HypReader,
} from '@hyperlane-xyz/provider-sdk/module';
import { WithAddress, assert } from '@hyperlane-xyz/utils';

import { RadixProvider } from '../clients/provider.js';
import { ismTypeFromRadixIsmType } from '../utils/types.js';

import { getMultisigIsmConfig } from './query.js';

type MultisigIsmModule = {
  config: MultisigIsmConfig;
  addresses: IsmModuleAddresses;
  derived: WithAddress<MultisigIsmConfig>;
};

export class RadixMultisigIsmReader implements HypReader<MultisigIsmModule> {
  constructor(private readonly provider: RadixProvider) {}

  async read(address: string): Promise<WithAddress<MultisigIsmConfig>> {
    const { threshold, validators, type } = await getMultisigIsmConfig(
      this.provider['gateway'],
      {
        ismAddress: address,
      },
    );

    const ismType = ismTypeFromRadixIsmType(type);
    assert(
      ismType === IsmType.MESSAGE_ID_MULTISIG ||
        ismType === IsmType.MERKLE_ROOT_MULTISIG,
      `Expected Ism at address ${address} to be of type ${IsmType.MESSAGE_ID_MULTISIG} or ${IsmType.MERKLE_ROOT_MULTISIG}`,
    );

    return {
      address,
      type: ismType,
      threshold,
      validators,
    };
  }
}

export class RadixMultisigIsmModule implements HypModule<MultisigIsmModule> {
  constructor(
    private readonly args: HypModuleArgs<MultisigIsmModule>,
    private readonly reader: HypReader<MultisigIsmModule>,
  ) {}

  read(): Promise<WithAddress<MultisigIsmConfig>> {
    return this.reader.read(this.args.addresses.deployedIsm);
  }

  serialize(): IsmModuleAddresses {
    return this.args.addresses;
  }

  async update(_config: MultisigIsmConfig): Promise<AnnotatedTx[]> {
    // The Multisig ISMs need to be redeployed if the config changes
    return [];
  }
}
