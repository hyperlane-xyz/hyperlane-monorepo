import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { ISigner, IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ExtractIsmModuleType,
  IsmModuleAddresses,
  IsmModuleType,
  MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  HypModule,
  HypModuleArgs,
  HypReader,
  ModuleProvider,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import {
  WithAddress,
  assert,
  deepEquals,
  normalizeConfig,
} from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import {
  AnnotatedRadixTransaction,
  RadixNetworkConfig,
  RadixSDKReceipt,
  ismTypeFromRadixIsmType,
} from '../utils/types.js';

import { getMultisigIsmConfig } from './query.js';
import { RadixMultisigIsmTx } from './tx.js';

type MultisigIsmModule = ExtractIsmModuleType<
  'merkleRootMultisigIsm' | 'messageIdMultisigIsm'
>;

export class RadixMultisigIsmReader implements HypReader<MultisigIsmModule> {
  constructor(private readonly gateway: GatewayApiClient) {}

  async read(address: string): Promise<WithAddress<MultisigIsmConfig>> {
    const { threshold, validators, type } = await getMultisigIsmConfig(
      this.gateway,
      address,
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
    private readonly signer: ISigner<AnnotatedTx, TxReceipt>,
    private readonly reader: HypReader<MultisigIsmModule>,
    private readonly moduleProvider: ModuleProvider<IsmModuleType>,
  ) {}

  read(): Promise<WithAddress<MultisigIsmConfig>> {
    return this.reader.read(this.args.addresses.deployedIsm);
  }

  serialize(): IsmModuleAddresses {
    return this.args.addresses;
  }

  static async create(
    ismConfig: MultisigIsmConfig,
    networkConfig: RadixNetworkConfig,
    signer: ISigner<AnnotatedTx, TxReceipt>,
    base: RadixBase,
    gateway: GatewayApiClient,
    moduleProvider: ModuleProvider<IsmModuleType>,
  ): Promise<HypModule<MultisigIsmModule>> {
    const { chainName, hyperlanePackageAddress, radixNetworkId } =
      networkConfig;

    const txBuilder = new RadixMultisigIsmTx(
      {
        chainName,
        hyperlanePackageAddress,
        radixNetworkId,
      },
      base,
    );

    const deployTransaction = await txBuilder.buildDeploymentTx(
      signer.getSignerAddress(),
      ismConfig.type === IsmType.MERKLE_ROOT_MULTISIG
        ? IsmType.MERKLE_ROOT_MULTISIG
        : IsmType.MESSAGE_ID_MULTISIG,
      ismConfig.validators,
      ismConfig.threshold,
    );

    const res = await signer.sendAndConfirmTransaction(deployTransaction);

    const address = await base.getNewComponent(res as RadixSDKReceipt);

    return new RadixMultisigIsmModule(
      {
        addresses: {
          deployedIsm: address,
          mailbox: '',
        },
        chain: chainName,
        config: ismConfig,
      },
      signer,
      new RadixMultisigIsmReader(gateway),
      moduleProvider,
    );
  }

  async update(
    expectedConfig: MultisigIsmConfig,
  ): Promise<AnnotatedRadixTransaction[]> {
    const currentConfig = await this.read();

    const normalizedExpectedConfig = normalizeConfig(expectedConfig);
    const normalizedCurrentConfig = normalizeConfig(currentConfig);

    if (deepEquals(normalizedExpectedConfig, normalizedCurrentConfig)) {
      return [];
    }

    // The Multisig ISMs need to be redeployed if the config changes
    const newIsm = await this.moduleProvider.createModule(
      this.signer,
      normalizedExpectedConfig,
    );

    this.args.config = normalizedExpectedConfig;
    this.args.addresses = newIsm.serialize();

    return [];
  }
}
