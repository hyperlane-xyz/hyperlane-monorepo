/**
 * Partition the chains requested from `get-owner-ica.ts` into those that can
 * produce an ICA (EVM/Tron, not skip-listed) and those that are dropped
 * (non-EVM or skip-listed), and separately flag the dropped chains the caller
 * asked for *explicitly* via `--chains`.
 *
 * The explicit distinction drives the process exit code: dropping a chain from
 * the default full set is expected and benign (many chains simply have no ICA),
 * but dropping a chain the caller named explicitly produces no ICA result for a
 * chain they wanted — so the run must fail rather than let a caller treat an
 * owner/deploy step as complete when it silently did nothing for that chain.
 *
 * Pure: no filesystem, provider, or process access.
 */
export interface RequestedChainPartition {
  /** Chains an ICA will be derived/deployed for. */
  icaChains: string[];
  /** Chains dropped because they are non-EVM or in the skip list. */
  droppedChains: string[];
  /** The subset of `droppedChains` the caller requested explicitly via --chains. */
  explicitlyDroppedChains: string[];
}

export function partitionRequestedChains(args: {
  requestedChains: string[];
  /** The explicit `--chains` set, or `undefined` when the default full set is used. */
  explicitlyRequested: Set<string> | undefined;
  isEvmChain: (chain: string) => boolean;
  skipList: string[];
}): RequestedChainPartition {
  const { requestedChains, explicitlyRequested, isEvmChain, skipList } = args;

  const icaChains: string[] = [];
  const droppedChains: string[] = [];
  const explicitlyDroppedChains: string[] = [];

  for (const chain of requestedChains) {
    const dropped = !isEvmChain(chain) || skipList.includes(chain);
    if (dropped) {
      droppedChains.push(chain);
      if (explicitlyRequested?.has(chain)) {
        explicitlyDroppedChains.push(chain);
      }
    } else {
      icaChains.push(chain);
    }
  }

  return { icaChains, droppedChains, explicitlyDroppedChains };
}
