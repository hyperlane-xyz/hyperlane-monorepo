import { ethers } from 'ethers';
import { z } from 'zod';

import {
  Address,
  assert,
  eqAddress,
  isValidAddressEvm,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../config/deploy-environment.js';
import { GovernanceType } from '../governanceTypes.js';

const EvmAddressSchema = z
  .string()
  .refine(isValidAddressEvm, 'Must be a valid EVM address')
  .refine((address) => !isZeroishAddress(address), 'Must be non-zero')
  .transform((address) => ethers.utils.getAddress(address));

const IcaOverrideSchema = z
  .object({
    account: EvmAddressSchema.optional(),
    routerOverride: EvmAddressSchema.optional(),
  })
  .strict();

const ChainHandoffConfigSchema = z
  .object({
    owner: EvmAddressSchema,
    sourceSafe: EvmAddressSchema.optional(),
    ica: IcaOverrideSchema.optional(),
    additionalContracts: z.record(EvmAddressSchema).default({}),
    allowContractOwner: z.boolean().default(false),
  })
  .strict();

export const CoreOwnershipHandoffConfigSchema = z
  .object({
    environment: z.enum(['test', 'testnet4', 'mainnet3']),
    governance: z
      .object({
        origin: z.string().min(1).default('ethereum'),
        type: z.nativeEnum(GovernanceType).default(GovernanceType.Regular),
        safe: EvmAddressSchema.optional(),
        localRouter: EvmAddressSchema.optional(),
      })
      .strict()
      .default({ origin: 'ethereum', type: GovernanceType.Regular }),
    chains: z
      .record(ChainHandoffConfigSchema)
      .refine((chains) => Object.keys(chains).length > 0, {
        message: 'At least one handoff chain is required',
      }),
  })
  .strict();

export type CoreOwnershipHandoffConfig = z.infer<
  typeof CoreOwnershipHandoffConfigSchema
>;

export type OwnableCandidate = {
  address: Address;
  labels: string[];
};

export type OwnableState = OwnableCandidate & {
  owner: Address;
  beneficiary?: Address;
  ownershipMode: 'one-step' | 'two-step';
};

export type HandoffRoute = 'deployer' | 'ica' | 'safe';

export type PlannedHandoffCall = {
  to: Address;
  data: string;
  value: string;
  description: string;
  labels: string[];
  operation: 'setBeneficiary' | 'transferOwnership';
};

export type PlannedIcaCall = {
  to: Address;
  data: string;
  value: string;
  description: string;
};

export type ChainHandoffPlan = {
  chain: string;
  target: Address;
  targetType: 'eoa' | 'delegated-eoa' | 'safe' | 'contract';
  sources: {
    deployer: Address;
    ica: Address;
    safe?: Address;
  };
  calls: Record<HandoffRoute, PlannedHandoffCall[]>;
  icaCall?: PlannedIcaCall;
  alreadyOwned: OwnableCandidate[];
  missingRegistryLabels: string[];
};

export type CoreOwnershipHandoffPlan = {
  environment: DeployEnvironment;
  governance: {
    origin: string;
    type: GovernanceType;
    safe: Address;
  };
  chains: ChainHandoffPlan[];
  hash: string;
};

const ownableInterface = new ethers.utils.Interface([
  'function transferOwnership(address newOwner)',
]);
const beneficiaryInterface = new ethers.utils.Interface([
  'function setBeneficiary(address beneficiary)',
]);

const BENEFICIARY_LABELS = new Set(['interchainGasPaymaster', 'protocolFee']);

export const CORE_OWNABLE_CONTRACT_LABELS = [
  'domainRoutingIsm',
  'fallbackRoutingHook',
  'interchainAccountRouter',
  'interchainGasPaymaster',
  'mailbox',
  'merkleTreeHook',
  'pausableHook',
  'pausableIsm',
  'protocolFee',
  'proxyAdmin',
  'storageGasOracle',
  'testRecipient',
  'validatorAnnounce',
] as const;

function normalizeAddress(address: Address): Address {
  return ethers.utils.getAddress(address);
}

/**
 * Builds a deterministic, de-duplicated list of known core Ownable addresses.
 * Multiple registry labels can point at the same contract, and legacy
 * deployments may not contain every currently known label.
 */
export function collectOwnableCandidates(
  chainAddresses: Record<string, unknown>,
  additionalContracts: Record<string, Address> = {},
): { candidates: OwnableCandidate[]; missingRegistryLabels: string[] } {
  const byAddress = new Map<string, OwnableCandidate>();
  for (const [label, additionalAddress] of Object.entries(
    additionalContracts,
  )) {
    const registryAddress = chainAddresses[label];
    assert(
      typeof registryAddress !== 'string' ||
        eqAddress(registryAddress, additionalAddress),
      `Additional contract label ${label} conflicts with registry address ${registryAddress}`,
    );
  }
  const missingRegistryLabels: string[] = [];
  const entries: [string, unknown][] = [];
  for (const label of CORE_OWNABLE_CONTRACT_LABELS) {
    const value = chainAddresses[label];
    if (value === undefined) {
      missingRegistryLabels.push(label);
    } else {
      entries.push([label, value]);
    }
  }
  entries.push(...Object.entries(additionalContracts));

  for (const [label, value] of entries) {
    assert(
      typeof value === 'string' &&
        isValidAddressEvm(value) &&
        !isZeroishAddress(value),
      `Invalid address for ${label}: ${String(value)}`,
    );

    const address = normalizeAddress(value);
    const key = address.toLowerCase();
    const existing = byAddress.get(key);
    if (existing) {
      if (!existing.labels.includes(label)) existing.labels.push(label);
    } else {
      byAddress.set(key, { address, labels: [label] });
    }
  }

  return {
    candidates: [...byAddress.values()]
      .map((candidate) => ({
        ...candidate,
        labels: candidate.labels.sort(),
      }))
      .sort(
        (left, right) =>
          left.labels[0].localeCompare(right.labels[0]) ||
          left.address.localeCompare(right.address),
      ),
    missingRegistryLabels,
  };
}

function encodeCall(
  state: OwnableState,
  operation: PlannedHandoffCall['operation'],
  target: Address,
): PlannedHandoffCall {
  const iface =
    operation === 'setBeneficiary' ? beneficiaryInterface : ownableInterface;
  return {
    to: state.address,
    data: iface.encodeFunctionData(operation, [target]),
    value: '0',
    description: `${operation} on ${state.labels.join(', ')} (${state.address}) to ${target}`,
    labels: state.labels,
    operation,
  };
}

function getRoute(
  chain: string,
  state: OwnableState,
  deployer: Address,
  sourceIca: Address,
  sourceSafe?: Address,
): HandoffRoute {
  if (eqAddress(state.owner, deployer)) return 'deployer';
  if (eqAddress(state.owner, sourceIca)) return 'ica';
  if (sourceSafe && eqAddress(state.owner, sourceSafe)) return 'safe';
  throw new Error(
    `[${chain}] ${state.labels.join(', ')} (${state.address}) has unexpected owner ${state.owner}; expected deployer ${deployer}, ICA ${sourceIca}${sourceSafe ? `, or Safe ${sourceSafe}` : ''}`,
  );
}

export function buildChainHandoffPlan({
  chain,
  target,
  targetType,
  deployer,
  sourceIca,
  sourceSafe,
  states,
  missingRegistryLabels = [],
}: {
  chain: string;
  target: Address;
  targetType: ChainHandoffPlan['targetType'];
  deployer: Address;
  sourceIca: Address;
  sourceSafe?: Address;
  states: OwnableState[];
  missingRegistryLabels?: string[];
}): ChainHandoffPlan {
  const calls: ChainHandoffPlan['calls'] = {
    deployer: [],
    ica: [],
    safe: [],
  };
  const alreadyOwned: OwnableCandidate[] = [];

  for (const state of states) {
    assert(
      state.ownershipMode === 'one-step',
      `[${chain}] ${state.labels.join(', ')} (${state.address}) uses two-step ownership; complete it manually`,
    );

    const managesBeneficiary = state.labels.some((label) =>
      BENEFICIARY_LABELS.has(label),
    );
    if (eqAddress(state.owner, target)) {
      assert(
        !managesBeneficiary ||
          (state.beneficiary && eqAddress(state.beneficiary, target)),
        `[${chain}] ${state.labels.join(', ')} is already target-owned but beneficiary is ${state.beneficiary ?? 'unreadable'}`,
      );
      alreadyOwned.push({ address: state.address, labels: state.labels });
      continue;
    }

    const route = getRoute(chain, state, deployer, sourceIca, sourceSafe);
    if (
      managesBeneficiary &&
      (!state.beneficiary || !eqAddress(state.beneficiary, target))
    ) {
      calls[route].push(encodeCall(state, 'setBeneficiary', target));
    }
    calls[route].push(encodeCall(state, 'transferOwnership', target));
  }

  return {
    chain,
    target: normalizeAddress(target),
    targetType,
    sources: {
      deployer: normalizeAddress(deployer),
      ica: normalizeAddress(sourceIca),
      ...(sourceSafe ? { safe: normalizeAddress(sourceSafe) } : {}),
    },
    calls,
    alreadyOwned,
    missingRegistryLabels,
  };
}

export function finalizeHandoffPlan(
  plan: Omit<CoreOwnershipHandoffPlan, 'hash'>,
): CoreOwnershipHandoffPlan {
  const hash = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(JSON.stringify(plan)),
  );
  return { ...plan, hash };
}

export function hasPlannedCalls(plan: ChainHandoffPlan): boolean {
  return Object.values(plan.calls).some((calls) => calls.length > 0);
}
