export interface SvmTestEnvironment {
  rpcUrl: string;
  wsUrl?: string;
}

export function createSvmTestEnvironment(rpcUrl: string): SvmTestEnvironment {
  return { rpcUrl };
}
