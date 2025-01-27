import { HookType, HyperlaneRelayer } from '@hyperlane-xyz/sdk';

/**
 * Workaround helper for bypassing bad hook derivation when self-relaying.
 */
export function stubMerkleTreeConfig(
  relayer: HyperlaneRelayer,
  chain: string,
  hookAddress: string,
  merkleAddress: string,
) {
  relayer.hydrate({
    hook: {
      [chain]: {
        [hookAddress]: {
          type: HookType.MERKLE_TREE,
          address: merkleAddress,
        },
      },
    },
    ism: {},
    backlog: [],
  });
}
