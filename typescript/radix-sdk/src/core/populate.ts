import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { RadixBase } from '../utils/base.js';

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
}
