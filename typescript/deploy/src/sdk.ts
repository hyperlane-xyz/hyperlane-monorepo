/*
import { types } from '@abacus-network/utils';
import { BridgeDeploy } from './bridge/BridgeDeploy';
import { CoreDeploy } from './core/CoreDeploy';
import { GovernanceDeploy } from './governance/GovernanceDeploy';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

export function updateSdkDomain(
  environment: string,
  coreDeploy: CoreDeploy,
  governanceDeploy: GovernanceDeploy,
  bridgeDeploy: BridgeDeploy,
) {
  let ret = "import { AbacusDomain } from './domain';\n";
  coreDeploy.domains.forEach((domain: types.Domain, i: number) => {
    ret += `
export const ${coreDeploy.chains[domain].name}: AbacusDomain = {
  name: '${coreDeploy.chains[domain].name}',
  id: ${domain},
  bridgeRouter: '${bridgeDeploy.router(domain).address}',${
      !!bridgeDeploy.helper(domain)
        ? `\n  ethHelper: '${bridgeDeploy.helper(domain)!.address}',`
        : ''
    }
  outbox: '${coreDeploy.outbox(domain).address}',
  governanceRouter: '${governanceDeploy.router(domain).address}',
  xAppConnectionManager: '${coreDeploy.xAppConnectionManager(domain).address}',
  inboxes: [
${coreDeploy
  .remotes(domain)
  .map(
    (remote) =>
      `    { domain: ${remote}, address: '${
        coreDeploy.inbox(domain, remote).address
      }' },`,
  )
  .join('\n')}
  ],
};\n`;
  });

  ret += `\nexport const ${environment}Domains = [${coreDeploy.domains
    .map((_) => coreDeploy.chains[_].name)
    .join(', ')}];`;
  writeFileSync(
    resolve(__dirname, `../../abacus-sdk/src/abacus/domains/${environment}.ts`),
    ret,
  );
}
*/
