import { assert } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { Account } from '../utils/types.js';

import { RadixCorePopulate } from './populate.js';

export class RadixCoreTx {
  private account: Account;

  protected base: RadixBase;
  protected populate: RadixCorePopulate;
  protected signer: RadixBaseSigner;

  constructor(
    account: Account,
    base: RadixBase,
    signer: RadixBaseSigner,
    populate: RadixCorePopulate,
  ) {
    this.account = account;
    this.base = base;
    this.signer = signer;
    this.populate = populate;
  }

  public async transfer({
    to_address,
    resource_address,
    amount,
  }: {
    to_address: string;
    resource_address: string;
    amount: string;
  }) {
    const metadata = await this.base.getMetadata({
      resource: resource_address,
    });
    assert(
      metadata,
      `resource with address ${resource_address} does not exist`,
    );

    const transactionManifest = await this.base.transfer({
      from_address: this.account.address,
      to_address,
      resource_address,
      amount,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }
}
