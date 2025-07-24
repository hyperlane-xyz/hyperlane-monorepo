import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  ManifestBuilder,
  Value,
  ValueKind,
  address,
  array,
  bucket,
  decimal,
  enumeration,
  expression,
  str,
  u8,
  u32,
  u64,
} from '@radixdlt/radix-engine-toolkit';
import { BigNumber } from 'bignumber.js';
import { Decimal } from 'decimal.js';

import { assert, strip0x } from '@hyperlane-xyz/utils';

import { bytes } from '../utils.js';

import { RadixQuery } from './query.js';

export class RadixPopulate {
  protected gateway: GatewayApiClient;
  protected query: RadixQuery;
  protected packageAddress: string;
  protected gasAmount: number;

  constructor(
    gateway: GatewayApiClient,
    query: RadixQuery,
    packageAddress: string,
    gasAmount: number,
  ) {
    this.gateway = gateway;
    this.query = query;
    this.packageAddress = packageAddress;
    this.gasAmount = gasAmount;
  }

  private createCallFunctionManifest(
    from_address: string,
    package_address: string | number,
    blueprint_name: string,
    function_name: string,
    args: Value[],
  ) {
    return new ManifestBuilder()
      .callMethod(
        'component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh',
        'lock_fee',
        [decimal(this.gasAmount)],
      )
      .callFunction(package_address, blueprint_name, function_name, args)
      .callMethod(from_address, 'try_deposit_batch_or_refund', [
        expression('EntireWorktop'),
        enumeration(0),
      ])
      .build();
  }

  private async createCallMethodManifestWithOwner(
    from_address: string,
    contract_address: string,
    method_name: string,
    args: Value[],
  ) {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(
        contract_address,
      );

    const ownerResource = (details.details as any).role_assignments.owner.rule
      .access_rule.proof_rule.requirement.resource;

    return new ManifestBuilder()
      .callMethod(
        'component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh',
        'lock_fee',
        [decimal(this.gasAmount)],
      )
      .callMethod(from_address, 'create_proof_of_amount', [
        address(ownerResource),
        decimal(1),
      ])
      .callMethod(contract_address, method_name, args)
      .callMethod(from_address, 'try_deposit_batch_or_refund', [
        expression('EntireWorktop'),
        enumeration(0),
      ])
      .build();
  }

  public transfer({
    from_address,
    to_address,
    resource_address,
    amount,
  }: {
    from_address: string;
    to_address: string;
    resource_address: string;
    amount: string;
  }) {
    return new ManifestBuilder()
      .callMethod(
        'component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh',
        'lock_fee',
        [decimal(this.gasAmount)],
      )
      .callMethod(from_address, 'withdraw', [
        address(resource_address),
        decimal(amount),
      ])
      .takeFromWorktop(
        resource_address,
        new Decimal(amount),
        (builder, bucketId) =>
          builder.callMethod(to_address, 'try_deposit_or_abort', [
            bucket(bucketId),
          ]),
      )
      .build();
  }

  public createMailbox({
    from_address,
    domain_id,
  }: {
    from_address: string;
    domain_id: number;
  }) {
    return this.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'Mailbox',
      'mailbox_instantiate',
      [u32(domain_id)],
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

    const resource = (details.details as any).role_assignments.owner.rule
      .access_rule.proof_rule.requirement.resource;

    return this.transfer({
      from_address,
      to_address: new_owner,
      resource_address: resource,
      amount: '1',
    });
  }

