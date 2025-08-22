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
    adapters?: Record<string, string>; // Optional: ValueTransferBridge adapter per chain
    domains?: Record<string, { lzEid?: number }>;
  };
};

const ROUTER_ABI = [
  'function enrollRemoteRouter(uint32 _domain, bytes32 _router) external',
  'function addBridge(uint32 domain, address bridge) external',
  'function addRebalancer(address rebalancer) external',
  'function approveTokenForBridge(address token, address bridge) external',
  'function wrappedToken() external view returns (address)',
];

const OFT_ABI = [
  'function addDomain(uint32 _hyperlaneDomain, uint16 _lzEid, bytes _dstVault, bytes _adapterParams) external',
];

const ADAPTER_ABI = [
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

  // Optional adapters per chain
  const adaptersByChain: Record<string, string> = { ...(cfg.oft?.adapters || {}) };

  // Enroll peers (both ways), add LZ EIDs, allow bridges, and authorize rebalancer
  for (const [origin, originBridge] of Object.entries(bridges)) {
    const originSigner = (context as any).multiProvider?.getSigner?.(origin) || (context as any).multiProvider?.sharedSigner;
    if (!originSigner) throw new Error(`No chain signer set for ${origin}`);
    const originProvider = (context as any).multiProvider.getProvider(origin);
    const router = new ethers.Contract(originBridge, ROUTER_ABI, originSigner);
    const oft = new ethers.Contract(originBridge, OFT_ABI, originSigner);
    const rebalancerAddr = await originSigner.getAddress();
    const adapterAddr = adaptersByChain[origin];
    const adapter = adapterAddr
      ? new ethers.Contract(adapterAddr, ADAPTER_ABI, originSigner)
      : undefined;
    
    console.log(`Setting up OFT for ${origin}:`);
    console.log(`  Router: ${originBridge}`);
    console.log(`  Adapter: ${adapterAddr || 'Not configured'}`);
    console.log(`  Rebalancer: ${rebalancerAddr}`);
    // Discover underlying OFT token for potential approvals
    const oftTokenAddr: string = await router.wrappedToken().catch(() => ethers.constants.AddressZero);

    for (const [dest, destBridge] of Object.entries(bridges)) {
      if (dest === origin) continue;
      const destDomain = (context as any).multiProvider.getDomainId(dest);
      try {
        const enrollTx = await router.enrollRemoteRouter(destDomain, toBytes32Address(destBridge));
        await enrollTx.wait();
      } catch (_e) {
        // ignore if already enrolled
      }

      // LayerZero EID mapping (optional if already set)
      const lz = lzByChain[dest];
      if (typeof lz === 'number') {
        console.log(`  Configuring LZ EID ${lz} for ${dest} (domain ${destDomain})`);
        // dstVault is the destination router address as bytes32
        try {
          const dstVault = ethers.utils.hexZeroPad(destBridge, 32);
          const addOftTx = await oft.addDomain(destDomain, lz, dstVault, '0x');
          await addOftTx.wait();
        } catch (_e) {
          // ignore if already set
        }

        // If adapter provided, configure its domain mapping too
        if (adapter) {
          try {
            const dstVault = ethers.utils.hexZeroPad(destBridge, 32);
            const addAdapterTx = await adapter.addDomain(destDomain, lz, dstVault, '0x');
            await addAdapterTx.wait();
          } catch (_e) {
            // ignore if already set
          }
        }
      }

      // Allow the origin bridge for this destination domain
      try {
        const bridgeToAllow = adapterAddr ?? originBridge;
        console.log(`  Adding bridge ${bridgeToAllow} for destination domain ${destDomain} on ${origin}`);
        const bridgeTx = await router.addBridge(destDomain, bridgeToAllow);
        await bridgeTx.wait();
      } catch (_e) {
        // ignore if already allowed
      }

      // If adapter used and we have an OFT token, approve token for adapter once
      if (adapterAddr && oftTokenAddr && oftTokenAddr !== ethers.constants.AddressZero) {
        try {
          const approveTx = await router.approveTokenForBridge(oftTokenAddr, adapterAddr);
          await approveTx.wait();
        } catch (_e) {
          // ignore if already approved
        }
      }
    }

    // Ensure our EOA is authorized as rebalancer on this router
    try {
      const allowTx = await router.addRebalancer(rebalancerAddr);
      await allowTx.wait();
    } catch (_e) {
      // ignore if already set
    }

    // Small no-op read to ensure provider context is exercised
    await originProvider.getNetwork();
  }
}


