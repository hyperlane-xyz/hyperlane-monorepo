import { assert } from '@hyperlane-xyz/utils';

import { isFile, readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';

export function syncWarpDeployConfigToRegistry({
  warpDeployPath,
  warpRouteId,
  registryPath,
}: {
  warpDeployPath: string;
  warpRouteId: string;
  registryPath: string;
}): string {
  assert(
    isFile(warpDeployPath),
    `[syncWarpDeployConfigToRegistry] Warp deploy config file not found: ${warpDeployPath}`,
  );

  const config = readYamlOrJson(warpDeployPath) as unknown;
  assert(
    typeof config === 'object' && config !== null && !Array.isArray(config),
    `[syncWarpDeployConfigToRegistry] Invalid warp deploy config at ${warpDeployPath}: expected object map`,
  );
  const registryDeployPath = `${registryPath}/deployments/warp_routes/${warpRouteId}-deploy.yaml`;
  writeYamlOrJson(registryDeployPath, config);
  return registryDeployPath;
}
