import { BigNumber, constants, providers } from 'ethers';

import { PERMIT2_ADDRESS } from '@hyperlane-xyz/sdk';
import { isValidContractVersion } from '@hyperlane-xyz/sdk/utils/contract';
import {
  Address,
  addBufferToGasLimit,
  addressToBytes32,
  eqAddress,
} from '@hyperlane-xyz/utils';

import {
  Adoption,
  COST_MARGIN_PERCENT,
  Fees,
  FundsReport,
  GasStep,
  PAIR_VERSION,
  PeerDomain,
  QuotedCallsCandidate,
  Rejection,
  RouterCandidate,
  Selection,
  ShadowHook,
  TokenAllowance,
  WiringPlan,
} from './types.js';

// Gas allowances for the transactions after the deploys, rounded up from what
// the same calls use on a local chain.
export const POST_DEPLOY_GAS = {
  setHook: BigNumber.from(80_000),
  approve: BigNumber.from(120_000),
  enrollPerPeer: BigNumber.from(150_000),
  transferOwnership: BigNumber.from(80_000),
} as const;

// A standing max approval is granted by approveFeeTokenForHook, so any
// allowance above half of the maximum is treated as already granted.
const APPROVED_THRESHOLD = constants.MaxUint256.div(2);

export function isPairVersion(version: string): boolean {
  return isValidContractVersion(version, PAIR_VERSION);
}

export function selectRouter(
  candidates: RouterCandidate[],
  expected: { mailbox: Address; signer: Address; owner: Address },
): Selection<RouterCandidate> {
  const rejected: Rejection[] = [];
  for (const candidate of candidates) {
    const reason = routerRejection(candidate, expected);
    if (reason === undefined) return { kind: Adoption.Adopt, candidate };
    rejected.push({
      address: candidate.address,
      source: candidate.source,
      reason,
    });
  }
  return { kind: Adoption.Deploy, rejected };
}

function routerRejection(
  candidate: RouterCandidate,
  expected: { mailbox: Address; signer: Address; owner: Address },
): string | undefined {
  if (!isPairVersion(candidate.version)) {
    return `version ${candidate.version} is below ${PAIR_VERSION}`;
  }
  if (!eqAddress(candidate.mailbox, expected.mailbox)) {
    return `mailbox ${candidate.mailbox} is not ${expected.mailbox}`;
  }
  if (
    !eqAddress(candidate.owner, expected.signer) &&
    !eqAddress(candidate.owner, expected.owner)
  ) {
    return `owner ${candidate.owner} is neither the signer nor the target owner`;
  }
  return undefined;
}

export function selectQuotedCalls(
  candidates: QuotedCallsCandidate[],
): Selection<QuotedCallsCandidate> {
  const rejected: Rejection[] = [];
  for (const candidate of candidates) {
    let reason: string | undefined;
    if (!isPairVersion(candidate.version)) {
      reason = `version ${candidate.version} is below ${PAIR_VERSION}`;
    } else if (!eqAddress(candidate.permit2, PERMIT2_ADDRESS)) {
      reason = `permit2 ${candidate.permit2} is not ${PERMIT2_ADDRESS}`;
    }
    if (reason === undefined) return { kind: Adoption.Adopt, candidate };
    rejected.push({
      address: candidate.address,
      source: candidate.source,
      reason,
    });
  }
  return { kind: Adoption.Deploy, rejected };
}

export interface RouterWiringState {
  owner: Address;
  hook: Address;
  remoteRouters: Map<number, string>;
}

export interface PeerRouter extends PeerDomain {
  router?: Address;
}

export function planWiring(args: {
  state: RouterWiringState;
  signer: Address;
  owner: Address;
  shadowHook?: ShadowHook;
  allowances: TokenAllowance[];
  peers: PeerRouter[];
}): WiringPlan {
  const { state, signer, owner, shadowHook, allowances, peers } = args;
  const plan: WiringPlan = {
    approvals: allowances.filter(({ allowance }) =>
      allowance.lt(APPROVED_THRESHOLD),
    ),
    enroll: [],
    awaiting: [],
    conflicts: [],
    notes: [],
  };

  if (shadowHook === undefined) {
    plan.notes.push(
      'no shadow routing hook recorded: keeping the mailbox default hook',
    );
  } else if (shadowHook.problem !== undefined) {
    plan.notes.push(
      `shadow routing hook ${shadowHook.address} ${shadowHook.problem}: keeping the current hook`,
    );
  } else if (!eqAddress(state.hook, shadowHook.address)) {
    plan.setHook = shadowHook.address;
  }

  for (const peer of peers) {
    if (peer.router === undefined) {
      plan.awaiting.push(peer.chain);
      continue;
    }
    const current =
      state.remoteRouters.get(peer.domainId) ?? constants.HashZero;
    const expected = addressToBytes32(peer.router);
    if (current === constants.HashZero) {
      plan.enroll.push({ peer, router: peer.router });
    } else if (current.toLowerCase() !== expected.toLowerCase()) {
      plan.conflicts.push(
        `${peer.chain} is enrolled as ${current}, expected ${expected}; enrollment is immutable`,
      );
    }
  }

  const wiringComplete =
    plan.setHook === undefined &&
    plan.approvals.length === 0 &&
    plan.enroll.length === 0 &&
    plan.awaiting.length === 0 &&
    plan.conflicts.length === 0;
  if (
    wiringComplete &&
    !eqAddress(state.owner, owner) &&
    eqAddress(state.owner, signer)
  ) {
    plan.transferOwnershipTo = owner;
  }
  return plan;
}

