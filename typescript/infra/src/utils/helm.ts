import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { execSync } from 'child_process';
import fs from 'fs';
import tmp from 'tmp';

import { rootLogger, stringifyObject } from '@hyperlane-xyz/utils';

import {
  HelmChartConfig,
  HelmChartRepositoryConfig,
} from '../config/infrastructure.js';

import { execCmd, execCmdAndParseJson } from './utils.js';

export enum HelmCommand {
  InstallOrUpgrade = 'upgrade --install',
  UpgradeDiff = 'template --debug',
  Remove = 'uninstall',
}

export function helmifyValues(config: any, prefix?: string): string[] {
  if (config === null || config === undefined) {
    return [];
  }

  if (typeof config !== 'object') {
    // Helm incorrectly splits on unescaped commas.
    const value = JSON.stringify(config).replaceAll(',', '\\,');
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

export function buildHelmChartDependencies(
  chartPath: string,
  updateRepoCache: boolean,
) {
  const flags = updateRepoCache ? '' : '--skip-refresh';
  return execCmd(
    `cd ${chartPath} && helm dependency build ${flags}`,
    {},
    false,
    true,
  );
}

// Convenience function to remove a helm release without having a HelmManger for it.
export function removeHelmRelease(releaseName: string, namespace: string) {
  return execCmd(`helm uninstall ${releaseName} --namespace ${namespace}`);
}

export type HelmValues = Record<string, any>;

export interface HelmCommandOptions {
  dryRun?: boolean;
  updateRepoCache?: boolean;
  skipDependencyBuild?: boolean;
}

export abstract class HelmManager<T = HelmValues> {
  abstract readonly helmReleaseName: string;
  abstract readonly helmChartPath: string;
  abstract readonly namespace: string;

  /**
   * Returns the values to be passed to the helm chart.
   * Expected to be an object of values.
   */
  abstract helmValues(): Promise<T>;

  async runHelmCommand(
    action: HelmCommand,
    options?: HelmCommandOptions,
  ): Promise<void> {
    const dryRun = options?.dryRun ?? false;
    const updateRepoCache = options?.updateRepoCache ?? false;
    const skipDependencyBuild = options?.skipDependencyBuild ?? false;

    const cmd = ['helm', action];
    if (dryRun) cmd.push('--dry-run');

    if (action == HelmCommand.Remove) {
      if (dryRun) cmd.push('--dry-run');
      cmd.push(this.helmReleaseName, this.namespace);
      await execCmd(cmd, {}, false, true);
      return;
    }

    const values = await this.helmValues();

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

    if (!skipDependencyBuild) {
      await buildHelmChartDependencies(this.helmChartPath, updateRepoCache);
    }

    // Removes temp files on process exit
    tmp.setGracefulCleanup();
    const valuesTmpFile = tmp.fileSync({
      prefix: 'helm-values',
      postfix: `${this.helmReleaseName}-${this.namespace}.yaml`,
    });
    rootLogger.debug(`Writing values to ${valuesTmpFile.name}`);
    fs.writeFileSync(valuesTmpFile.name, stringifyObject(values, 'yaml'));

    // Explicitly clean up temp file on interrupt since graceful cleanup may not trigger
    const sigintHandler = () => {
      rootLogger.debug(`Cleaning up temp file ${valuesTmpFile.name}`);
      valuesTmpFile.removeCallback();
      process.exit(130);
    };
    process.once('SIGINT', sigintHandler);

    cmd.push(
      this.helmReleaseName,
      this.helmChartPath,
      '--create-namespace',
      '--namespace',
      this.namespace,
      '-f',
      valuesTmpFile.name,
    );
    if (action == HelmCommand.UpgradeDiff) {
      cmd.push(
        `| kubectl diff --namespace ${this.namespace} --field-manager="Go-http-client" -f - || true`,
      );
    }

    try {
      await execCmd(cmd, {}, false, true);
    } finally {
      process.removeListener('SIGINT', sigintHandler);
      valuesTmpFile.removeCallback();
    }
  }

  static async doesHelmReleaseExist(
    releaseName: string,
    namespace: string,
  ): Promise<boolean> {
    try {
      await execCmd(
        `helm status ${releaseName} --namespace ${namespace}`,
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

  static runK8sCommand(
    command: string,
    podId: string,
    namespace: string,
    args: string[] = [],
  ) {
    const argsString = args.join(' ');
    return execSync(
      `kubectl ${command} ${podId} -n ${namespace} ${argsString}`,
      {
        encoding: 'utf-8',
      },
    );
  }

  /**
   * Gets the currently deployed helm values for this release.
   * Returns null if the release doesn't exist.
   */
  async getDeployedHelmValues(): Promise<HelmValues | null> {
    const exists = await HelmManager.doesHelmReleaseExist(
      this.helmReleaseName,
      this.namespace,
    );
    if (!exists) {
      return null;
    }

    try {
      const values = await execCmdAndParseJson(
        `helm get values ${this.helmReleaseName} --namespace ${this.namespace} -o json`,
      );
      return values;
    } catch (error) {
      rootLogger.warn(
        `Failed to get deployed helm values for ${this.helmReleaseName}: ${error}`,
      );
      return null;
    }
  }

  /**
   * Runs pre-flight checks before deployment.
   * Compares the proposed deployment against what's currently running
   * and prompts for confirmation if there are significant changes.
   *
   * @returns true if the deployment should proceed, false otherwise
   */
  async runPreflightChecksWithConfirmation(): Promise<boolean> {
    const deployedValues = await this.getDeployedHelmValues();

    // If there's no existing deployment, no pre-flight check needed
    if (!deployedValues) {
      console.log(
        chalk.green(
          `No existing deployment found for ${this.helmReleaseName}. Proceeding with fresh install.`,
        ),
      );
      return true;
    }

    // Cast to HelmValues since helmValues() returns T which extends HelmValues
    const proposedValues = (await this.helmValues()) as HelmValues;

    // Compare chain configurations (most common source of contention issues)
    const chainDiff = this.compareChainConfigurations(
      deployedValues,
      proposedValues,
    );

    // Compare docker image tags
    const imageDiff = this.compareDockerImages(deployedValues, proposedValues);

    // If there are no significant differences, proceed
    if (!chainDiff.hasChanges && !imageDiff.hasChanges) {
      console.log(
        chalk.green(
          `Pre-flight check passed for ${this.helmReleaseName}. No significant changes detected.`,
        ),
      );
      return true;
    }

    // Display the differences
    console.log(
      chalk.yellow.bold(
        `\n⚠️  Deployment changes detected for ${this.helmReleaseName}:\n`,
      ),
    );

    if (chainDiff.hasChanges) {
      console.log(chalk.cyan('Chain configuration changes:'));
      if (chainDiff.added.length > 0) {
        console.log(
          chalk.green(`  + Adding chains: ${chainDiff.added.join(', ')}`),
        );
      }
      if (chainDiff.removed.length > 0) {
        console.log(
          chalk.red(`  - Removing chains: ${chainDiff.removed.join(', ')}`),
        );
      }
    }

    if (imageDiff.hasChanges) {
      console.log(chalk.cyan('Docker image changes:'));
      if (imageDiff.currentTag && imageDiff.newTag) {
        console.log(chalk.yellow(`  Current tag: ${imageDiff.currentTag}`));
        console.log(chalk.yellow(`  New tag: ${imageDiff.newTag}`));
      }
    }

    console.log('');

    // Prompt for confirmation
    return confirm({
      message: chalk.yellow(
        'Do you want to proceed with this deployment? (This may overwrite changes from other branches)',
      ),
      default: false,
    });
  }

  /**
   * Compares chain configurations between deployed and proposed values.
   */
  protected compareChainConfigurations(
    deployed: HelmValues,
    proposed: HelmValues,
  ): { hasChanges: boolean; added: string[]; removed: string[] } {
    const deployedChains = this.extractChainNames(deployed);
    const proposedChains = this.extractChainNames(proposed);

    const added = proposedChains.filter((c) => !deployedChains.includes(c));
    const removed = deployedChains.filter((c) => !proposedChains.includes(c));

    return {
      hasChanges: added.length > 0 || removed.length > 0,
      added,
      removed,
    };
  }

  /**
   * Extracts chain names from helm values.
   * Subclasses can override this for custom chain extraction logic.
   */
  protected extractChainNames(values: HelmValues): string[] {
    // Default extraction from hyperlane.chains
    if (values?.hyperlane?.chains && Array.isArray(values.hyperlane.chains)) {
      return values.hyperlane.chains
        .map((c: any) => c.name || c)
        .filter(Boolean);
    }
    return [];
  }

  /**
   * Compares docker images between deployed and proposed values.
   */
  protected compareDockerImages(
    deployed: HelmValues,
    proposed: HelmValues,
  ): { hasChanges: boolean; currentTag?: string; newTag?: string } {
    const deployedTag = deployed?.image?.tag;
    const proposedTag = proposed?.image?.tag;

    if (!deployedTag || !proposedTag) {
      return { hasChanges: false };
    }

    return {
      hasChanges: deployedTag !== proposedTag,
      currentTag: deployedTag,
      newTag: proposedTag,
    };
  }
}

export function getHelmReleaseName(id: string, prefix: string): string {
  let name = `${prefix}-${id.toLowerCase().replaceAll('/', '-')}`;

  // 52 because the max label length is 63, and there is an auto appended 11 char
  // suffix, e.g. `controller-revision-hash=hyperlane-warp-route-tia-mantapacific-neutron-566dc75599`
  const maxChars = 52;

  // Max out length, and it can't end with a dash.
  if (name.length > maxChars) {
    name = name.slice(0, maxChars);
    name = name.replace(/-+$/, '');
  }
  return name;
}
