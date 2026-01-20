import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  TransactionManifest,
  address,
  decimal,
  enumeration,
  str,
  u8,
  u32,
} from '@radixdlt/radix-engine-toolkit';

import { strip0x } from '@hyperlane-xyz/utils';

import {
  getComponentOwnershipInfo,
  getRadixComponentDetails,
} from '../utils/base-query.js';
import { RadixBase } from '../utils/base.js';
import { INSTRUCTIONS } from '../utils/types.js';
import { bytes } from '../utils/utils.js';

export async function getCreateCollateralTokenTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    mailbox,
    originDenom,
  }: {
    mailbox: string;
    originDenom: string;
  },
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    base.getHyperlanePackageDefAddress(),
    'HypToken',
    INSTRUCTIONS.INSTANTIATE,
    [enumeration(0, address(originDenom)), address(mailbox)],
  );
}

export async function getCreateSyntheticTokenTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    mailbox,
    name,
    symbol,
    divisibility,
  }: {
    mailbox: string;
    name: string;
    symbol: string;
    divisibility: number;
  },
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    base.getHyperlanePackageDefAddress(),
    'HypToken',
    INSTRUCTIONS.INSTANTIATE,
    [
      enumeration(1, str(name), str(symbol), str(''), u8(divisibility)),
      address(mailbox),
    ],
  );
}

export async function getSetTokenOwnerTx(
  base: Readonly<RadixBase>,
  gateway: Readonly<GatewayApiClient>,
  fromAddress: string,
  {
    tokenAddress,
    newOwner,
  }: {
    tokenAddress: string;
    newOwner: string;
  },
): Promise<TransactionManifest> {
  const tokenDetails = await getRadixComponentDetails(
    gateway,
    tokenAddress,
    'HypToken',
  );

  const ownershipInfo = getComponentOwnershipInfo(tokenAddress, tokenDetails);
  const resourceAddress =
    ownershipInfo.rule.access_rule.proof_rule.requirement.resource;

  return base.transfer({
    from_address: fromAddress,
    to_address: newOwner,
    resource_address: resourceAddress,
    amount: '1',
  });
}

export async function getSetTokenIsmTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    tokenAddress,
    ismAddress,
  }: {
    tokenAddress: string;
    ismAddress: string;
  },
): Promise<TransactionManifest> {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    tokenAddress,
    'set_ism',
    [enumeration(1, address(ismAddress))],
  );
}

export async function getEnrollRemoteRouterTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    tokenAddress,
    remoteDomainId,
    remoteRouterAddress,
    destinationGas,
  }: {
    tokenAddress: string;
    remoteDomainId: number;
    remoteRouterAddress: string;
    destinationGas: string;
  },
): Promise<TransactionManifest> {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    tokenAddress,
    'enroll_remote_router',
    [
      u32(remoteDomainId),
      bytes(strip0x(remoteRouterAddress)),
      decimal(destinationGas),
    ],
  );
}

export async function getUnenrollRemoteRouterTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    tokenAddress,
    remoteDomainId,
  }: {
    tokenAddress: string;
    remoteDomainId: number;
  },
): Promise<TransactionManifest> {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    tokenAddress,
    'unroll_remote_router',
    [u32(remoteDomainId)],
  );
}
