import { DeployEnvironment } from '../config/environment.js';
import { HelmManager, HelmValues } from '../utils/helm.js';
import { execCmd } from '../utils/utils.js';

// Tollkeeper (https://github.com/hyperlane-xyz/tollkeeper) is deployed from a
// separate repo. This manager only exists so that the set-rpc-urls script can
// refresh tollkeeper's k8s secret and restart its pods after rotating shared
// `{env}-rpc-endpoints-{chain}` GCP secrets. It does not deploy the chart.
const RELEASE_NAMES: Partial<Record<DeployEnvironment, string>> = {
  mainnet3: 'tollkeeper-staging',
};

const RPC_ENV_PREFIX = 'RPC_URL_';

export class TollkeeperHelmManager extends HelmManager {
  readonly helmReleaseName: string;
  readonly namespace: string;
  readonly helmChartPath: string = '';

  private constructor(environment: DeployEnvironment, releaseName: string) {
    super();
    this.helmReleaseName = releaseName;
    this.namespace = environment;
  }

  async helmValues(): Promise<HelmValues> {
    throw new Error(
      'TollkeeperHelmManager does not deploy; chart lives in hyperlane-xyz/tollkeeper',
    );
  }

  // Tollkeeper is a Deployment (chart labels pods with `app=<release>`), so the
  // base StatefulSet-only pod discovery returns nothing. Filter on ReplicaSet
  // ownership to get Deployment-managed pods.
  async getManagedK8sPods(): Promise<string[]> {
    const [output] = await execCmd(
      `kubectl get pods --selector=app=${this.helmReleaseName} -o jsonpath='{range .items[?(@.metadata.ownerReferences[0].kind=="ReplicaSet")]}{.metadata.name}{"\\n"}{end}' -n ${this.namespace}`,
    );
    return output.split('\n').filter(Boolean);
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

    const [output] = await execCmd(
      `kubectl get secret ${secrets[0]} -n ${this.namespace} --ignore-not-found -o jsonpath='{.data}'`,
    );

    const needle = `${RPC_ENV_PREFIX}${chain.toUpperCase().replaceAll('-', '_')}`;
    const keys = Object.keys(JSON.parse(output || '{}'));
    return keys.includes(needle);
  }

  static async getManagerForChain(
    environment: DeployEnvironment,
    chain: string,
  ): Promise<TollkeeperHelmManager | null> {
    const releaseName = RELEASE_NAMES[environment];
    if (!releaseName) return null;

    const manager = new TollkeeperHelmManager(environment, releaseName);
    const [existsOutput] = await execCmd(
      `kubectl get deployment ${releaseName} -n ${environment} --ignore-not-found -o name`,
    );
    if (!existsOutput.trim()) return null;

    return (await manager.includesChain(chain)) ? manager : null;
  }
}
