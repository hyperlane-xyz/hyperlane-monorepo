// Bridge selector utility for rebalancer
export function selectBridge(bridges: string[], domain: number): string | undefined {
  // For now, just return the first bridge
  // In the future, this could implement more sophisticated selection logic
  return bridges[0];
}