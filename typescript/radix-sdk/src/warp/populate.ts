import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  address,
  decimal,
  enumeration,
  str,
  u8,
  u32,
} from '@radixdlt/radix-engine-toolkit';
import { BigNumber } from 'bignumber.js';

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
    divisibility,
  }: {
    from_address: string;
    mailbox: string;
    name: string;
    symbol: string;
    divisibility: number;
  }) {
    return this.base.createCallFunctionManifest(
      from_address,
      this.packageAddress,
      'HypToken',
      INSTRUCTIONS.INSTANTIATE,
      [
        enumeration(1, str(name), str(symbol), str(''), u8(divisibility)),
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
    const { denom, decimals } = await this.query.getToken({ token });

    const tokenAmount = new BigNumber(amount)
      .dividedBy(new BigNumber(10).pow(decimals))
      .toFixed(decimals);

    assert(denom, `no origin_denom found on token ${token}`);
    return getTransferRemoteManifest({
      from_address,
      token,
      destination_domain,
      recipient,
      tokenAmount,
      max_fee,
      origin_denom: denom,
    });
  }
}

export function getTransferRemoteManifest({
  from_address,
  token,
  destination_domain,
  recipient,
  tokenAmount,
  max_fee,
  origin_denom,
}: {
  from_address: string;
  token: string;
  origin_denom: string;
  destination_domain: number;
  recipient: string;
  tokenAmount: string;
  max_fee: { denom: string; amount: string };
}): string {
  return `
CALL_METHOD
  Address("${from_address}")
  "withdraw"
  Address("${origin_denom}")
  Decimal("${tokenAmount}")
;
CALL_METHOD
  Address("${from_address}")
  "withdraw"
  Address("${max_fee.denom}")
  Decimal("${max_fee.amount}")
;
TAKE_FROM_WORKTOP
  Address("${origin_denom}")
  Decimal("${tokenAmount}")
  Bucket("bucket1")
;
TAKE_FROM_WORKTOP
  Address("${max_fee.denom}")
  Decimal("${max_fee.amount}")
  Bucket("bucket2")
;
CALL_METHOD
  Address("${token}")
  "transfer_remote"
  ${destination_domain}u32
  Bytes("${recipient}")
  Bucket("bucket1")
  Array<Bucket>(
      Bucket("bucket2")
  )
  Enum<0u8>()
  Enum<0u8>()
;
CALL_METHOD
  Address("${from_address}")
  "try_deposit_batch_or_abort"
  Expression("ENTIRE_WORKTOP")
  Enum<0u8>()
;
`;
}
