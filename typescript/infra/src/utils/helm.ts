import {
  HelmChartConfig,
  HelmChartRepositoryConfig,
} from '../config/infrastructure.js';

import { execCmd } from './utils.js';

export enum HelmCommand {
  InstallOrUpgrade = 'upgrade --install',
  UpgradeDiff = 'template --debug',
  Remove = 'uninstall',
}

export function helmifyValues(config: any, prefix?: string): string[] {
  if (typeof config !== 'object') {
    // Helm incorrectly splits on unescaped commas.
    const value =
      config !== undefined
        ? JSON.stringify(config).replaceAll(',', '\\,')
        : undefined;
    return [`--set ${prefix}=${value}`];
  }

  if (config.flatMap) {
    return config.flatMap((value: any, index: number) => {
      return helmifyValues(value, `${prefix}[${index}]`);
    });
  }
  return Object.keys(config).flatMap((key) => {
    const value = config[key];
    return helmifyValues(value, prefix ? `${prefix}.${key}` : key);
  });
}

export async function addHelmRepoIfRequired(helmChartConfig: HelmChartConfig) {
  if (!helmChartConfig.repository) {
    // Nothing to do
    return;
  }
  return addHelmRepoIfNotExists(helmChartConfig.repository);
}

async function addHelmRepoIfNotExists(repoConfig: HelmChartRepositoryConfig) {
  const helmRepos = await listHelmRepos();
  // Note this only finds matches based off the name - URL differences are
  // not handled
  for (const existingRepo of helmRepos) {
    if (existingRepo.name === repoConfig.name) {
      if (existingRepo.url !== repoConfig.url) {
        // If for some reason there's a repo with the same name but
        // a different URL, then remove the repo so we can add the new one
        await removeHelmRepo(repoConfig.name);
      } else {
        // There's a match of the name and URL -- nothing to do
        return;
      }
    }
  }
  // If we've gotten here, the repo must be added
  await addHelmRepo(repoConfig);
}

function addHelmRepo(repoConfig: HelmChartRepositoryConfig) {
  return execCmd(
    `helm repo add ${repoConfig.name} ${repoConfig.url} && helm repo update`,
  );
}

function removeHelmRepo(repoName: string) {
  return execCmd(`helm repo remove ${repoName}`);
}

// Outputs an array of the shape: [{"name":"foo", "url":"bar"}, ...]
async function listHelmRepos() {
  // try/catch in case no helm repos are installed
  try {
    const [output] = await execCmd('helm repo list -o json');
    return JSON.parse(output);
  } catch (_) {
    return [];
  }
}

export function getDeployableHelmChartName(helmChartConfig: HelmChartConfig) {
  if (helmChartConfig.repository) {
    return `${helmChartConfig.repository.name}/${helmChartConfig.name}`;
  }
  return helmChartConfig.name;
}

export function buildHelmChartDependencies(chartPath: string) {
  return execCmd(`cd ${chartPath} && helm dependency build`, {}, false, true);
}
