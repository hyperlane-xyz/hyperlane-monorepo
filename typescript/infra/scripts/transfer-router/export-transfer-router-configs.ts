import { stringify as yamlStringify } from 'yaml';

import { writeFileAtPath } from '@hyperlane-xyz/utils/fs';

import { getRegistry } from '../../config/registry.js';
import { transferRouterConfigGetterMap } from '../../config/transferRouter.js';

async function main() {
  const registry = getRegistry();
  const registryUri = registry.getUri();

  const idsToExport =
    process.argv.length > 2
      ? process.argv.slice(2)
      : Object.keys(transferRouterConfigGetterMap);

  for (const transferRouterId of idsToExport) {
    const configGetter = transferRouterConfigGetterMap[transferRouterId];
    if (!configGetter) {
      console.error(
        `No config getter found for transfer router ID: ${transferRouterId}`,
      );
      continue;
    }

    console.log(`Generating config for ${transferRouterId}`);
    const config = configGetter();

    const deployPath = `${registryUri}/deployments/transfer_router/${transferRouterId}-deploy.yaml`;
    const yamlContent = yamlStringify(config);

    writeFileAtPath(deployPath, yamlContent);
    console.log(`Written to ${deployPath}`);
  }
}

main().catch((err) => console.error('Error:', err));
