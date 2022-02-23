import { InfrastructureConfig } from '../../config/infrastructure';
import { createServiceAccountIfNotExists, createServiceAccountKey, getCurrentProject, grantServiceAccountRoleIfNotExists } from '../../utils/gcloud';
import { addHelmRepoIfRequired, getDeployableHelmChartName, HelmCommand, helmifyValues } from '../../utils/helm';
import { execCmd } from '../../utils/utils';

const SECRET_ACCESSOR_ROLE = 'roles/secretmanager.secretAccessor';

export async function runExternalSecretsHelmCommand(
  helmCommand: HelmCommand,
  infraConfig: InfrastructureConfig,
) {
  await ensureExternalSecretsRelease(infraConfig);

  const values = await getGcpExternalSecretsHelmChartValues(infraConfig);
  return execCmd(
    `helm ${helmCommand} external-secrets-gcp ./src/infrastructure/external-secrets/helm --namespace ${
      infraConfig.externalSecrets.namespace
    } ${values.join(' ')}`
  );
}

async function getGcpExternalSecretsHelmChartValues(
  infraConfig: InfrastructureConfig,
) {
  const config = await getGcpExternalSecretsConfig(infraConfig);
  return helmifyValues(config);
}

async function getGcpExternalSecretsConfig(infraConfig: InfrastructureConfig) {
  const serviceAccountEmail = await createServiceAccountIfNotExists(
    infraConfig.externalSecrets.gcpServiceAccountName
  );
  await grantServiceAccountRoleIfNotExists(serviceAccountEmail, SECRET_ACCESSOR_ROLE);

  const serviceAccountKey = await createServiceAccountKey(serviceAccountEmail);
  const stringifiedKey = JSON.stringify(serviceAccountKey);
  return {
    gcp: {
      project: await getCurrentProject(),
      // Convert to base64 - Helm will automatically try to parse a string that has
      // surrounding brackets, so it's easier to just avoid the required escaping
      // and convert to base64
      serviceAccountCredentialsBase64: Buffer.from(stringifiedKey).toString('base64'),
    }
  }
}

// Ensures the core `external-secrets` release (with all the CRDs etc) is up to date.
async function ensureExternalSecretsRelease(infraConfig: InfrastructureConfig) {
  // Prometheus's helm chart requires a repository to be added
  await addHelmRepoIfRequired(infraConfig.externalSecrets.helmChart);
  // The name passed in must be in the form `repo/chartName`
  const chartName = getDeployableHelmChartName(infraConfig.externalSecrets.helmChart);

  return execCmd(
    `helm upgrade external-secrets ${chartName} --namespace ${
      infraConfig.externalSecrets.namespace
    } --create-namespace --version ${infraConfig.externalSecrets.helmChart.version} --install --set installCRDs=true `
  );
}
