import { address, u32 } from '@radixdlt/radix-engine-toolkit';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';

import { RadixBase } from '../utils/base.js';
import {
  AnnotatedRadixTransaction,
  INSTRUCTIONS,
  RadixIsmTypes,
  RadixNetworkConfig,
} from '../utils/types.js';

// This class extracts the relevant routing ism update methods from the
// RadixCoreTx class
export class RadixRoutingIsmTx {
  constructor(private readonly base: RadixBase) {}

  async buildAddDomainIsmTransaction(params: {
    from_address: string;
    ism: string;
    route: { domainId: number; ismAddress: string };
  }) {
    return this.base.createCallMethodManifestWithOwner(
      params.from_address,
      params.ism,
      'set_route',
      [u32(params.route.domainId), address(params.route.ismAddress)],
    );
  }

  async buildRemoveDomainIsmTransaction(params: {
    from_address: string;
    ism: string;
    domain: number;
  }) {
    return this.base.createCallMethodManifestWithOwner(
      params.from_address,
      params.ism,
      'remove_route',
      [u32(params.domain)],
    );
  }

  async buildUpdateOwnershipTransaction(params: {
    from_address: string;
    ism: string;
    new_owner: string;
  }) {
    return this.base.createCallMethodManifestWithOwner(
      params.from_address,
      params.ism,
      'set_owner',
      [address(params.new_owner)],
    );
  }
}

export class RadixTestIsmTx {
  constructor(
    private readonly config: RadixNetworkConfig,
    private readonly base: RadixBase,
  ) {}

  public async buildDeploymentTx(
    deployerAddress: string,
  ): Promise<AnnotatedRadixTransaction> {
    const manifest = await this.base.createCallFunctionManifest(
      deployerAddress,
      this.config.hyperlanePackageAddress,
      RadixIsmTypes.NOOP_ISM,
      INSTRUCTIONS.INSTANTIATE,
      [],
    );

    return {
      manifest,
      networkId: this.config.radixNetworkId,
      annotation: `Deploying ${IsmType.TEST_ISM} on chain ${this.config.chainName}`,
    };
  }
}
