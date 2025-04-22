import { sleep } from '@hyperlane-xyz/utils';

import { InfrastructureConfig } from '../../config/infrastructure.js';
import {
  createServiceAccountIfNotExists,
  createServiceAccountKey,
  getCurrentProject,
  getCurrentProjectNumber,
  grantServiceAccountRoleIfNotExists,
} from '../../utils/gcloud.js';
import {
  HelmCommand,
  addHelmRepoIfRequired,
  getDeployableHelmChartName,
  helmifyValues,
} from '../../utils/helm.js';
import { execCmd, execCmdAndParseJson } from '../../utils/utils.js';

const SECRET_ACCESSOR_ROLE = 'roles/secretmanager.secretAccessor';

// Ensures the out of the box external-secrets (with the CRDs etc) is properly deployed,
// deploying/upgrading otherwise, and performs a helm command for the separate
// `external-secrets-gcp` Helm chart (located in ./helm), which contains some environment-specific
// resources to allow ExternalSecrets in the cluster to read from GCP secret manager.
export async function runExternalSecretsHelmCommand(
  helmCommand: HelmCommand,
  infraConfig: InfrastructureConfig,
  environment: string,
) {
  await ensureExternalSecretsRelease(infraConfig);

  const values = await getGcpExternalSecretsHelmChartValues(
    infraConfig,
    environment,
  );
  return execCmd(
    `helm ${helmCommand} external-secrets-gcp ./src/infrastructure/external-secrets/helm --namespace ${
      infraConfig.externalSecrets.namespace
    } ${values.join(' ')}`,
  );
}

async function getGcpExternalSecretsHelmChartValues(
  infraConfig: InfrastructureConfig,
  environment: string,
) {
  const config = await getGcpExternalSecretsConfig(infraConfig, environment);
  return helmifyValues(config);
}

async function getGcpExternalSecretsConfig(
  infraConfig: InfrastructureConfig,
  environment: string,
) {
  const serviceAccountEmail = await createServiceAccountIfNotExists(
    infraConfig.externalSecrets.gcpServiceAccountName,
  );
  const currentProjectNumber = await getCurrentProjectNumber();
  const startsWithExpressions =
    infraConfig.externalSecrets.accessibleGCPSecretPrefixes.map(
      (prefix: string) =>
        `resource.name.startsWith("projects/${currentProjectNumber}/secrets/${prefix}")`,
    );
  await grantServiceAccountRoleIfNotExists(
    serviceAccountEmail,
    SECRET_ACCESSOR_ROLE,
    // A condition that only allows the service account to access secrets prefixed with `${environment}-`
    {
      title: `Only ${environment} secrets`,
      expression: startsWithExpressions.join(' || '),
    },
  );

  const serviceAccountKey = await createServiceAccountKey(serviceAccountEmail);
  const stringifiedKey = JSON.stringify(serviceAccountKey);
  return {
    gcp: {
      project: await getCurrentProject(),
      // Convert to base64 - Helm will automatically try to parse a string that has
      // surrounding brackets, so it's easier to just avoid the required escaping
      // and convert to base64
      serviceAccountCredentialsBase64:
        Buffer.from(stringifiedKey).toString('base64'),
    },
  };
}

async function isExternalSecretsReleaseInstalled(
  infraConfig: InfrastructureConfig,
): Promise<boolean> {
  try {
    // Gives a non-zero exit code if the release is not installed
    await execCmd(
      `helm status external-secrets --namespace ${infraConfig.externalSecrets.namespace}`,
    );
    return true;
  } catch (e) {
    return false;
  }
}

// Ensures the core `external-secrets` release (with all the CRDs etc) is up to date.
async function ensureExternalSecretsRelease(infraConfig: InfrastructureConfig) {
  // Prometheus's helm chart requires a repository to be added
  await addHelmRepoIfRequired(infraConfig.externalSecrets.helmChart);

  // Only install the release if it doesn't already exist. We've observed
  // some issues attempting an upgrade when the external-secrets release
  // already exists. Doing so could result in the CRD being deleted and
  // recreated, which would cause all existing external-secrets CRDs to be
  // deleted!
  if (!(await isExternalSecretsReleaseInstalled(infraConfig))) {
    // The name passed in must be in the form `repo/chartName`
    const chartName = getDeployableHelmChartName(
      infraConfig.externalSecrets.helmChart,
    );

    await execCmd(
      `helm upgrade external-secrets ${chartName} --namespace ${infraConfig.externalSecrets.namespace} --create-namespace --version ${infraConfig.externalSecrets.helmChart.version} --install --set installCRDs=true `,
    );
  } else {
    console.log('External-secrets release already installed.');
  }

  // Wait for the external-secrets-webhook deployment to have a ready replica.
  // The webhook deployment is required in order for subsequent deployments
  // that make use of external-secrets CRDs to be successful.
  while (true) {
    console.log(
      'Waiting for external-secrets webhook deployment to be ready...',
    );

    // Note `kubectl wait` exists and newer versions support the ability to wait for
    // arbitrary conditions. However this is a recent feature, so instead we poll to
    // avoid annoying kubectl versioning issues.
    try {
      const readyReplicas = await execCmdAndParseJson(
        `kubectl get deploy external-secrets-webhook -o jsonpath='{.status.readyReplicas}' --namespace ${infraConfig.externalSecrets.namespace}`,
      );
      if (readyReplicas > 0) {
        return;
      }
    } catch (_) {
      console.log('Still not ready...');
    }
    // Sleep a second and try again
    await sleep(1000);
  }
}
