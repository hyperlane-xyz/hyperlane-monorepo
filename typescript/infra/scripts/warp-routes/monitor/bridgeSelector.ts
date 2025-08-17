export type BridgeType = 'cctp' | 'oft';

/**
 * Select bridge type based on configured bridge addresses.
 * If any chain has a TokenBridgeOft address configured, prefer 'oft' for that route.
 * Otherwise, default to 'cctp'.
 *
 * Expected config shape (subset):
 * {
 *   chains: {
 *     [chainName: string]: {
 *       bridge?: string; // address of the bridge contract on that chain
 *     }
 *   },
 *   oft?: {
 *     // optional extra LayerZero config presence is a signal as well
 *   }
 * }
 */
export function selectBridge(config: any): BridgeType {
  const chainEntries = Object.values(config?.chains ?? {}) as Array<any>;
  const hasOftBridge = chainEntries.some(
    (c) => typeof c?.bridge === 'string' && c.bridge && (config?.oft || true),
  );
  return hasOftBridge ? 'oft' : 'cctp';
}
