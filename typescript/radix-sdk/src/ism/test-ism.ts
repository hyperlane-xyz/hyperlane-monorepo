import { IProvider, ISigner, IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ExtractIsmModuleType,
  IsmModuleAddresses,
  TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  HypModule,
  HypModuleArgs,
  HypReader,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { WithAddress, assert } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import {
  AnnotatedRadixTransaction,
  RadixNetworkConfig,
  RadixSDKReceipt,
} from '../utils/types.js';

import { RadixTestIsmTx } from './tx.js';

type TestIsmModule = ExtractIsmModuleType<'testIsm'>;

export class RadixTestIsmReader implements HypReader<TestIsmModule> {
  constructor(private readonly provider: IProvider) {}

  async read(address: string): Promise<WithAddress<TestIsmConfig>> {
    const ismType = await this.provider.getIsmType({
      ismAddress: address,
    });

    assert(
      ismType === IsmType.TEST_ISM,
      `Expected Ism at address ${address} to be of type ${IsmType.TEST_ISM}`,
    );

    return {
      address,
      type: IsmType.TEST_ISM,
    };
  }
}

export class RadixTestIsmModule implements HypModule<TestIsmModule> {
  constructor(
    private readonly args: HypModuleArgs<TestIsmModule>,
    private readonly reader: HypReader<TestIsmModule>,
  ) {}

  read(): Promise<WithAddress<TestIsmConfig>> {
    return this.reader.read(this.args.addresses.deployedIsm);
  }

  serialize(): IsmModuleAddresses {
    return this.args.addresses;
  }

  static async create(
    ismConfig: TestIsmConfig,
    networkConfig: RadixNetworkConfig,
    signer: ISigner<AnnotatedTx, TxReceipt>,
    base: RadixBase,
  ): Promise<HypModule<TestIsmModule>> {
    const { chainName, hyperlanePackageAddress, radixNetworkId } =
      networkConfig;

    const txBuilder = new RadixTestIsmTx(
      {
        chainName,
        hyperlanePackageAddress,
        radixNetworkId,
      },
      base,
    );

    const deployTransaction = await txBuilder.buildDeploymentTx(
      signer.getSignerAddress(),
    );

    const res = await signer.sendAndConfirmTransaction(deployTransaction);

    const address = await base.getNewComponent(res as RadixSDKReceipt);

    return new RadixTestIsmModule(
      {
        addresses: {
          deployedIsm: address,
          mailbox: '',
        },
        chain: chainName,
        config: ismConfig,
      },
      new RadixTestIsmReader(signer),
    );
  }

  async update(_config: TestIsmConfig): Promise<AnnotatedRadixTransaction[]> {
    // The TestIsm does not have any updatable properties
    return [];
  }
}
