import { mainnet } from './registerContext';
import config from './config';

import {
  AbacusBridge,
  AbacusCore,
  AnnotatedTokenDeployed,
  NameOrDomain,
  TokenDeployedArgs,
  TokenDeployedTypes,
  queryAnnotatedEvents,
  TSContract,
} from '@abacus-network/sdk';
import { uploadDeployedTokens } from './googleSheets';

type TokenDetails = {
  name: string;
  symbol: string;
  decimals: number;
};

export type Deploy = AnnotatedTokenDeployed & { token: TokenDetails };

async function getDomainDeployedTokens(
  core: AbacusCore,
  bridge: AbacusBridge,
  nameOrDomain: NameOrDomain,
): Promise<Deploy[]> {
  const domain = core.resolveDomain(nameOrDomain);
  const router = bridge.mustGetContracts(nameOrDomain).router;
  // get Send events
  const annotated = await queryAnnotatedEvents<
    TokenDeployedTypes,
    TokenDeployedArgs
  >(
    core,
    domain,
    router as TSContract<TokenDeployedTypes, TokenDeployedArgs>,
    router.filters.TokenDeployed(),
    core.mustGetDomain(domain).paginate?.from,
  );

  return await Promise.all(
    annotated.map(async (e: AnnotatedTokenDeployed) => {
      const deploy = e as any;

      const erc20 = await bridge.resolveCanonicalToken(
        domain,
        deploy.event.args.representation,
      );
      const [name, symbol, decimals] = await Promise.all([
        erc20.name(),
        erc20.symbol(),
        erc20.decimals(),
      ]);

      deploy.token = {};
      deploy.token.name = name;
      deploy.token.symbol = symbol;
      deploy.token.decimals = decimals;
      return deploy as Deploy;
    }),
  );
}

async function getDeployedTokens(
  core: AbacusCore,
  bridge: AbacusBridge,
): Promise<Map<number, Deploy[]>> {
  const events = new Map();
  for (const domain of core.domainNumbers) {
    events.set(domain, await getDomainDeployedTokens(core, bridge, domain));
  }
  return events;
}

async function persistDeployedTokens(
  core: AbacusCore,
  bridge: AbacusBridge,
  credentials: string,
): Promise<void> {
  const deployed = await getDeployedTokens(core, bridge);
  for (let domain of deployed.keys()) {
    let domainName = core.resolveDomainName(domain);
    const tokens = deployed.get(domain);
    uploadDeployedTokens(domainName!, tokens!, credentials);
  }
  //
}

(async function main() {
  await persistDeployedTokens(core, bridge, config.googleCredentialsFile);
})();
