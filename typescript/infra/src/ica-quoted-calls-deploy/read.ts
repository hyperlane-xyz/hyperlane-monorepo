import { BigNumber } from 'ethers';

import { OnchainHookType } from '@hyperlane-xyz/sdk';
import { Address, concurrentMap, eqAddress } from '@hyperlane-xyz/utils';

import { isFixedVersion } from '../aggregation-hook-upgrade/plan.js';

import type { ExportedPending } from './export.js';
import type { IcaChainReader } from './reader.js';
import {
  CandidateSource,
  FeeToken,
  PeerDomain,
  QuotedCallsCandidate,
  RouterCandidate,
  ShadowHook,
  TokenAllowance,
} from './types.js';

export interface CandidateAddress {
  address: Address;
  source: CandidateSource;
}

// The registry is only a discovery source: the same address can come from
// several, and every candidate is judged by its on-chain state.
export function candidateAddresses(
  registry: Address | undefined,
  recorded: Address | undefined,
  pending?: Address,
): CandidateAddress[] {
  const candidates: CandidateAddress[] = [];
  const add = (address: Address | undefined, source: CandidateSource) => {
    if (address === undefined) return;
    if (candidates.some((known) => eqAddress(known.address, address))) return;
    candidates.push({ address, source });
  };
  add(registry, CandidateSource.Registry);
  add(recorded, CandidateSource.Export);
  add(pending, CandidateSource.Pending);
  return candidates;
}

export const PendingState = {
  // The contract exists, so it is judged like any other candidate.
  Deployed: 'deployed',
  // The transaction that would create it is not mined yet.
  Unmined: 'unmined',
  // The signer's nonce moved on without creating it.
  Abandoned: 'abandoned',
} as const;
export type PendingState = (typeof PendingState)[keyof typeof PendingState];

export async function readPendingState(
  reader: IcaChainReader,
  pending: ExportedPending,
): Promise<PendingState> {
  if (await reader.hasCode(pending.address)) return PendingState.Deployed;
  const mined = await reader.minedTransactionCount(pending.signer);
  return mined > pending.nonce ? PendingState.Abandoned : PendingState.Unmined;
}

export interface Candidates<Candidate> {
  found: Candidate[];
  missingCode: CandidateAddress[];
}

export async function readRouterCandidates(
  reader: IcaChainReader,
  addresses: CandidateAddress[],
): Promise<Candidates<RouterCandidate>> {
  const found: RouterCandidate[] = [];
  const missingCode: CandidateAddress[] = [];
  for (const { address, source } of addresses) {
    if (!(await reader.hasCode(address))) {
      missingCode.push({ address, source });
      continue;
    }
    const [version, state] = await Promise.all([
      reader.packageVersion(address),
      reader.routerState(address),
    ]);
    found.push({
      address,
      source,
      version,
      owner: state.owner,
      mailbox: state.mailbox,
      hook: state.hook,
    });
  }
  return { found, missingCode };
}

export async function readQuotedCallsCandidates(
  reader: IcaChainReader,
  addresses: CandidateAddress[],
): Promise<Candidates<QuotedCallsCandidate>> {
  const found: QuotedCallsCandidate[] = [];
  const missingCode: CandidateAddress[] = [];
  for (const { address, source } of addresses) {
    if (!(await reader.hasCode(address))) {
      missingCode.push({ address, source });
      continue;
    }
    const [version, permit2] = await Promise.all([
      reader.packageVersion(address),
      reader.quotedCallsPermit2(address),
    ]);
    found.push({ address, source, version, permit2 });
  }
  return { found, missingCode };
}

// The shadow routing hook was deployed by the aggregation hook upgrade; it is
// only wired to a router when it is a fallback routing hook of this mailbox
// that is new enough to accept ERC20 fee metadata.
export async function validateShadowHook(
  reader: IcaChainReader,
  address: Address,
  mailbox: Address,
): Promise<ShadowHook> {
  if (!(await reader.hasCode(address))) {
    return { address, problem: 'has no code' };
  }
  const { hookType, mailbox: hookMailbox } = await reader.hookState(address);
  if (hookType !== OnchainHookType.FALLBACK_ROUTING) {
    return { address, problem: `has hook type ${hookType}` };
  }
  if (!eqAddress(hookMailbox, mailbox)) {
    return { address, problem: `belongs to mailbox ${hookMailbox}` };
  }
  const version = await reader.packageVersion(address);
  if (!isFixedVersion(version)) {
    return { address, problem: `reports version ${version}` };
  }
  return { address };
}

// A token is approved only where the IGP prices it for a selected destination.
export async function splitPricedTokens(
  reader: IcaChainReader,
  args: { igp: Address; tokens: FeeToken[]; peers: PeerDomain[] },
): Promise<{ priced: FeeToken[]; unpriced: FeeToken[] }> {
  const { igp, tokens, peers } = args;
  const checked = await concurrentMap(4, tokens, async (token) => ({
    token,
    isPriced: await reader.hasTokenGasOracle(
      igp,
      token.address,
      peers.map((peer) => peer.domainId),
    ),
  }));
  return {
    priced: checked
      .filter(({ isPriced }) => isPriced)
      .map(({ token }) => token),
    unpriced: checked
      .filter(({ isPriced }) => !isPriced)
      .map(({ token }) => token),
  };
}

export async function readAllowances(
  reader: IcaChainReader,
  args: { router: Address; igp: Address; tokens: FeeToken[] },
): Promise<TokenAllowance[]> {
  const { router, igp } = args;
  return concurrentMap(4, args.tokens, async (token) => ({
    token,
    spender: igp,
    allowance: await reader.allowance(token.address, router, igp),
  }));
}

export function noAllowances(
  igp: Address,
  tokens: FeeToken[],
): TokenAllowance[] {
  return tokens.map((token) => ({
    token,
    spender: igp,
    allowance: BigNumber.from(0),
  }));
}

export async function readRemoteRouters(
  reader: IcaChainReader,
  router: Address,
  peers: PeerDomain[],
): Promise<Map<number, string>> {
  const entries = await concurrentMap(
    8,
    peers,
    async (peer): Promise<[number, string]> => [
      peer.domainId,
      await reader.remoteRouter(router, peer.domainId),
    ],
  );
  return new Map(entries);
}
