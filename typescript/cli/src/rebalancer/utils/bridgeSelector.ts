export type BridgeType = 'cctp' | 'oft';

export function selectBridge(config: any): BridgeType {
  const chains = Object.values(config?.strategy?.chains ?? {}) as Array<any>;
  const hasOft = chains.some((c) => typeof c?.bridge === 'string' && c.bridge);
  return hasOft ? 'oft' : 'cctp';
}
