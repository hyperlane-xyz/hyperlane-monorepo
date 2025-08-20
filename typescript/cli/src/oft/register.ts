import type { WriteCommandContext } from '../context/types.js';

type OftRegisterInput = {
  symbol: string;
  decimals?: number;
  warpRouteId?: string;
  chains: Record<string, { bridge: string; decimals?: number }>;
};

export async function runOftRegister(params: {
  context: WriteCommandContext;
  input: OftRegisterInput;
}): Promise<void> {
  const { context, input } = params;

  const tokens = Object.entries(input.chains).map(([chainName, cfg]) => ({
    chainName,
    type: 'collateral' as const,
    decimals: cfg.decimals ?? input.decimals ?? 18,
    addresses: { warpRouter: cfg.bridge },
  }));

  const warpCoreConfig = { tokens } as any;

  await context.registry.addWarpRoute(warpCoreConfig, {
    warpRouteId: input.warpRouteId,
    symbol: input.symbol,
  } as any);
}


