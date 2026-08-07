import { BigNumber, constants } from 'ethers';

import {
  CrossCollateralRoutingFee__factory,
  InterchainAccountRouter__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import type { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  type WarpCoreConfig,
  getDomainId,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  addressToBytes32,
  assert,
  bytes32ToAddress,
  eqAddress,
} from '@hyperlane-xyz/utils';

import { warpFeesIcas } from '../../config/environments/mainnet3/governance/ica/warpFees.js';
import { warpFeesSafes } from '../../config/environments/mainnet3/governance/safe/warpFees.js';

export const PRODUCTION_BSC_USDT_FEE_ROOT =
  '0x4c61a80406ee56DC3F1B92872895fD6Be7850741';

export const PRODUCTION_PIECEWISE_USDC_DESTINATIONS = [
  'arbitrum',
  'base',
  'citrea',
  'ethereum',
  'katana',
  'polygon',
  'solanamainnet',
] as const;

const CALL_REMOTE_SIGNATURE =
  'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)' as const;
const SET_FEE_CONTRACTS_SIGNATURE =
  'setCrossCollateralRouterFeeContracts(uint32[],bytes32[],address[])' as const;

const SET_FEE_RECIPIENT_SELECTOR =
  TokenRouter__factory.createInterface().getSighash('setFeeRecipient(address)');
const SET_FEE_CONTRACTS_SELECTOR =
  CrossCollateralRoutingFee__factory.createInterface().getSighash(
    SET_FEE_CONTRACTS_SIGNATURE,
  );

export interface ExpectedProductionPiecewiseLane {
  destination: string;
  domainId: number;
  targetRouterKey: string;
}

export interface ProductionPiecewiseIcaPayloadExpectations {
  ethereumChainId: number;
  bscDomainId: number;
  ethereumWarpFeesSafe: Address;
  ethereumIcaRouter: Address;
  bscIcaRouter: Address;
  bscFeeOwner: Address;
  bscFeeRoot: Address;
  lanes: ExpectedProductionPiecewiseLane[];
}

export interface DecodedProductionPiecewiseLane extends ExpectedProductionPiecewiseLane {
  feeContract: Address;
}

export interface DecodedProductionPiecewiseIcaPayload {
  mode: 'read-only';
  outerTransaction: {
    chainId: number;
    from: Address;
    to: Address;
    value?: string;
  };
  bscTransaction: {
    annotation: string;
    chainId: number;
    from: Address;
    to: Address;
    value: string;
    data: string;
  };
  lanes: DecodedProductionPiecewiseLane[];
}

interface FileTransaction {
  chainId?: unknown;
  from?: unknown;
  to?: unknown;
  value?: unknown;
  data?: unknown;
}

function asNumber(value: unknown, label: string): number {
  try {
    const parsed = BigNumber.from(value);
    assert(
      parsed.lte(Number.MAX_SAFE_INTEGER.toString()),
      `${label} is too large`,
    );
    return parsed.toNumber();
  } catch (error) {
    throw new Error(`${label} is not a valid integer`, { cause: error });
  }
}

function asAddress(value: unknown, label: string): Address {
  assert(typeof value === 'string', `${label} must be an address string`);
  try {
    return bytes32ToAddress(addressToBytes32(value));
  } catch (error) {
    throw new Error(`${label} is not a valid EVM address`, { cause: error });
  }
}

function asData(value: unknown, label: string): string {
  assert(
    typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value),
    `${label} must be hex calldata`,
  );
  return value;
}

function parseTransaction(
  iface: ReturnType<
    | typeof InterchainAccountRouter__factory.createInterface
    | typeof CrossCollateralRoutingFee__factory.createInterface
  >,
  data: string,
  label: string,
) {
  try {
    return iface.parseTransaction({ data });
  } catch (error) {
    throw new Error(`${label} could not be decoded`, { cause: error });
  }
}

function laneKey(domainId: number, targetRouterKey: string): string {
  return `${domainId}:${targetRouterKey.toLowerCase()}`;
}

/**
 * Builds strict expectations from the checked-in registry view. This function
 * performs no RPC calls and never writes a registry or transaction.
 */