  public createMerkleTreeHook({
    from_address,
    mailbox,
  }: {
    from_address: string;
    mailbox: string;
  }) {
    return this.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'MerkleTreeHook',
      'instantiate',
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
    return this.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'MerkleRootMultisigIsm',
      'instantiate',
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
    return this.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'MessageIdMultisigIsm',
      'instantiate',
      [
        array(ValueKind.Array, ...validators.map((v) => bytes(strip0x(v)))),
        u64(threshold),
      ],
    );
  }

  public createNoopIsm({ from_address }: { from_address: string }) {
    return this.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'NoopIsm',
      'instantiate',
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
    return this.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'InterchainGasPaymaster',
      'instantiate',
      [address(denom)],
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

    const resource = (details.details as any).role_assignments.owner.rule
      .access_rule.proof_rule.requirement.resource;

    return this.transfer({
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
    return this.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'ValidatorAnnounce',
      'instantiate',
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
    return this.createCallMethodManifestWithOwner(
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
    return this.createCallMethodManifestWithOwner(
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
    return this.createCallMethodManifestWithOwner(
      from_address,
      mailbox,
      'set_default_ism',
      [address(ism)],
    );
  }

  public createCollateralToken({
    from_address,
    mailbox,
    origin_denom,
  }: {
    from_address: string;
    mailbox: string;
    origin_denom: string;
  }) {
    return this.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'HypToken',
      'instantiate',
      [enumeration(0, address(origin_denom)), address(mailbox)],
    );
  }

  public createSyntheticToken({
    from_address,
    mailbox,
    name,
    symbol,
    description,
    divisibility,
  }: {
    from_address: string;
    mailbox: string;
    name: string;
    symbol: string;
    description: string;
    divisibility: number;
  }) {
    return this.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'HypToken',
      'instantiate',
      [
        enumeration(
          1,
          str(name),
          str(symbol),
          str(description),
          u8(divisibility),
        ),
        address(mailbox),
      ],
    );
  }

  public async setTokenOwner({
    from_address,
    token,
    new_owner,
  }: {
    from_address: string;
    token: string;
    new_owner: string;
  }) {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(token);

    const resource = (details.details as any).role_assignments.owner.rule
      .access_rule.proof_rule.requirement.resource;

    return this.transfer({
      from_address,
      to_address: new_owner,
      resource_address: resource,
      amount: '1',
    });
  }

  public async setTokenIsm({
    from_address,
    token,
    ism,
  }: {
    from_address: string;
    token: string;
    ism: string;
  }) {
    return this.createCallMethodManifestWithOwner(
      from_address,
      token,
      'set_ism',
      [enumeration(1, address(ism))],
    );
  }

  public async enrollRemoteRouter({
    from_address,
    token,
    receiver_domain,
    receiver_address,
    gas,
  }: {
    from_address: string;
    token: string;
    receiver_domain: number;
    receiver_address: string;
    gas: string;
  }) {
    return this.createCallMethodManifestWithOwner(
      from_address,
      token,
      'enroll_remote_router',
      [u32(receiver_domain), bytes(strip0x(receiver_address)), decimal(gas)],
    );
  }

  public async unrollRemoteRouter({
    from_address,
    token,
    receiver_domain,
  }: {
    from_address: string;
    token: string;
    receiver_domain: number;
  }) {
    return this.createCallMethodManifestWithOwner(
      from_address,
      token,
      'unroll_remote_router',
      [u32(receiver_domain)],
    );
  }

  public async remoteTransfer({
    from_address,
    token,
    destination_domain,
    recipient,
    amount,
    max_fee,
  }: {
    from_address: string;
    token: string;
    destination_domain: number;
    recipient: string;
    amount: string;
    custom_hook_id: string;
    gas_limit: string;
    custom_hook_metadata: string;
    max_fee: { denom: string; amount: string };
  }) {
    const { origin_denom, divisibility: tokenDecimals } =
      await this.query.getToken({ token });
    const tokenAmount = new Decimal(
      new BigNumber(amount)
        .dividedBy(new BigNumber(10).pow(tokenDecimals))
        .toFixed(tokenDecimals),
    );

    const { divisibility: feeDecimals } = await this.query.getMetadata({
      resource: max_fee.denom,
    });

    const feeAmount = new Decimal(
      new BigNumber(max_fee.amount)
        .dividedBy(new BigNumber(10).pow(feeDecimals))
        .toFixed(feeDecimals),
    );

    assert(origin_denom, `no origin_denom found on token ${token}`);

    return new ManifestBuilder()
      .callMethod(
        'component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh',
        'lock_fee',
        [decimal(this.gasAmount)],
      )
      .callMethod(from_address, 'withdraw', [
        address(origin_denom),
        decimal(tokenAmount),
      ])
      .callMethod(from_address, 'withdraw', [
        address(max_fee.denom),
        decimal(feeAmount),
      ])
      .takeFromWorktop(
        origin_denom,
        new Decimal(amount),
        (builder1, bucketId1) =>
          builder1.takeFromWorktop(
            max_fee.denom,
            new Decimal(feeAmount),
            (builder2, bucketId2) =>
              builder2
                .callMethod(token, 'transfer_remote', [
                  u32(destination_domain),
                  bytes(recipient),
                  bucket(bucketId1),
                  array(ValueKind.Bucket, bucket(bucketId2)),
                ])
                .callMethod(from_address, 'try_deposit_batch_or_refund', [
                  expression('EntireWorktop'),
                  enumeration(0),
                ]),
          ),
      )
      .build();
  }
}
