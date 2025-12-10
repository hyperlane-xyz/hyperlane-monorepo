import { confirm } from '@inquirer/prompts';

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
//
// Note: This function automatically patches the external-secrets CRDs with the correct CA bundle
// to prevent GCP console warnings about invalid TLS certificates. The patching is done after
// the Helm deployment to ensure the webhook works properly.
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

  // The name passed in must be in the form `repo/chartName`
  const chartName = getDeployableHelmChartName(
    infraConfig.externalSecrets.helmChart,
  );

  // Only install CRDs if the release doesn't already exist. We've observed
  // issues installing the CRDs when they already exist - doing so could result
  // in the CRD being deleted and recreated, which would cause all existing external-secrets
  // CRD resources to be deleted!
  let installCrds = false;
  if (!(await isExternalSecretsReleaseInstalled(infraConfig))) {
    const shouldProceed = await confirm({
      message:
        '⚠️ WARNING ⚠️\nThe external-secrets CRDs are not installed. This will install them, which may delete and recreate existing external-secrets CRDs. Do not do this unless this is a fresh cluster or you are sure you want to do this.\nContinue?',
    });

    if (!shouldProceed) {
      throw new Error('User cancelled external-secrets CRD installation');
    }
    console.log(
      'Installing external-secrets release with CRDs, as it is not already installed.',
    );
    installCrds = true;
  }

  await execCmd(
    `helm upgrade external-secrets ${chartName} --namespace ${infraConfig.externalSecrets.namespace} --create-namespace --version ${infraConfig.externalSecrets.helmChart.version} --install --set concurrent=10 ${installCrds ? '--set installCRDs=true' : ''}`,
  );

  // After Helm deployment, automatically patch the CRDs with the correct CA bundle
  // This ensures the webhook conversion works properly and prevents GCP console warnings
  await patchExternalSecretsCRDsWithCABundle(
    infraConfig.externalSecrets.namespace,
  );

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

async function patchExternalSecretsCRDsWithCABundle(namespace: string) {
  try {
    console.log(
      'Retrieving cluster CA bundle for external-secrets webhook configuration...',
    );

    // Get the current cluster's CA bundle to configure the webhook properly
    // This prevents the GCP console warning about invalid TLS certificates
    const [caBundle, stderr] = await execCmd(
      `kubectl config view --raw --minify --flatten -o jsonpath='{.clusters[0].cluster.certificate-authority-data}'`,
    );

    if (!caBundle || !caBundle.trim()) {
      console.warn(
        'Warning: Could not retrieve cluster CA bundle, skipping CRD patch.',
      );
      return;
    }

    // The CA bundle is already base64 encoded from kubectl config
    const caBundleBase64 = caBundle.trim();

    // Check if the CRDs already have the correct CA bundle
    if (await areCRDsAlreadyPatched(caBundleBase64)) {
      console.log(
        'External-secrets CRDs already have the correct CA bundle, skipping patch.',
      );
      return;
    }

    console.log('Patching external-secrets CRDs with CA bundle...');

    // Patch the main external-secrets CRD
    await execCmd(
      `kubectl patch crd externalsecrets.external-secrets.io -p '{"spec":{"conversion":{"webhook":{"clientConfig":{"caBundle":"${caBundleBase64}"}}}}}'`,
    );

    // Patch the clusterexternalsecrets CRD as well
    await execCmd(
      `kubectl patch crd clusterexternalsecrets.external-secrets.io -p '{"spec":{"conversion":{"webhook":{"clientConfig":{"caBundle":"${caBundleBase64}"}}}}}'`,
    );

    console.log('Successfully patched external-secrets CRDs with CA bundle.');
  } catch (error) {
    console.warn(
      'Warning: Could not patch external-secrets CRDs with CA bundle:',
      error,
    );
    console.warn(
      'The webhook may not work properly and you may see GCP console warnings.',
    );
  }
}

async function areCRDsAlreadyPatched(
  expectedCaBundle: string,
): Promise<boolean> {
  try {
    // Check if the externalsecrets CRD already has the correct CA bundle
    const [currentCaBundle, stderr] = await execCmd(
      `kubectl get crd externalsecrets.external-secrets.io -o jsonpath='{.spec.conversion.webhook.clientConfig.caBundle}'`,
    );

    return currentCaBundle === expectedCaBundle;
  } catch (error) {
    // If we can't check, assume we need to patch
    return false;
  }
}