export function buildProductionPiecewiseIcaPayloadExpectations({
  chainMetadata,
  chainAddresses,
  usdcRoute,
}: {
  chainMetadata: Record<string, ChainMetadata>;
  chainAddresses: Record<string, ChainAddresses>;
  usdcRoute: WarpCoreConfig;
}): ProductionPiecewiseIcaPayloadExpectations {
  const ethereum = chainMetadata.ethereum;
  const bsc = chainMetadata.bsc;
  const ethereumIcaRouter = chainAddresses.ethereum?.interchainAccountRouter;
  const bscIcaRouter = chainAddresses.bsc?.interchainAccountRouter;
  assert(ethereum, 'Registry is missing Ethereum metadata');
  assert(bsc, 'Registry is missing BSC metadata');
  assert(
    ethereumIcaRouter,
    'Registry is missing the Ethereum interchainAccountRouter',
  );
  assert(bscIcaRouter, 'Registry is missing the BSC interchainAccountRouter');
  assert(
    warpFeesSafes.ethereum,
    'WarpFees governance is missing the Ethereum Safe',
  );
  assert(warpFeesIcas.bsc, 'WarpFees governance is missing the BSC ICA');

  const lanes = PRODUCTION_PIECEWISE_USDC_DESTINATIONS.map((destination) => {
    const metadata = chainMetadata[destination];
    const target = usdcRoute.tokens.find(
      ({ chainName }) => chainName === destination,
    );
    assert(metadata, `Registry is missing ${destination} metadata`);
    assert(
      target?.addressOrDenom,
      `USDC/moonpay is missing its ${destination} token`,
    );
    return {
      destination,
      domainId: getDomainId(metadata),
      targetRouterKey: addressToBytes32(target.addressOrDenom),
    };
  });

  return {
    ethereumChainId: asNumber(ethereum.chainId, 'Ethereum chain ID'),
    bscDomainId: getDomainId(bsc),
    ethereumWarpFeesSafe: warpFeesSafes.ethereum,
    ethereumIcaRouter,
    bscIcaRouter,
    bscFeeOwner: warpFeesIcas.bsc,
    bscFeeRoot: PRODUCTION_BSC_USDT_FEE_ROOT,
    lanes,
  };
}

/**
 * Decodes and validates an ICA/file submitter artifact without touching a
 * provider. The returned BSC transaction is suitable for a separate fork-only
 * impersonated-account submission step; this helper never submits it.
 */
