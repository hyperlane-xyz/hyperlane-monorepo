import { ChainName } from '@hyperlane-xyz/sdk';
import { Address, deepEquals, eqAddress } from '@hyperlane-xyz/utils';

import type { ChainStore } from '../aggregation-hook-upgrade/address-export.js';

import { ContractKind } from './types.js';

export interface ExportedRouter {
  address: Address;
  version: string;
  deployTxHash?: string;
}

export interface ExportedQuotedCalls {
  address: Address;
  version: string;
  permit2: Address;
  deployTxHash?: string;
}

export interface ExportedApproval {
  feeToken: Address;
  spender: Address;
}

export interface RegistryBefore {
  interchainAccountRouterV3?: Address;
  quotedCallsV3?: Address;
}

// A deploy whose transaction was sent but whose confirmation was not seen. The
// address is predicted from the signer's nonce before the transaction is sent.
export interface ExportedPending {
  contract: ContractKind;
  address: Address;
  signer: Address;
  nonce: number;
}

// A router or QuotedCalls this export used to point at, kept so a deployment
// that is replaced stays traceable.
export interface ExportedSuperseded {
  contract: ContractKind;
  address: Address;
  version: string;
  deployTxHash?: string;
}

export interface IcaChainExport {
  signer: Address;
  owner: Address;
  registryBefore: RegistryBefore;
  router?: ExportedRouter;
  quotedCalls?: ExportedQuotedCalls;
  hook?: Address;
  approvals: ExportedApproval[];
  enrolledPeers: ChainName[];
  pending: ExportedPending[];
  superseded: ExportedSuperseded[];
  firstRecordedAt: string;
  updatedAt: string;
}

export interface IcaChainExportUpdate {
  signer: Address;
  owner: Address;
  registryBefore: RegistryBefore;
  router?: ExportedRouter;
  quotedCalls?: ExportedQuotedCalls;
  hook?: Address;
  approvals?: ExportedApproval[];
  enrolledPeers?: ChainName[];
  pending?: ExportedPending;
  clearPending?: ContractKind;
}

export type IcaExportStore = ChainStore<IcaChainExport, IcaChainExportUpdate>;

function mergeApprovals(
  existing: ExportedApproval[],
  incoming: ExportedApproval[],
): ExportedApproval[] {
  const merged = [...existing];
  for (const approval of incoming) {
    if (
      !merged.some(
        (known) =>
          eqAddress(known.feeToken, approval.feeToken) &&
          eqAddress(known.spender, approval.spender),
      )
    ) {
      merged.push(approval);
    }
  }
  return merged.sort((a, b) =>
    `${a.feeToken}${a.spender}`
      .toLowerCase()
      .localeCompare(`${b.feeToken}${b.spender}`.toLowerCase()),
  );
}

function mergeRouter(
  existing: ExportedRouter | undefined,
  incoming: ExportedRouter | undefined,
): ExportedRouter | undefined {
  if (incoming === undefined) return existing;
  if (
    existing === undefined ||
    !eqAddress(existing.address, incoming.address)
  ) {
    return incoming;
  }
  const merged: ExportedRouter = {
    address: incoming.address,
    version: incoming.version,
  };
  const deployTxHash = incoming.deployTxHash ?? existing.deployTxHash;
  if (deployTxHash !== undefined) merged.deployTxHash = deployTxHash;
  return merged;
}

function mergeQuotedCalls(
  existing: ExportedQuotedCalls | undefined,
  incoming: ExportedQuotedCalls | undefined,
): ExportedQuotedCalls | undefined {
  if (incoming === undefined) return existing;
  if (
    existing === undefined ||
    !eqAddress(existing.address, incoming.address)
  ) {
    return incoming;
  }
  const merged: ExportedQuotedCalls = {
    address: incoming.address,
    version: incoming.version,
    permit2: incoming.permit2,
  };
  const deployTxHash = incoming.deployTxHash ?? existing.deployTxHash;
  if (deployTxHash !== undefined) merged.deployTxHash = deployTxHash;
  return merged;
}

