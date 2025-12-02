import { address, u32 } from '@radixdlt/radix-engine-toolkit';

import { RadixBase } from '../utils/base.js';

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
