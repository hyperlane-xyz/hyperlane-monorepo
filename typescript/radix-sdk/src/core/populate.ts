import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  ValueKind,
  address,
  array,
  tuple,
  u32,
  u64,
  u128,
} from '@radixdlt/radix-engine-toolkit';

import { strip0x } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { EntityDetails, INSTRUCTIONS } from '../utils/types.js';
import { bytes } from '../utils/utils.js';

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

  public createMailbox({
    from_address,
    domain_id,
  }: {
    from_address: string;
    domain_id: number;
  }) {
    return this.base.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'Mailbox',
      INSTRUCTIONS.INSTANTIATE,
      [u32(domain_id)],
    );
  }

  public createMerkleTreeHook({
    from_address,
    mailbox,
  }: {
    from_address: string;
    mailbox: string;
  }) {
    return this.base.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'MerkleTreeHook',
      INSTRUCTIONS.INSTANTIATE,
      [address(mailbox)],
    );
  }

  public createMerkleRootMultisigIsm({
    from_address,
    validators,
    threshold,
  }: {
    from_address: string;
    validators: string[];
    threshold: number;
  }) {
    return this.base.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'MerkleRootMultisigIsm',
      INSTRUCTIONS.INSTANTIATE,
      [
        array(ValueKind.Array, ...validators.map((v) => bytes(strip0x(v)))),
        u64(threshold),
      ],
    );
  }

  public createMessageIdMultisigIsm({
    from_address,
    validators,
    threshold,
  }: {
    from_address: string;
    validators: string[];
    threshold: number;
  }) {
    return this.base.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'MessageIdMultisigIsm',
      INSTRUCTIONS.INSTANTIATE,
      [
        array(ValueKind.Array, ...validators.map((v) => bytes(strip0x(v)))),
        u64(threshold),
      ],
    );
  }

  public createRoutingIsm({
    from_address,
    routes,
  }: {
    from_address: string;
    routes: { ism: string; domain: number }[];
  }) {
    return this.base.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'RoutingIsm',
      INSTRUCTIONS.INSTANTIATE,
      [
        array(
          ValueKind.Tuple,
          ...routes.map((r) => tuple(u32(r.domain), address(r.ism))),
        ),
      ],
    );
  }

  public async setRoutingIsmOwner({
    from_address,
    ism,
    new_owner,
  }: {
    from_address: string;
    ism: string;
    new_owner: string;
  }) {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(ism);

    const resource = (details.details as EntityDetails).role_assignments.owner
      .rule.access_rule.proof_rule.requirement.resource;

    return this.base.transfer({
      from_address,
      to_address: new_owner,
      resource_address: resource,
      amount: '1',
    });
  }

  public createNoopIsm({ from_address }: { from_address: string }) {
    return this.base.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'NoopIsm',
      INSTRUCTIONS.INSTANTIATE,
      [],
    );
  }

  public createIgp({
    from_address,
    denom,
  }: {
    from_address: string;
    denom: string;
  }) {
    return this.base.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'InterchainGasPaymaster',
      INSTRUCTIONS.INSTANTIATE,
      [address(denom)],
    );
  }

  public async setIgpOwner({
    from_address,
    igp,
    new_owner,
  }: {
    from_address: string;
    igp: string;
    new_owner: string;
  }) {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(igp);

    const resource = (details.details as EntityDetails).role_assignments.owner
      .rule.access_rule.proof_rule.requirement.resource;

    return this.base.transfer({
      from_address,
      to_address: new_owner,
      resource_address: resource,
      amount: '1',
    });
  }

  public async setDestinationGasConfig({
    from_address,
    igp,
    destination_gas_config,
  }: {
    from_address: string;
    igp: string;
    destination_gas_config: {
      remote_domain: string;
      gas_oracle: {
        token_exchange_rate: string;
        gas_price: string;
      };
      gas_overhead: string;
    };
  }) {
    return this.base.createCallMethodManifestWithOwner(
      from_address,
      igp,
      'set_destination_gas_configs',
      [
        array(
          ValueKind.Tuple,
          tuple(
            u32(destination_gas_config.remote_domain),
            tuple(
              tuple(
                u128(destination_gas_config.gas_oracle.token_exchange_rate),
                u128(destination_gas_config.gas_oracle.gas_price),
              ),
              u128(destination_gas_config.gas_overhead),
            ),
          ),
        ),
      ],
    );
  }

  public async setMailboxOwner({
    from_address,
    mailbox,
    new_owner,
  }: {
    from_address: string;
    mailbox: string;
    new_owner: string;
  }) {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(mailbox);

    const resource = (details.details as EntityDetails).role_assignments.owner
      .rule.access_rule.proof_rule.requirement.resource;

    return this.base.transfer({
      from_address,
      to_address: new_owner,
      resource_address: resource,
      amount: '1',
    });
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

  public async setRequiredHook({
    from_address,
    mailbox,
    hook,
  }: {
    from_address: string;
    mailbox: string;
    hook: string;
  }) {
    return this.base.createCallMethodManifestWithOwner(
      from_address,
      mailbox,
      'set_required_hook',
      [address(hook)],
    );
  }

  public async setDefaultHook({
    from_address,
    mailbox,
    hook,
  }: {
    from_address: string;
    mailbox: string;
    hook: string;
  }) {
    return this.base.createCallMethodManifestWithOwner(
      from_address,
      mailbox,
      'set_default_hook',
      [address(hook)],
    );
  }

  public async setDefaultIsm({
    from_address,
    mailbox,
    ism,
  }: {
    from_address: string;
    mailbox: string;
    ism: string;
  }) {
    return this.base.createCallMethodManifestWithOwner(
      from_address,
      mailbox,
      'set_default_ism',
      [address(ism)],
    );
  }
}
