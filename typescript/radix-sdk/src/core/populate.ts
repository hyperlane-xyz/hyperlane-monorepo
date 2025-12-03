import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  ValueKind,
  address,
  array,
  tuple,
  u32,
  u128,
} from '@radixdlt/radix-engine-toolkit';

import { RadixBase } from '../utils/base.js';
import { EntityDetails, INSTRUCTIONS, RadixHookTypes } from '../utils/types.js';

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
      RadixHookTypes.MERKLE_TREE,
      INSTRUCTIONS.INSTANTIATE,
      [address(mailbox)],
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
      RadixHookTypes.IGP,
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
    destinationGasConfig,
  }: {
    from_address: string;
    igp: string;
    destinationGasConfig: {
      remoteDomainId: number;
      gasOracle: {
        tokenExchangeRate: string;
        gasPrice: string;
      };
      gasOverhead: string;
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
            u32(destinationGasConfig.remoteDomainId),
            tuple(
              tuple(
                u128(destinationGasConfig.gasOracle.tokenExchangeRate),
                u128(destinationGasConfig.gasOracle.gasPrice),
              ),
              u128(destinationGasConfig.gasOverhead),
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
