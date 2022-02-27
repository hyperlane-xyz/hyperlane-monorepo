import { BridgeDeploy } from './bridge/BridgeDeploy';
import { CoreDeploy } from './core/CoreDeploy';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

export function updateProviderDomain(
  environment: string,
  coreDeploys: CoreDeploy[],
  bridgeDeploys: BridgeDeploy[],
) {
  let ret = "import { AbacusDomain } from './domain';\n";
  coreDeploys.forEach((coreDeploy: CoreDeploy, i: number) => {
    const bridgeDeploy = bridgeDeploys[i];
    ret += `
export const ${coreDeploy.chain.name}: AbacusDomain = {
  name: '${coreDeploy.chain.name}',
  id: ${coreDeploy.chain.domain},
  bridgeRouter: '${bridgeDeploy.contracts.bridgeRouter!.proxy.address}',${
      !!bridgeDeploy.contracts.ethHelper
        ? `\n  ethHelper: '${bridgeDeploy.contracts.ethHelper?.address}',`
        : ''
    }
  home: '${coreDeploy.contracts.home!.proxy.address}',
  governanceRouter: '${coreDeploy.contracts.governanceRouter!.proxy.address}',
  xAppConnectionManager: '${
    coreDeploy.contracts.xAppConnectionManager!.address
  }',
  replicas: [
${Object.keys(coreDeploy.contracts.replicas)
  .map(Number)
  .map(
    (replicaDomain) =>
      `    { domain: ${replicaDomain}, address: '${coreDeploy.contracts.replicas[replicaDomain].proxy.address}' },`,
  )
  .join('\n')}
  ],
};\n`;
  });

  ret += `\nexport const ${environment}Domains = [${coreDeploys
    .map((_) => _.chain.name)
    .join(', ')}];`;
  writeFileSync(
    resolve(
      __dirname,
      `../../abacus-sdk/src/abacus/domains/${environment}.ts`,
    ),
    ret,
  );
}
