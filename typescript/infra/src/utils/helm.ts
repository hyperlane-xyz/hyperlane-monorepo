import { confirm } from '@inquirer/prompts';

import {
  HelmChartConfig,
  HelmChartRepositoryConfig,
} from '../config/infrastructure.js';

import { execCmd, removeFile, writeYamlAtPath } from './utils.js';

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

export function writeTemporaryHelmValuesFile<T>(values: T) {
  const randomHash = Math.random().toString(36).substring(7);
  const timestampSeconds = Math.floor(Date.now() / 1000);
  const valuesFile = `/tmp/helm-values-${timestampSeconds}-${randomHash}.yaml`;
  writeYamlAtPath(valuesFile, values);
  return valuesFile;
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

// Convenience function to remove a helm release without having a HelmManger for it.
export function removeHelmRelease(releaseName: string, namespace: string) {
  return execCmd(`helm uninstall ${releaseName} --namespace ${namespace}`);
}

export type HelmValues = Record<string, any>;

export abstract class HelmManager<T = HelmValues> {
  abstract readonly helmReleaseName: string;
  abstract readonly helmChartPath: string;
  abstract readonly namespace: string;

  /**
   * Returns the values to be passed to the helm chart.
   * Expected to be an object of values.
   */
  abstract helmValues(): Promise<T>;

  async runHelmCommand(action: HelmCommand, dryRun?: boolean): Promise<void> {
    const cmd = ['helm', action];
    if (dryRun) cmd.push('--dry-run');

    if (action == HelmCommand.Remove) {
      if (dryRun) cmd.push('--dry-run');
      cmd.push(this.helmReleaseName, this.namespace);
      await execCmd(cmd, {}, false, true);
      return;
    }

    if (action == HelmCommand.InstallOrUpgrade && !dryRun) {
      // Delete secrets to avoid them being stale
      const cmd = [
        'kubectl',
        'delete',
        'secrets',
        '--namespace',
        this.namespace,
        '--selector',
        `app.kubernetes.io/instance=${this.helmReleaseName}`,
      ];
      try {
        await execCmd(cmd, {}, false, false);
      } catch (e) {
        console.error(e);
      }
    }

    await buildHelmChartDependencies(this.helmChartPath);

    const values = await this.helmValues();
    const valuesFile = writeTemporaryHelmValuesFile(values);
    console.log(`Writing values to temporary file: ${valuesFile}`);

    const performAction = async () => {
      cmd.push(
        this.helmReleaseName,
        this.helmChartPath,
        '--create-namespace',
        '--namespace',
        this.namespace,
        '-f',
        valuesFile,
      );
      if (action == HelmCommand.UpgradeDiff) {
        cmd.push(
          `| kubectl diff --namespace ${this.namespace} --field-manager="Go-http-client" -f - || true`,
        );
      }
      await execCmd(cmd, {}, false, true);
    };

    const removeTempValuesFile = () => {
      console.log(`Removing temporary values file: ${valuesFile}`);
      removeFile(valuesFile);
    };

    try {
      await performAction();
    } catch (error) {
      console.error('Error running helm command:', error);
      const keepValuesFile = await confirm({
        message: `Error occurred, keep temporary values file at '${valuesFile}'?`,
      });
      if (!keepValuesFile) {
        removeTempValuesFile();
      }
      throw error;
    }

    // If successful, remove the temporary values file
    removeTempValuesFile();
  }

  async doesHelmReleaseExist() {
    try {
      await execCmd(
        `helm status ${this.helmReleaseName} --namespace ${this.namespace}`,
        {},
        false,
        false,
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  async getExistingK8sSecrets(): Promise<string[]> {
    const [output] = await execCmd(
      `kubectl get secret --selector=app.kubernetes.io/instance=${this.helmReleaseName} -o jsonpath='{.items[*].metadata.name}' -n ${this.namespace}`,
    );
    // Split on spaces and remove empty strings
    return output.split(' ').filter(Boolean);
  }

  // Returns the names of all pods managed by a Statefulset in the helm release
  async getManagedK8sPods() {
    // Consider supporting Deployments in the future. For now, we only support StatefulSets because
    // jsonpath doesn't support or operators well.
    const [output] = await execCmd(
      `kubectl get pods --selector=app.kubernetes.io/instance=${this.helmReleaseName} -o jsonpath='{range .items[?(@.metadata.ownerReferences[0].kind=="StatefulSet")]}{.metadata.name}{"\\n"}{end}' -n ${this.namespace}`,
    );
    // Split on new lines and remove empty strings
    return output.split('\n').filter(Boolean);
  }
}
