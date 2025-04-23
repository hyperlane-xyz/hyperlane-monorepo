import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import fs from 'fs';

import { rootLogger } from '@hyperlane-xyz/utils';

import { rm, writeFile } from 'fs/promises';

import { execCmd, execCmdAndParseJson } from './utils.js';

export const GCP_PROJECT_ID = 'abacus-labs-dev';

interface IamCondition {
  title: string;
  expression: string;
}

const debugLog = rootLogger.child({ module: 'infra:utils:gcloud' }).debug;

// Allows secrets to be overridden via environment variables to avoid
// gcloud calls. This is particularly useful for running commands in k8s,
// where we can use external-secrets to fetch secrets from GCP secret manager,
// and don't necessarily want to use gcloud from within k8s.
// See tryGCPSecretFromEnvVariable for details on how to override via environment
// variables.
export async function fetchGCPSecret(
  secretName: string,
  parseJson = true,
): Promise<unknown> {
  let output: string;

  const envVarOverride = tryGCPSecretFromEnvVariable(secretName);
  if (envVarOverride !== undefined) {
    debugLog(
      `Using environment variable instead of GCP secret with name ${secretName}`,
    );
    output = envVarOverride;
  } else {
    debugLog(`Fetching GCP secret with name ${secretName}`);
    output = await fetchLatestGCPSecret(secretName);
  }

  if (parseJson) {
    return JSON.parse(output);
  }
  return output;
}

export async function fetchLatestGCPSecret(secretName: string) {
  const client = await getSecretManagerServiceClient();
  const [secretVersion] = await client.accessSecretVersion({
    name: `projects/${GCP_PROJECT_ID}/secrets/${secretName}/versions/latest`,
  });
  const secretData = secretVersion.payload?.data;
  if (!secretData) {
    throw new Error(`Secret ${secretName} missing payload`);
  }

  // Handle both string and Uint8Array
  let dataStr: string;
  if (typeof secretData === 'string') {
    dataStr = secretData;
  } else {
    dataStr = new TextDecoder().decode(secretData);
  }

  return dataStr;
}

// If the environment variable GCP_SECRET_OVERRIDES_ENABLED is `true`,
// this will attempt to find an environment variable of the form:
//  `GCP_SECRET_OVERRIDE_${gcpSecretName.replaceAll('-', '_').toUpperCase()}`
// If found, it's returned, otherwise, undefined is returned.
function tryGCPSecretFromEnvVariable(gcpSecretName: string) {
  const overridingEnabled =
    process.env.GCP_SECRET_OVERRIDES_ENABLED &&
    process.env.GCP_SECRET_OVERRIDES_ENABLED.length > 0;
  if (!overridingEnabled) {
    debugLog('GCP secret overrides disabled');
    return undefined;
  }
  debugLog('GCP secret overrides enabled');
  const overrideEnvVarName = `GCP_SECRET_OVERRIDE_${gcpSecretName
    .replaceAll('-', '_')
    .toUpperCase()}`;
  return process.env[overrideEnvVarName];
}

/**
 * Checks if a secret exists in GCP using the gcloud CLI.
 * @deprecated Use gcpSecretExistsUsingClient instead.
 * @param secretName The name of the secret to check.
 * @returns A boolean indicating whether the secret exists.
 */
export async function gcpSecretExists(secretName: string) {
  const fullName = `projects/${await getCurrentProjectNumber()}/secrets/${secretName}`;
  debugLog(`Checking if GCP secret exists for ${fullName}`);

  const matches = await execCmdAndParseJson(
    `gcloud secrets list --filter name=${fullName} --format json`,
  );
  debugLog(`Matches: ${matches.length}`);
  return matches.length > 0;
}

/**
 * Uses the SecretManagerServiceClient to check if a secret exists.
 * @param secretName The name of the secret to check.
 * @returns A boolean indicating whether the secret exists.
 */
export async function gcpSecretExistsUsingClient(
  secretName: string,
  client?: SecretManagerServiceClient,
): Promise<boolean> {
  if (!client) {
    client = await getSecretManagerServiceClient();
  }

  try {
    const fullSecretName = `projects/${await getCurrentProjectNumber()}/secrets/${secretName}`;
    const [secrets] = await client.listSecrets({
      parent: `projects/${GCP_PROJECT_ID}`,
      filter: `name=${fullSecretName}`,
    });

    return secrets.length > 0;
  } catch (e) {
    debugLog(`Error checking if secret exists: ${e}`);
    throw e;
  }
}

