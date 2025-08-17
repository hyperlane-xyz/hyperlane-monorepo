export type BridgeType = "cctp" | "oft";

export function selectBridge(config: any): BridgeType {
  if (config?.bridge === "oft") return "oft";
  return "cctp";
}
