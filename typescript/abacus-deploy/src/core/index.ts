export { CoreDeploy } from './CoreDeploy';
export { CoreInstance } from './CoreInstance';
export { CoreContracts } from './CoreContracts';
export { CoreContractAddresses, CoreConfig } from './types';
export { CoreInvariantChecker } from './CoreInvariantChecker';

/*
export function writePartials(dir: string) {
  // make folder if it doesn't exist already
  fs.mkdirSync(dir, { recursive: true });
  const defaultDir = '../../rust/config/default';
  const partialNames = ['kathy', 'processor', 'relayer', 'validator'];
  // copy partial config from default directory to given directory
  for (let partialName of partialNames) {
    const filename = `${partialName}-partial.json`;
    fs.copyFile(`${defaultDir}/${filename}`, `${dir}/${filename}`, (err) => {
      if (err) {
        console.error(err);
      }
    });
  }
}
export function writeRustConfigs(deploys: CoreDeploy[], writeDir?: string) {
  log(deploys[0].test, `Have ${deploys.length} deploys`);
  const dir = writeDir ? writeDir : `../../rust/config/${Date.now()}`;
  for (const local of deploys) {
    // get remotes
    const remotes = deploys
      .slice()
      .filter((remote) => remote.chain.domain !== local.chain.domain);

    const rustConfig = CoreDeploy.buildRustConfig(local, remotes);
    const name = local.chain.name;

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      `${dir}/${name}_config.json`,
      JSON.stringify(rustConfig, null, 2),
    );
  }
  writePartials(dir);
}*/
