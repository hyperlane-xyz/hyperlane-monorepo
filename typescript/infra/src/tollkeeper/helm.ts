import { DeployEnvironment } from '../config/deploy-environment.js';
import { HelmManager, HelmValues } from '../utils/helm.js';
import { execCmd } from '../utils/utils.js';
import {
  getTollkeeperDeploymentNames,
  getTollkeeperReleaseConfigs,
} from './releases.js';

// Tollkeeper (https://github.com/hyperlane-xyz/tollkeeper) is deployed from a
// separate repo. This manager only exists so that the set-rpc-urls script can
// refresh tollkeeper's k8s secret and restart its pods after rotating shared
// `{env}-rpc-endpoints-{chain}` GCP secrets. It does not deploy the chart.
const RPC_ENV_PREFIX = 'RPC_URL_';

export class TollkeeperHelmManager extends HelmManager {
  readonly helmReleaseName: string;
  readonly namespace: string;
  readonly helmChartPath: string = '';

  private constructor(namespace: string, releaseName: string) {
    super();
    this.helmReleaseName = releaseName;
    this.namespace = namespace;
  }

  async helmValues(): Promise<HelmValues> {
    throw new Error(
      'TollkeeperHelmManager does not deploy; chart lives in hyperlane-xyz/tollkeeper',
    );
  }

  // Pod restarts go through `kubectl rollout restart` (see restartDeployment)
  // rather than the shared pod-delete flow: Deployment pods get new names on
  // delete, which breaks the name-based wait in refreshK8sResources.
  async getManagedK8sPods(): Promise<string[]> {
    return [];
  }

  // The tollkeeper chart doesn't use the standard `app.kubernetes.io/instance`
  // label, so read the secret name directly off the Deployment's envFrom.
  async getExistingK8sSecrets(): Promise<string[]> {
    const [output] = await execCmd(
      `kubectl get deployment ${this.helmReleaseName} -n ${this.namespace} --ignore-not-found -o jsonpath='{.spec.template.spec.containers[*].envFrom[*].secretRef.name}'`,
    );
    return output.split(/\s+/).filter(Boolean);
  }

  async includesChain(chain: string): Promise<boolean> {
    const secrets = await this.getExistingK8sSecrets();
    if (secrets.length === 0) return false;

    // Query the specific RPC_URL_<CHAIN> key. `-o jsonpath='{.data}'` would
    // render the map in Go format (`map[K:V ...]`), not JSON — parsing fails.
    // Targeting the key directly returns its base64 value if present, else
    // empty string.
    const needle = `${RPC_ENV_PREFIX}${chain.toUpperCase().replaceAll('-', '_')}`;
    const [output] = await execCmd(
      `kubectl get secret ${secrets[0]} -n ${this.namespace} --ignore-not-found -o jsonpath='{.data.${needle}}'`,
    );
    return output.trim().length > 0;
  }

  // Deployment-aware restart: rolls pods without name-based polling.
  async restartDeployment(): Promise<void> {
    for (const deploymentName of getTollkeeperDeploymentNames(
      this.helmReleaseName,
    )) {
      const [existing] = await execCmd(
        `kubectl get deployment ${deploymentName} -n ${this.namespace} --ignore-not-found -o name`,
      );
      if (!existing.trim()) continue;

      console.log(
        `🔄 Restarting deployment ${deploymentName} in ${this.namespace}...`,
      );
      await execCmd(
        `kubectl rollout restart deployment/${deploymentName} -n ${this.namespace}`,
      );
      await execCmd(
        `kubectl rollout status deployment/${deploymentName} -n ${this.namespace} --timeout=180s`,
      );
      console.log(`✅  ${deploymentName} rollout complete`);
    }
  }

  static async getManagersForChain(
    environment: DeployEnvironment,
    chain: string,
  ): Promise<TollkeeperHelmManager[]> {
    const releases = getTollkeeperReleaseConfigs(environment);
    let foundDeployment = false;
    const managers = await Promise.all(
      releases.map(async ({ releaseName, namespace }) => {
        const manager = new TollkeeperHelmManager(namespace, releaseName);
        const [existsOutput] = await execCmd(
          `kubectl get deployment ${releaseName} -n ${namespace} --ignore-not-found -o name`,
        );
        if (!existsOutput.trim()) return null;
        foundDeployment = true;
        return (await manager.includesChain(chain)) ? manager : null;
      }),
    );
    if (releases.length > 0 && !foundDeployment) {
      console.warn(
        `⚠️  No Tollkeeper deployment found for ${environment}; RPC rotation will not restart Tollkeeper`,
      );
    }
    return managers.filter((m): m is TollkeeperHelmManager => m !== null);
  }
}
