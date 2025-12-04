import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { address } from '@radixdlt/radix-engine-toolkit';

import { RadixBase } from '../utils/base.js';
import { INSTRUCTIONS } from '../utils/types.js';

export class RadixCorePopulate {
  protected gateway: GatewayApiClient;
  protected base: RadixBase;
  protected packageAddress: string;

  constructor(
    gateway: GatewayApiClient,
    base: RadixBase,
    packageAddress: string,
  ) {
    this.gateway = gateway;
    this.base = base;
    this.packageAddress = packageAddress;
  }

  public createValidatorAnnounce({
    from_address,
    mailbox,
  }: {
    from_address: string;
    mailbox: string;
  }) {
    return this.base.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'ValidatorAnnounce',
      INSTRUCTIONS.INSTANTIATE,
      [address(mailbox)],
    );
  }
}
