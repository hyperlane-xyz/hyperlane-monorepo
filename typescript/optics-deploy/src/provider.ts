import { ExistingBridgeDeploy } from './bridge/BridgeDeploy';
import { ExistingCoreDeploy } from './core/CoreDeploy';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { AllConfigs } from './config';

export function updateProviderDomain(
  environment: string,
  path: string,
  configs: AllConfigs[],
) {
  let ret = "import { OpticsDomain } from './domain';\n"
  const coreDeploys = configs.map(
    (_) => new ExistingCoreDeploy(path, _.chain, _.coreConfig),
  );
  const bridgeDeploys = configs.map(
    (_) => new ExistingBridgeDeploy(_.chain, _.bridgeConfig, path),
  );

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const bridgeDeploy = bridgeDeploys[i];
    const coreDeploy = coreDeploys[i];
    ret += `
export const ${config.chain.name}: OpticsDomain = {
  name: '${config.chain.name}',
  id: ${config.chain.domain},
  bridgeRouter: '${bridgeDeploy.contracts.bridgeRouter!.proxy.address}',${!!bridgeDeploy.contracts.ethHelper ? `\n  ethHelper: '${bridgeDeploy.contracts.ethHelper?.address}',` : ''}
  home: '${coreDeploy.contracts.home!.proxy.address}',
  replicas: [
${Object.keys(coreDeploy.contracts.replicas)
      .map(Number)
      .map((replicaDomain) => `    { domain: ${replicaDomain}, address: '${coreDeploy.contracts.replicas[replicaDomain].proxy.address}' },`
      ).join('\n')}
  ],
};\n`
  }

  ret += `\nexport const ${environment}Domains = [${configs.map(_ => _.chain.name).join(', ')}];`
  writeFileSync(resolve(__dirname, `../../optics-provider/src/optics/domains/${environment}.ts`), ret)
}