function supersededEntry(
  contract: ContractKind,
  replaced: ExportedRouter | ExportedQuotedCalls,
): ExportedSuperseded {
  const entry: ExportedSuperseded = {
    contract,
    address: replaced.address,
    version: replaced.version,
  };
  if (replaced.deployTxHash !== undefined) {
    entry.deployTxHash = replaced.deployTxHash;
  }
  return entry;
}

function mergeSuperseded(
  existing: IcaChainExport | undefined,
  update: IcaChainExportUpdate,
): ExportedSuperseded[] {
  const superseded = [...(existing?.superseded ?? [])];
  const add = (entry: ExportedSuperseded) => {
    if (!superseded.some((known) => eqAddress(known.address, entry.address))) {
      superseded.push(entry);
    }
  };
  const router = existing?.router;
  if (
    router !== undefined &&
    update.router !== undefined &&
    !eqAddress(router.address, update.router.address)
  ) {
    add(supersededEntry(ContractKind.Router, router));
  }
  const quotedCalls = existing?.quotedCalls;
  if (
    quotedCalls !== undefined &&
    update.quotedCalls !== undefined &&
    !eqAddress(quotedCalls.address, update.quotedCalls.address)
  ) {
    add(supersededEntry(ContractKind.QuotedCalls, quotedCalls));
  }
  return superseded;
}

// A pending deploy ends when its contract is recorded or when it is cleared.
function mergePending(
  existing: ExportedPending[],
  update: IcaChainExportUpdate,
): ExportedPending[] {
  const resolved = new Set<ContractKind>();
  if (update.router !== undefined) resolved.add(ContractKind.Router);
  if (update.quotedCalls !== undefined) resolved.add(ContractKind.QuotedCalls);
  if (update.clearPending !== undefined) resolved.add(update.clearPending);
  if (update.pending !== undefined) resolved.add(update.pending.contract);
  const kept = existing.filter(({ contract }) => !resolved.has(contract));
  if (update.pending !== undefined) kept.push(update.pending);
  return kept.sort((a, b) => a.contract.localeCompare(b.contract));
}

// Everything past the router (hook, approvals, enrollments) belongs to one
// router address, so a new router starts those lists over.
export function mergeIcaExport(
  existing: IcaChainExport | undefined,
  update: IcaChainExportUpdate,
  now: string,
): { entry: IcaChainExport; changed: boolean } {
  const sameRouter =
    existing?.router !== undefined &&
    (update.router === undefined ||
      eqAddress(existing.router.address, update.router.address));
  const kept = sameRouter ? existing : undefined;
  const candidate: IcaChainExport = {
    signer: update.signer,
    owner: update.owner,
    registryBefore: existing?.registryBefore ?? update.registryBefore,
    approvals: mergeApprovals(kept?.approvals ?? [], update.approvals ?? []),
    enrolledPeers: [
      ...new Set([
        ...(kept?.enrolledPeers ?? []),
        ...(update.enrolledPeers ?? []),
      ]),
    ].sort(),
    pending: mergePending(existing?.pending ?? [], update),
    superseded: mergeSuperseded(existing, update),
    firstRecordedAt: existing?.firstRecordedAt ?? now,
    updatedAt: existing?.updatedAt ?? now,
  };
  const router = mergeRouter(existing?.router, update.router);
  if (router !== undefined) candidate.router = router;
  const quotedCalls = mergeQuotedCalls(
    existing?.quotedCalls,
    update.quotedCalls,
  );
  if (quotedCalls !== undefined) candidate.quotedCalls = quotedCalls;
  const hook = update.hook ?? kept?.hook;
  if (hook !== undefined) candidate.hook = hook;
  const changed = existing === undefined || !deepEquals(existing, candidate);
  if (changed) candidate.updatedAt = now;
  return { entry: candidate, changed };
}