// Their L1 data fee on OP stack chains is small next to the funds margin, so
// only the deploy transactions carry one.
export function wiringGasSteps(plan: WiringPlan): GasStep[] {
  const steps: GasStep[] = [];
  const free = (name: string, gas: BigNumber) =>
    steps.push({ name, gas, l1Fee: BigNumber.from(0) });
  if (plan.setHook !== undefined) free('setHook', POST_DEPLOY_GAS.setHook);
  for (const { token } of plan.approvals) {
    free(`approve ${token.symbol}`, POST_DEPLOY_GAS.approve);
  }
  if (plan.enroll.length > 0) {
    free(
      `enroll ${plan.enroll.length} peer(s)`,
      POST_DEPLOY_GAS.enrollPerPeer.mul(plan.enroll.length),
    );
  }
  if (plan.transferOwnershipTo !== undefined) {
    free('transferOwnership', POST_DEPLOY_GAS.transferOwnership);
  }
  return steps;
}

// Every transaction is sent with a gas limit buffered over its estimate and
// the node requires the balance to cover limit x maxFeePerGas up front, so
// the worst case is what decides whether a chain can be finished.
export function assessFunds(args: {
  balance: BigNumber;
  steps: GasStep[];
  fees: Fees;
  l1FeeUnavailable?: boolean;
}): FundsReport {
  const { balance, steps, fees } = args;
  let expected = BigNumber.from(0);
  let worstCase = BigNumber.from(0);
  for (const step of steps) {
    expected = expected.add(step.gas.mul(fees.gasPrice)).add(step.l1Fee);
    worstCase = worstCase
      .add(addBufferToGasLimit(step.gas).mul(fees.maxFeePerGas))
      .add(step.l1Fee);
  }
  const required = worstCase.mul(COST_MARGIN_PERCENT).div(100);
  return {
    balance,
    expected,
    worstCase,
    required,
    shortfall: required.gt(balance) ? required.sub(balance) : BigNumber.from(0),
    steps,
    l1FeeUnavailable: args.l1FeeUnavailable ?? false,
  };
}

// Chain metadata can pin fee parameters; they are what the transactions are
// really sent with, so they replace the provider's suggestion.
export function effectiveFees(
  fees: Fees,
  overrides: Partial<providers.TransactionRequest>,
): Fees {
  const maxFeePerGas =
    overrides.maxFeePerGas !== undefined
      ? BigNumber.from(overrides.maxFeePerGas)
      : overrides.gasPrice !== undefined
        ? BigNumber.from(overrides.gasPrice)
        : fees.maxFeePerGas;
  const suggested =
    overrides.gasPrice !== undefined
      ? BigNumber.from(overrides.gasPrice)
      : fees.gasPrice;
  return {
    gasPrice: suggested.gt(maxFeePerGas) ? maxFeePerGas : suggested,
    maxFeePerGas,
  };
}

// Peers that are not enrolled yet cost one enrollment each whatever their
// router address will be, so a placeholder router stands in for the unknown.
export function estimateWiringSteps(args: {
  state: RouterWiringState;
  signer: Address;
  owner: Address;
  shadowHook?: ShadowHook;
  allowances: TokenAllowance[];
  peers: PeerDomain[];
}): GasStep[] {
  const plan = planWiring({
    state: args.state,
    signer: args.signer,
    owner: args.owner,
    shadowHook: args.shadowHook,
    allowances: args.allowances,
    peers: args.peers.map((peer) => ({
      chain: peer.chain,
      domainId: peer.domainId,
      router: args.signer,
    })),
  });
  plan.transferOwnershipTo = eqAddress(args.state.owner, args.owner)
    ? undefined
    : args.owner;
  return wiringGasSteps(plan);
}
