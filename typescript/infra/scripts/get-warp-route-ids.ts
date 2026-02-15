import { getRegistry } from '../config/registry.js';

function stringifyValueForError(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<unstringifiable>';
  }
}

async function main() {
  const registry = await getRegistry();

  const registryContents = await registry.listRegistryContent();

  const warpRoutes = registryContents.deployments.warpRoutes;
  const warpRouteIds = Object.keys(warpRoutes);

  const warpRouteIdsTable = warpRouteIds.map((warpRouteId) => {
    return { 'Warp Route IDs': warpRouteId };
  });

  console.table(warpRouteIdsTable, ['Warp Route IDs']);
}

main()
  .then()
  .catch((e) => {
    console.error(stringifyValueForError(e));
    process.exit(1);
  });