export async function getGcpSecretLatestVersionName(secretName: string) {
  const client = await getSecretManagerServiceClient();
  const [version] = await client.getSecretVersion({
    name: `projects/${GCP_PROJECT_ID}/secrets/${secretName}/versions/latest`,
  });

  return version?.name;
}

export async function getSecretManagerServiceClient() {
  return new SecretManagerServiceClient({
    projectId: GCP_PROJECT_ID,
  });
}

/**
 * Sets a GCP secret using the gcloud CLI. Create secret if it doesn't exist and add a new version or update the existing one.
 * @deprecated Use setGCPSecretUsingClient instead.
 * @param secretName The name of the secret to set.
 * @param secret The secret to set.
 * @param labels The labels to set on the secret.
 */
export async function setGCPSecret(
  secretName: string,
  secret: string,
  labels: Record<string, string>,
) {
  const fileName = `/tmp/${secretName}.txt`;
  await writeFile(fileName, secret);

  const exists = await gcpSecretExists(secretName);
  if (!exists) {
    const labelString = Object.keys(labels)
      .map((key) => `${key}=${labels[key]}`)
      .join(',');
    await execCmd(
      `gcloud secrets create ${secretName} --data-file=${fileName} --replication-policy=automatic --labels=${labelString}`,
    );
    debugLog(`Created new GCP secret for ${secretName}`);
  } else {
    await execCmd(
      `gcloud secrets versions add ${secretName} --data-file=${fileName}`,
    );
    debugLog(`Added new version to existing GCP secret for ${secretName}`);
  }
  await rm(fileName);
}

/**
 * Sets a GCP secret using the SecretManagerServiceClient. Create secret if it doesn't exist and add a new version or update the existing one.
 * @param secretName The name of the secret to set.
 * @param secret The secret to set.
 */
export async function setGCPSecretUsingClient(
  secretName: string,
  secret: string,
  labels?: Record<string, string>,
) {
  const client = await getSecretManagerServiceClient();

  const exists = await gcpSecretExistsUsingClient(secretName, client);
  if (!exists) {
    // Create the secret
    await client.createSecret({
      parent: `projects/${GCP_PROJECT_ID}`,
      secretId: secretName,
      secret: {
        name: secretName,
        replication: {
          automatic: {},
        },
        labels,
      },
    });
    debugLog(`Created new GCP secret for ${secretName}`);
  }
  await addGCPSecretVersion(secretName, secret, client);
}

export async function addGCPSecretVersion(
  secretName: string,
  secret: string,
  client?: SecretManagerServiceClient,
) {
  if (!client) {
    client = await getSecretManagerServiceClient();
  }

  const [version] = await client.addSecretVersion({
    parent: `projects/${GCP_PROJECT_ID}/secrets/${secretName}`,
    payload: {
      data: Buffer.from(secret, 'utf8'),
    },
  });
  debugLog(`Added secret version ${version?.name}`);
}

export async function disableGCPSecretVersion(secretName: string) {
  const client = await getSecretManagerServiceClient();

  const [version] = await client.disableSecretVersion({
    name: secretName,
  });
  debugLog(`Disabled secret version ${version?.name}`);
}

// Returns the email of the service account
export async function createServiceAccountIfNotExists(
  serviceAccountName: string,
) {
  let serviceAccountInfo = await getServiceAccountInfo(serviceAccountName);
  if (!serviceAccountInfo) {
    serviceAccountInfo = await createServiceAccount(serviceAccountName);
    debugLog(`Created new service account with name ${serviceAccountName}`);
  } else {
    debugLog(`Service account with name ${serviceAccountName} already exists`);
  }
  return serviceAccountInfo.email;
}

