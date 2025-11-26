import {
  ValueKind,
  address,
  array,
  tuple,
  u32,
  u64,
} from '@radixdlt/radix-engine-toolkit';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import { strip0x } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import {
  AnnotatedRadixTransaction,
  INSTRUCTIONS,
  RadixIsmTypes,
  RadixNetworkConfig,
} from '../utils/types.js';
import { bytes } from '../utils/utils.js';

export class RadixRoutingIsmTx {
  constructor(
    private readonly config: RadixNetworkConfig,
    private readonly base: RadixBase,
  ) {}

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

  async buildDeploymentTx(
    deployerAddress: string,
    routes: { domainId: number; ismAddress: string }[],
  ): Promise<AnnotatedRadixTransaction> {
    const manifest = await this.base.createCallFunctionManifest(
      deployerAddress,
      this.config.hyperlanePackageAddress,
      RadixIsmTypes.ROUTING_ISM,
      INSTRUCTIONS.INSTANTIATE,
      [
        array(
          ValueKind.Tuple,
          ...routes.map((r) => tuple(u32(r.domainId), address(r.ismAddress))),
        ),
      ],
    );

    return {
      manifest,
      networkId: this.config.radixNetworkId,
      annotation: `Deploying ${IsmType.ROUTING} on chain ${this.config.chainName}`,
    };
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

export class RadixMultisigIsmTx {
  constructor(
    private readonly config: RadixNetworkConfig,
    private readonly base: RadixBase,
  ) {}

  public async buildDeploymentTx(
    deployerAddress: string,
    ismType: IsmType.MESSAGE_ID_MULTISIG | IsmType.MERKLE_ROOT_MULTISIG,
    validators: string[],
    threshold: number,
  ): Promise<AnnotatedRadixTransaction> {
    const blueprintName =
      ismType === IsmType.MESSAGE_ID_MULTISIG
        ? RadixIsmTypes.MESSAGE_ID_MULTISIG
        : RadixIsmTypes.MERKLE_ROOT_MULTISIG;

    const manifest = await this.base.createCallFunctionManifest(
      deployerAddress,
      this.config.hyperlanePackageAddress,
      blueprintName,
      INSTRUCTIONS.INSTANTIATE,
      [
        array(ValueKind.Array, ...validators.map((v) => bytes(strip0x(v)))),
        u64(threshold),
      ],
    );

    return {
      manifest,
      networkId: this.config.radixNetworkId,
      annotation: `Deploying ${ismType} on chain ${this.config.chainName}`,
    };
  }
}