export function decodeProductionPiecewiseIcaPayload(
  payload: unknown,
  expected: ProductionPiecewiseIcaPayloadExpectations,
): DecodedProductionPiecewiseIcaPayload {
  assert(Array.isArray(payload), 'ICA file payload must be an array');
  assert(
    payload.length === 1,
    `ICA file payload must contain exactly one Ethereum outer call; got ${payload.length}`,
  );
  const outer = payload[0] as FileTransaction;
  const outerChainId = asNumber(outer.chainId, 'Outer transaction chainId');
  const outerFrom = asAddress(outer.from, 'Outer transaction from');
  const outerTo = asAddress(outer.to, 'Outer transaction to');
  const outerData = asData(outer.data, 'Outer transaction data');

  assert(
    outerChainId === expected.ethereumChainId,
    `Outer transaction must be on Ethereum chain ${expected.ethereumChainId}; got ${outerChainId}`,
  );
  assert(
    eqAddress(outerFrom, expected.ethereumWarpFeesSafe),
    `Outer transaction must be from the Ethereum WarpFees Safe ${expected.ethereumWarpFeesSafe}; got ${outerFrom}`,
  );
  assert(
    eqAddress(outerTo, expected.ethereumIcaRouter),
    `Outer transaction must target the registry Ethereum ICA router ${expected.ethereumIcaRouter}; got ${outerTo}`,
  );

  const decodedOuter = parseTransaction(
    InterchainAccountRouter__factory.createInterface(),
    outerData,
    'Outer ICA call',
  );
  assert(
    decodedOuter.signature === CALL_REMOTE_SIGNATURE,
    `Outer transaction must call ${CALL_REMOTE_SIGNATURE}; got ${decodedOuter.signature}`,
  );
  const destinationDomain = asNumber(
    decodedOuter.args[0],
    'ICA destination domain',
  );
  const remoteIcaRouter = asAddress(
    decodedOuter.args[1],
    'ICA destination router',
  );
  assert(
    destinationDomain === expected.bscDomainId,
    `ICA destination must be BSC domain ${expected.bscDomainId}; got ${destinationDomain}`,
  );
  assert(
    eqAddress(remoteIcaRouter, expected.bscIcaRouter),
    `ICA destination router must be the registry BSC ICA router ${expected.bscIcaRouter}; got ${remoteIcaRouter}`,
  );

  const innerCalls = decodedOuter.args[3] as Array<{
    to: string;
    value: unknown;
    data: string;
  }>;
  assert(
    innerCalls.length === 1,
    `ICA payload must contain exactly one BSC inner call; got ${innerCalls.length}`,
  );
  const [inner] = innerCalls;
  const innerTarget = asAddress(inner.to, 'ICA inner target');
  const innerValue = BigNumber.from(inner.value);
  const innerData = asData(inner.data, 'ICA inner data');
  assert(innerValue.isZero(), 'ICA inner call must not send native value');
  assert(
    eqAddress(innerTarget, expected.bscFeeRoot),
    `ICA inner call must target the existing BSC fee root ${expected.bscFeeRoot}; got ${innerTarget}`,
  );
  assert(
    !innerData.toLowerCase().startsWith(SET_FEE_RECIPIENT_SELECTOR),
    'setFeeRecipient is forbidden in the production piecewise fee payload',
  );
  assert(
    innerData.toLowerCase().startsWith(SET_FEE_CONTRACTS_SELECTOR),
    `BSC inner call must call ${SET_FEE_CONTRACTS_SIGNATURE}`,
  );

  const decodedFeeUpdate = parseTransaction(
    CrossCollateralRoutingFee__factory.createInterface(),
    innerData,
    'BSC fee-root call',
  );
  assert(
    decodedFeeUpdate.signature === SET_FEE_CONTRACTS_SIGNATURE,
    `BSC fee-root call must be ${SET_FEE_CONTRACTS_SIGNATURE}; got ${decodedFeeUpdate.signature}`,
  );
  const destinations = decodedFeeUpdate.args[0] as unknown[];
  const targetRouterKeys = decodedFeeUpdate.args[1] as string[];
  const feeContracts = decodedFeeUpdate.args[2] as string[];
  assert(
    destinations.length === 7 &&
      targetRouterKeys.length === 7 &&
      feeContracts.length === 7,
    `Fee-root update must contain exactly seven entries; got ${destinations.length}/${targetRouterKeys.length}/${feeContracts.length}`,
  );
  assert(
    expected.lanes.length === 7,
    `Expected lane set must contain exactly seven entries; got ${expected.lanes.length}`,
  );

  const expectedByKey = new Map(
    expected.lanes.map((lane) => [
      laneKey(lane.domainId, lane.targetRouterKey),
      lane,
    ]),
  );
  assert(
    expectedByKey.size === 7,
    'Expected production lane set contains duplicates',
  );

  const seenLanes = new Set<string>();
  const seenFeeContracts = new Set<string>();
  const lanes: DecodedProductionPiecewiseLane[] = destinations.map(
    (destination, index) => {
      const domainId = asNumber(destination, `Fee entry ${index} domain`);
      const targetRouterKey = asData(
        targetRouterKeys[index],
        `Fee entry ${index} target router`,
      );
      assert(
        targetRouterKey.length === 66,
        `Fee entry ${index} target router must be bytes32`,
      );
      const key = laneKey(domainId, targetRouterKey);
      const expectedLane = expectedByKey.get(key);
      assert(
        expectedLane,
        `Unexpected fee entry for domain ${domainId} and target ${targetRouterKey}`,
      );
      assert(!seenLanes.has(key), `Duplicate fee entry for ${key}`);
      seenLanes.add(key);

      const feeContract = asAddress(
        feeContracts[index],
        `Fee entry ${index} fee contract`,
      );
      assert(
        !eqAddress(feeContract, constants.AddressZero),
        `Fee entry ${index} has a zero fee contract`,
      );
      const normalizedFeeContract = feeContract.toLowerCase();
      assert(
        !seenFeeContracts.has(normalizedFeeContract),
        `Piecewise fee contract ${feeContract} is reused across lanes`,
      );
      seenFeeContracts.add(normalizedFeeContract);

      return { ...expectedLane, feeContract };
    },
  );
  assert(
    seenLanes.size === expectedByKey.size,
    'Fee-root update does not cover the exact seven production lanes',
  );

  return {
    mode: 'read-only',
    outerTransaction: {
      chainId: outerChainId,
      from: outerFrom,
      to: outerTo,
      ...(outer.value === undefined
        ? {}
        : { value: BigNumber.from(outer.value).toString() }),
    },
    bscTransaction: {
      annotation:
        'Fork-only: update seven BSC USDT -> USDC piecewise fee pointers',
      chainId: expected.bscDomainId,
      from: expected.bscFeeOwner,
      to: expected.bscFeeRoot,
      value: '0',
      data: innerData,
    },
    lanes,
  };
}