export async function grantServiceAccountRoleIfNotExists(
  serviceAccountEmail: string,
  role: string,
  condition?: IamCondition,
) {
  const bindings = await getIamMemberPolicyBindings(serviceAccountEmail);
  const matchedBinding = bindings.find((binding: any) => binding.role === role);
  if (
    matchedBinding &&
    iamConditionsEqual(condition, matchedBinding.condition)
  ) {
    debugLog(`Service account ${serviceAccountEmail} already has role ${role}`);
    return;
  }
  await execCmd(
    `gcloud projects add-iam-policy-binding $(gcloud config get-value project) --member="serviceAccount:${serviceAccountEmail}" --role="${role}" ${
      condition
        ? `--condition=title='${condition.title}',expression='${condition.expression}'`
        : ''
    }`,
  );
  debugLog(`Granted role ${role} to service account ${serviceAccountEmail}`);
}

export async function grantServiceAccountStorageRoleIfNotExists(
  serviceAccountEmail: string,
  bucketName: string,
  role: string,
) {
  const bucketUri = `gs://${bucketName}`;
  const existingPolicies = await execCmdAndParseJson(
    `gcloud storage buckets get-iam-policy ${bucketUri} --format="json"`,
  );
  const existingBindings = existingPolicies.bindings || [];
  const hasRole = existingBindings.some(
    (binding: any) =>
      binding.role === role &&
      binding.members &&
      binding.members.includes(`serviceAccount:${serviceAccountEmail}`),
  );
  if (hasRole) {
    debugLog(
      `Service account ${serviceAccountEmail} already has role ${role} on bucket ${bucketName}`,
    );
    return;
  }
  await execCmd(
    `gcloud storage buckets add-iam-policy-binding ${bucketUri} --member="serviceAccount:${serviceAccountEmail}" --role="${role}"`,
  );
}

export async function createServiceAccountKey(serviceAccountEmail: string) {
  const localKeyFile = '/tmp/tmp_key.json';
  await execCmd(
    `gcloud iam service-accounts keys create ${localKeyFile} --iam-account=${serviceAccountEmail}`,
  );
  const key = JSON.parse(fs.readFileSync(localKeyFile, 'utf8'));
  fs.rmSync(localKeyFile);
  debugLog(`Created new service account key for ${serviceAccountEmail}`);
  return key;
}

// The alphanumeric project name / ID
export async function getCurrentProject() {
  const [result] = await execCmd('gcloud config get-value project');
  debugLog(`Current GCP project ID: ${result.trim()}`);
  return result.trim();
}

// The numeric project number
export async function getCurrentProjectNumber() {
  const [result] = await execCmd(
    'gcloud projects list --filter="$(gcloud config get-value project)" --format="value(PROJECT_NUMBER)"',
  );
  return result.trim();
}

async function getIamMemberPolicyBindings(memberEmail: string) {
  // This puts out an ugly array of the form: [{ "bindings": { "role": "roles/..." }}, ...]
  const unprocessedRoles = await execCmdAndParseJson(
    `gcloud projects get-iam-policy $(gcloud config get-value project) --format "json(bindings)" --flatten="bindings[].members" --filter="bindings.members:${memberEmail}"`,
  );
  const bindings = unprocessedRoles.map((unprocessedRoleObject: any) => ({
    role: unprocessedRoleObject.bindings.role,
    condition: unprocessedRoleObject.bindings.condition,
  }));
  debugLog(`Retrieved IAM policy bindings for ${memberEmail}`);
  return bindings;
}

async function createServiceAccount(serviceAccountName: string) {
  return execCmdAndParseJson(
    `gcloud iam service-accounts create ${serviceAccountName} --display-name="${serviceAccountName}" --format json`,
  );
}

async function getServiceAccountInfo(serviceAccountName: string) {
  // By filtering, we get an array with one element upon a match and an empty
  // array if there is not a match, which is desirable because it never errors.
  const matches = await execCmdAndParseJson(
    `gcloud iam service-accounts list --format json --filter displayName="${serviceAccountName}"`,
  );
  if (matches.length === 0) {
    debugLog(`No service account found with name ${serviceAccountName}`);
    return undefined;
  }
  debugLog(`Found service account with name ${serviceAccountName}`);
  return matches[0];
}

function iamConditionsEqual(
  a: IamCondition | undefined,
  b: IamCondition | undefined,
) {
  // If both are undefined, they're equal
  if (a === undefined && b === undefined) {
    return true;
  }
  return a && b && a.title === b.title && a.expression === b.expression;
}
