import { ethers } from 'ethers';
import { readYamlOrJson } from '../utils/files.js';
import type { WriteCommandContext, CommandContext } from '../context/types.js';

type OftRebalancerConfig = {
  strategy: {
    chains: Record<
      string,
      {
        bridge?: string; // TokenBridgeOft address on this chain
      }
    >;
  };
  oft?: {
    domains?: Record<string, { lzEid?: number }>;
  };
};

const ROUTER_ABI = [
  'function enrollRemoteRouter(uint32 _domain, bytes32 _router) external',
];

const OFT_ABI = [
  'function addDomain(uint32 _hyperlaneDomain, uint16 _lzEid, bytes _dstVault, bytes _adapterParams) external',
];

function toBytes32Address(addr: string): string {
  return ethers.utils.hexZeroPad(addr, 32);
}

export async function runOftSetup(params: {
  context: WriteCommandContext | CommandContext;
  configPath: string;
}): Promise<void> {
  const { context, configPath } = params;

  const cfg = readYamlOrJson(configPath) as OftRebalancerConfig;
  const chainEntries = Object.entries(cfg.strategy?.chains || {});
  if (chainEntries.length < 2) throw new Error('Need at least two chains in strategy.chains');

  // Collect bridges per chain
  const bridges: Record<string, string> = {};
  for (const [chain, data] of chainEntries) {
    if (!data?.bridge) throw new Error(`Missing bridge address for chain ${chain}`);
    bridges[chain] = data.bridge;
  }

  // Collect LZ EIDs per chain (optional but recommended)
  const lzByChain: Record<string, number | undefined> = {};
  for (const [chain, info] of Object.entries(cfg.oft?.domains || {})) {
    lzByChain[chain] = info?.lzEid;
  }

  // Enroll peers (both ways) and add LZ EIDs
  for (const [origin, originBridge] of Object.entries(bridges)) {
    const originSigner = (context as any).multiProvider?.getSigner?.(origin) || (context as any).multiProvider?.sharedSigner;
    if (!originSigner) throw new Error(`No chain signer set for ${origin}`);
    const originProvider = (context as any).multiProvider.getProvider(origin);
    const router = new ethers.Contract(originBridge, ROUTER_ABI, originSigner);
    const oft = new ethers.Contract(originBridge, OFT_ABI, originSigner);

    for (const [dest, destBridge] of Object.entries(bridges)) {
      if (dest === origin) continue;
      const destDomain = (context as any).multiProvider.getDomainId(dest);
      const enrollTx = await router.enrollRemoteRouter(destDomain, toBytes32Address(destBridge));
      await enrollTx.wait();

      // LayerZero EID mapping (optional if already set)
      const lz = lzByChain[dest];
      if (typeof lz === 'number') {
        const addTx = await oft.addDomain(destDomain, lz, '0x', '0x');
        await addTx.wait();
      }
    }

    // Small no-op read to ensure provider context is exercised
    await originProvider.getNetwork();
  }
}


