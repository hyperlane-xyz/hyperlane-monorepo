import { HelmCommand } from '../../src/utils/helm';

import { runWarpRouteHelmCommand } from './helm';

async function main() {
  await runWarpRouteHelmCommand(
    HelmCommand.InstallOrUpgrade,
    'mainnet2',
    'arbneutrontia',
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
