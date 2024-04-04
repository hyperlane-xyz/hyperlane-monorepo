import fs from 'fs';

import { rootLogger } from '@hyperlane-xyz/utils';

import { rm, writeFile } from 'fs/promises';

import { execCmd, execCmdAndParseJson } from './utils.js';

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
    [output] = await execCmd(
      `gcloud secrets versions access latest --secret ${secretName}`,
    );
  }

  if (parseJson) {
    return JSON.parse(output);
  }
  return output;
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
    return undefined;
  }
  const overrideEnvVarName = `GCP_SECRET_OVERRIDE_${gcpSecretName
    .replaceAll('-', '_')
    .toUpperCase()}`;
  return process.env[overrideEnvVarName];
}

export async function gcpSecretExists(secretName: string) {
  const fullName = `projects/${await getCurrentProjectNumber()}/secrets/${secretName}`;
  debugLog(`Checking if GCP secret exists for ${fullName}`);

  const matches = await execCmdAndParseJson(
    `gcloud secrets list --filter name=${fullName} --format json`,
  );
  debugLog(`Matches: ${matches.length}`);
  return matches.length > 0;
}

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
