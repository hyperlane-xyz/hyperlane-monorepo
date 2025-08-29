import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  ManifestBuilder,
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
} from '@radixdlt/radix-engine-toolkit';
import { BigNumber } from 'bignumber.js';
import { Decimal } from 'decimal.js';

import { assert, strip0x } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { EntityDetails, INSTRUCTIONS } from '../utils/types.js';
import { bytes } from '../utils/utils.js';

import { RadixWarpQuery } from './query.js';

export class RadixWarpPopulate {
  protected gateway: GatewayApiClient;
  protected base: RadixBase;
  protected query: RadixWarpQuery;
  protected packageAddress: string;

  constructor(
    gateway: GatewayApiClient,
    base: RadixBase,
    query: RadixWarpQuery,
    packageAddress: string,
  ) {
    this.gateway = gateway;
    this.base = base;
    this.query = query;
    this.packageAddress = packageAddress;
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
    return this.base.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'HypToken',
      INSTRUCTIONS.INSTANTIATE,
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
    return this.base.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'HypToken',
      INSTRUCTIONS.INSTANTIATE,
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

    const resource = (details.details as EntityDetails).role_assignments.owner
      .rule.access_rule.proof_rule.requirement.resource;

    return this.base.transfer({
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
    return this.base.createCallMethodManifestWithOwner(
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
    return this.base.createCallMethodManifestWithOwner(
      from_address,
      token,
      'enroll_remote_router',
      [u32(receiver_domain), bytes(strip0x(receiver_address)), decimal(gas)],
    );
  }

  public async unenrollRemoteRouter({
    from_address,
    token,
    receiver_domain,
  }: {
    from_address: string;
    token: string;
    receiver_domain: number;
  }) {
    return this.base.createCallMethodManifestWithOwner(
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
    const { origin_denom, divisibility } = await this.query.getToken({ token });

    const tokenAmount = new Decimal(
      new BigNumber(amount)
        .dividedBy(new BigNumber(10).pow(divisibility))
        .toFixed(divisibility),
    );

    assert(origin_denom, `no origin_denom found on token ${token}`);

    return new ManifestBuilder()
      .callMethod(from_address, INSTRUCTIONS.WITHDRAW, [
        address(origin_denom),
        decimal(tokenAmount),
      ])
      .callMethod(from_address, INSTRUCTIONS.WITHDRAW, [
        address(max_fee.denom),
        decimal(max_fee.amount),
      ])
      .takeFromWorktop(origin_denom, tokenAmount, (builder1, bucketId1) =>
        builder1.takeFromWorktop(
          max_fee.denom,
          new Decimal(max_fee.amount),
          (builder2, bucketId2) =>
            builder2
              .callMethod(token, 'transfer_remote', [
                u32(destination_domain),
                bytes(recipient),
                bucket(bucketId1),
                array(ValueKind.Bucket, bucket(bucketId2)),
                enumeration(0),
                enumeration(0),
              ])
              .callMethod(
                from_address,
                INSTRUCTIONS.TRY_DEPOSIT_BATCH_OR_REFUND,
                [expression('EntireWorktop'), enumeration(0)],
              ),
        ),
      )
      .build();
  }
}
