import { getArgs, withNetwork } from './agent-utils.js';
import { getHyperlaneCore } from './core-utils.js';

async function main() {
  const { environment, network } = await withNetwork(getArgs()).argv;
  const { core } = await getHyperlaneCore(environment);
  const chains = core.multiProvider.getKnownChainNames();
  chains.map((chain) => core.multiProvider.getDomainId(chain));
  // const domains = core.multiProvider.getKnownDomainIds();
  // const filters = { [network ?? 'base']: [, , ,] };
  await core.relay({ base: [, , , ,] });
}

main();
