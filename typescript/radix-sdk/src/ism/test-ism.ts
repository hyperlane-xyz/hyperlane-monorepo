import { IProvider, IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ExtractIsmModuleType,
  IsmModuleAddresses,
  TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  HypModule,
  HypModuleArgs,
  HypReader,
} from '@hyperlane-xyz/provider-sdk/module';
import { WithAddress, assert } from '@hyperlane-xyz/utils';

import { AnnotatedRadixTransaction } from '../utils/types.js';

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

  async update(_config: TestIsmConfig): Promise<AnnotatedRadixTransaction[]> {
    // The TestIsm does not have any updatable properties
    return [];
  }
}
