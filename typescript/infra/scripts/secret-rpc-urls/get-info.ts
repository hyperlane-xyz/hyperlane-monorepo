import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import {
  getSecretRpcEndpoints,
  secretRpcEndpointsExist,
} from '../../src/agents/index.js';
import { getAgentConfig, getArgs } from '../agent-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const agentConfig = await getAgentConfig(Contexts.Hyperlane, environment);
  const allRpcUrls: ChainMap<string[]> = Object.fromEntries(
    await Promise.all(
      agentConfig.environmentChainNames.map(async (chain) => {
        return [chain, await getSecretRpcUrls(environment, chain)];
      }),
    ),
  );

  printRpcUrlCountHistogram(allRpcUrls);

  console.log('\n\n');

  printAllRpcUrlCounts(allRpcUrls);
}

async function getSecretRpcUrls(
  environment: string,
  chain: ChainName,
): Promise<Array<string>> {
  const secretExists = await secretRpcEndpointsExist(environment, chain);
  if (!secretExists) {
    console.log(
      `No secret rpc urls found for ${chain} in ${environment} environment`,
    );
    return [];
  }

  return getSecretRpcEndpoints(environment, chain);
}

function printRpcUrlCountHistogram(allRpcUrls: ChainMap<string[]>) {
  const histogram: Record<number, number> = {};
  for (const [_, urls] of Object.entries(allRpcUrls)) {
    if (!histogram[urls.length]) {
      histogram[urls.length] = 0;
    }
    histogram[urls.length] += 1;
  }
  console.log('RPC URL count histogram:');
  console.table(histogram);
}

function printAllRpcUrlCounts(allRpcUrls: ChainMap<string[]>) {
  console.log('RPC URL counts:');
  const counts = Object.entries(allRpcUrls).map(([chain, urls]) => ({
    chain,
    urlCount: urls.length,
    urls: urls.map(categorizeUrl).join(', '),
    rank: rankUrlSet(urls),
  }));
  console.table(counts);
}

const tier1 = [
  'alchemy',
  'quicknode',
  'quiknode',
  'infura',
  'tenderly',
  'ankr',
  'drpc',
  'dwellir',
  'allthatnode',
];
const tier2 = ['grove', 'blockpi', 'onfinality'];

enum ProviderType {
  Private = 'private',
  Public = 'public',
}

function categorizeUrl(url: string) {
  if (tier1.some((tier) => url.includes(tier))) {
    return '✅';
  }
  if (tier2.some((tier) => url.includes(tier))) {
    return '🆗';
  }
  return '💩';
}

function getProviderType(url: string): ProviderType {
  if ([...tier1, ...tier2].some((tier) => url.includes(tier))) {
    return ProviderType.Private;
  }
  return ProviderType.Public;
}

function rankUrlSet(urls: string[]) {
  const urlTypes = urls.map(getProviderType);

  const privateCount = urlTypes.filter(
    (type) => type === ProviderType.Private,
  ).length;
  const publicCount = urlTypes.filter(
    (type) => type === ProviderType.Public,
  ).length;

  if (urls.length >= 3) {
    if (publicCount <= 1 && privateCount >= 3) {
      return '🥇';
    } else if (publicCount <= 1 && privateCount >= 2) {
      return '🥈';
    } else if (publicCount <= 1 && privateCount >= 1) {
      return '🥉';
    }
  }
  return '💩';
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
