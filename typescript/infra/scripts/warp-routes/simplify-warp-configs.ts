import { getRegistry } from '../../config/registry.js';

// Overwrites the simplified warp configs into the Registry
async function main() {
  const registry = getRegistry();

  const warpRoutes = Object.entries(registry.getWarpDeployConfigs());

  for (const [warpRouteId, warpConfig] of warpRoutes) {
    console.log(`Generating Warp config for ${warpRouteId}`, warpConfig);

    for (const chain of Object.keys(warpConfig)) {
      const { ownerOverrides, owner, proxyAdmin } = warpConfig[chain];
      if (proxyAdmin && proxyAdmin.owner === owner) {
        delete warpConfig[chain].proxyAdmin;
        console.log(
          `Removed 'proxyAdmin' for ${warpRouteId} on ${chain}:`,
          warpConfig[chain],
        );
      }

      if (ownerOverrides && ownerOverrides.proxyAdmin === owner) {
        delete ownerOverrides.proxyAdmin;

        if (Object.keys(ownerOverrides).length === 0) {
          delete warpConfig[chain].ownerOverrides;
        }
        console.log(
          `Simplified 'ownerOverrides' for ${warpRouteId} on ${chain}:`,
          warpConfig[chain],
        );
      }
    }

    registry.updateWarpRouteConfig(warpConfig, { warpRouteId });
  }
  console.log('Successfully simplified warp configs');
}

main().catch((err) => {
  console.error('Error during warp config simplification:', err);
});
