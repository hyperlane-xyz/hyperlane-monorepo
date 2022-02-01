import { prod } from './registerContext';
import config from './config';

import {
  AnnotatedTokenDeployed,
  TokenDeployedArgs,
  TokenDeployedTypes,
} from 'optics-multi-provider-community/dist/optics/events/bridgeEvents';
import {
  OpticsContext,
  queryAnnotatedEvents,
} from 'optics-multi-provider-community/dist/optics';
import { TSContract } from 'optics-multi-provider-community/dist/optics/events/fetch';
// import { ethers } from 'ethers';
import { uploadDeployedTokens } from './googleSheets';

type TokenDetails = {
  name: string;
  symbol: string;
  decimals: number;
};

export type Deploy = AnnotatedTokenDeployed & { token: TokenDetails };

async function getDomainDeployedTokens(
  context: OpticsContext,
  nameOrDomain: string | number,
): Promise<Deploy[]> {
  const domain = context.resolveDomain(nameOrDomain);
  const router = context.mustGetBridge(domain).bridgeRouter;
  // get Send events
  const annotated = await queryAnnotatedEvents<
    TokenDeployedTypes,
    TokenDeployedArgs
  >(
    context,
    domain,
    router as TSContract<TokenDeployedTypes, TokenDeployedArgs>,
    router.filters.TokenDeployed(),
    context.mustGetDomain(domain).paginate?.from,
  );

  return await Promise.all(
    annotated.map(async (e: AnnotatedTokenDeployed) => {
      const deploy = e as any;

      const erc20 = await context.resolveCanonicalToken(
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
  context: OpticsContext,
): Promise<Map<number, Deploy[]>> {
  const events = new Map();
  for (const domain of context.domainNumbers) {
    events.set(domain, await getDomainDeployedTokens(context, domain));
  }
  return events;
}

async function persistDeployedTokens(
  context: OpticsContext,
  credentials: string,
): Promise<void> {
  const deployed = await getDeployedTokens(context);
  for (let domain of deployed.keys()) {
    let domainName = context.resolveDomainName(domain);
    const tokens = deployed.get(domain);
    uploadDeployedTokens(domainName!, tokens!, credentials);
  }
  //
}

(async function main() {
  await persistDeployedTokens(prod, config.googleCredentialsFile);
})();
