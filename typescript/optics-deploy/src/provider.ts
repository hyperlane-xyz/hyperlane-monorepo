import { BridgeDeploy } from './bridge/BridgeDeploy';
import { CoreDeploy } from './core/CoreDeploy';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

export function updateProviderDomain(
  environment: string,
  directory: string,
  coreDeploys: CoreDeploy[],
  bridgeDeploys: BridgeDeploy[],
) {
  let ret = "import { OpticsDomain } from './domain';\n"
  coreDeploys.forEach((coreDeploy: CoreDeploy, i: number) => {
    const bridgeDeploy = bridgeDeploys[i];
    ret += `
export const ${coreDeploy.chain.name}: OpticsDomain = {
  name: '${coreDeploy.chain.name}',
  id: ${coreDeploy.chain.domain},
  bridgeRouter: '${bridgeDeploy.contracts.bridgeRouter!.proxy.address}',${!!bridgeDeploy.contracts.ethHelper ? `\n  ethHelper: '${bridgeDeploy.contracts.ethHelper?.address}',` : ''}
  home: '${coreDeploy.contracts.home!.proxy.address}',
  governanceRouter: '${coreDeploy.contracts.governance!.proxy.address}',
  xAppConnectionManager: '${coreDeploy.contracts.xAppConnectionManager!.address}',
  replicas: [
${Object.keys(coreDeploy.contracts.replicas)
      .map(Number)
      .map((replicaDomain) => `    { domain: ${replicaDomain}, address: '${coreDeploy.contracts.replicas[replicaDomain].proxy.address}' },`
      ).join('\n')}
  ],
};\n`
  })

  ret += `\nexport const ${environment}Domains = [${coreDeploys.map(_ => _.chain.name).join(', ')}];`
  writeFileSync(resolve(__dirname, `../../optics-provider/src/optics/domains/${environment}.ts`), ret)
}
