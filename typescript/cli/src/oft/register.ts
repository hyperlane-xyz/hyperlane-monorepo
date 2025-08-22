import { ethers } from 'ethers';
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

  const COLLATERAL_ABI = ['function wrappedToken() view returns (address)'];

  const tokens = await Promise.all(
    Object.entries(input.chains).map(async ([chainName, cfg]) => {
      let collateral: string | undefined = undefined;
      try {
        const provider = context.multiProvider.getProvider(chainName);
        const router = new ethers.Contract(cfg.bridge, COLLATERAL_ABI, provider);
        collateral = await router.wrappedToken();
      } catch (_e) {}
      return {
        chainName,
        standard: 'TokenBridgeOft',
        symbol: input.symbol,
        name: input.symbol,
        type: 'collateral' as const,
        decimals: cfg.decimals ?? input.decimals ?? 18,
        // Top-level router address expected by WarpCore
        addressOrDenom: cfg.bridge,
        // Underlying OFT token used for balances/metadata
        collateralAddressOrDenom: collateral,
      } as any;
    }),
  );

  const warpCoreConfig = { tokens } as any;

  await context.registry.addWarpRoute(warpCoreConfig, {
    warpRouteId: input.warpRouteId,
    symbol: input.symbol,
  } as any);
}


