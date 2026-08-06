import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import fs from 'fs';

import { retryAsync, rootLogger } from '@hyperlane-xyz/utils';

import { DockerImageNames } from '../../config/docker.js';
import { rm, writeFile } from 'fs/promises';

import { execCmd, execCmdAndParseJson } from './utils.js';

export const GCP_PROJECT_ID = 'abacus-labs-dev';

interface IamCondition {
  title: string;
  expression: string;
}

// Shape of an entry in a `gcloud ... get-iam-policy --format=json` response's
// `bindings` array — narrows the `any` that `execCmdAndParseJson` returns.
interface IamPolicyBinding {
  role: string;
  members?: string[];
  condition?: IamCondition;
}

const logger = rootLogger.child({ module: 'infra:utils:gcloud' });
const kmsIamGrantQueues = new Map<string, Promise<void>>();
const gcsBucketMutationQueues = new Map<string, Promise<void>>();
let serviceAccountCreateQueue: Promise<void> = Promise.resolve();

async function withKmsIamGrantQueue<T>(
  queueKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = kmsIamGrantQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.then(task, task);
  const queued = run.then(
    () => undefined,
    () => undefined,
  );
  kmsIamGrantQueues.set(queueKey, queued);

  try {
    return await run;
  } finally {
    if (kmsIamGrantQueues.get(queueKey) === queued) {
      kmsIamGrantQueues.delete(queueKey);
    }
  }
}

async function withGcsBucketMutationQueue<T>(
  bucketName: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = gcsBucketMutationQueues.get(bucketName) ?? Promise.resolve();
  const run = previous.then(task, task);
  const queued = run.then(
    () => undefined,
    () => undefined,
  );
  gcsBucketMutationQueues.set(bucketName, queued);

  try {
    return await run;
  } finally {
    if (gcsBucketMutationQueues.get(bucketName) === queued) {
      gcsBucketMutationQueues.delete(bucketName);
    }
  }
}

async function withServiceAccountCreateQueue<T>(
  task: () => Promise<T>,
): Promise<T> {
  const previous = serviceAccountCreateQueue;
  const run = previous.then(task, task);
  serviceAccountCreateQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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
    logger.debug(
      `Using environment variable instead of GCP secret with name ${secretName}`,
    );
    output = envVarOverride;
  } else {
    logger.debug(`Fetching GCP secret with name ${secretName}`);
    try {
      output = await fetchLatestGCPSecret(secretName);
    } catch (err) {
      throw new Error(
        `Error fetching GCP secret with name ${secretName}: ${err}`,
      );
    }
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
    logger.debug('GCP secret overrides disabled');
    return undefined;
  }
  logger.debug('GCP secret overrides enabled');
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
  logger.debug(`Checking if GCP secret exists for ${fullName}`);

  const matches = await execCmdAndParseJson(
    `gcloud secrets list --filter name=${fullName} --format json`,
  );
  logger.debug(`Matches: ${matches.length}`);
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
  } catch (err) {
    logger.error(
      { err },
      `Error checking if secret ${secretName} exists: ${err}`,
    );
    throw err;
  }
}

export async function getGcpSecretLatestVersionName(secretName: string) {
  const client = await getSecretManagerServiceClient();
  const [version] = await client.getSecretVersion({
    name: `projects/${GCP_PROJECT_ID}/secrets/${secretName}/versions/latest`,
  });

  return version?.name;
}

let secretManagerServiceClient: SecretManagerServiceClient | undefined;

export async function getSecretManagerServiceClient() {
  secretManagerServiceClient ??= new SecretManagerServiceClient({
    projectId: GCP_PROJECT_ID,
  });
  return secretManagerServiceClient;
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
    logger.debug(`Created new GCP secret for ${secretName}`);
  } else {
    await execCmd(
      `gcloud secrets versions add ${secretName} --data-file=${fileName}`,
    );
    logger.debug(`Added new version to existing GCP secret for ${secretName}`);
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
    logger.debug(`Created new GCP secret for ${secretName}`);
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
  logger.debug(`Added secret version ${version?.name}`);
}

export async function disableGCPSecretVersion(secretName: string) {
  const client = await getSecretManagerServiceClient();

  const [version] = await client.disableSecretVersion({
    name: secretName,
  });
  logger.debug(`Disabled secret version ${version?.name}`);
}

// Returns the email of the service account
export async function createServiceAccountIfNotExists(
  serviceAccountName: string,
  project: string = GCP_PROJECT_ID,
) {
  return withServiceAccountCreateQueue(async () => {
    let serviceAccountInfo = await getServiceAccountInfo(
      serviceAccountName,
      project,
    );
    if (!serviceAccountInfo) {
      try {
        serviceAccountInfo = await retryAsync(
          () => createServiceAccount(serviceAccountName, project),
          3,
          60_000,
        );
        logger.debug(
          `Created new service account with name ${serviceAccountName}`,
        );
      } catch (error) {
        // This service account is shared across every validator index for the
        // chain (see ValidatorAgentGcpUser), so concurrent buildConfig() calls
        // race the list-then-create above. Re-check real state rather than
        // pattern-match the error text — only recover if it genuinely exists now.
        serviceAccountInfo = await getServiceAccountInfo(
          serviceAccountName,
          project,
        );
        if (!serviceAccountInfo) {
          throw error;
        }
        logger.debug(
          `Service account with name ${serviceAccountName} already exists`,
        );
      }
    } else {
      logger.debug(
        `Service account with name ${serviceAccountName} already exists`,
      );
    }
    return serviceAccountInfo.email;
  });
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
    logger.debug(
      `Service account ${serviceAccountEmail} already has role ${role}`,
    );
    return;
  }
  await execCmd(
    `gcloud projects add-iam-policy-binding $(gcloud config get-value project) --member="serviceAccount:${serviceAccountEmail}" --role="${role}" ${
      condition
        ? `--condition=title='${condition.title}',expression='${condition.expression}'`
        : ''
    }`,
  );
  logger.debug(
    `Granted role ${role} to service account ${serviceAccountEmail}`,
  );
}

export async function grantServiceAccountStorageRoleIfNotExists(
  serviceAccountEmail: string,
  bucketName: string,
  role: string,
) {
  return withGcsBucketMutationQueue(bucketName, async () => {
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
      logger.debug(
        `Service account ${serviceAccountEmail} already has role ${role} on bucket ${bucketName}`,
      );
      return;
    }
    // A just-created service account can take a few seconds to propagate to
    // other GCP APIs (Storage's IAM binding endpoint here) — retry rather than
    // fail outright on "does not exist" for a service account we just created.
    await retryAsync(
      () =>
        execCmd(
          `gcloud storage buckets add-iam-policy-binding ${bucketUri} --member="serviceAccount:${serviceAccountEmail}" --role="${role}"`,
        ),
      6,
      3000,
    );
  });
}

// == Cloud KMS + GCS + Workload Identity (validator provisioning) ==

// Returns the full KeyRing resource name.
export async function createKmsKeyRingIfNotExists(
  project: string,
  location: string,
  keyRingId: string,
): Promise<string> {
  const resourceName = `projects/${project}/locations/${location}/keyRings/${keyRingId}`;
  const listCmd = `gcloud kms keyrings list --project=${project} --location=${location} --filter="name=${resourceName}" --format=json`;
  const matches = await execCmdAndParseJson(listCmd);
  if (matches.length > 0) {
    logger.debug(`KMS key ring ${resourceName} already exists`);
    return resourceName;
  }

  try {
    await execCmd(
      `gcloud kms keyrings create ${keyRingId} --project=${project} --location=${location}`,
    );
    logger.debug(`Created new KMS key ring ${resourceName}`);
  } catch (error) {
    // The keyring is shared across every validator index (see
    // AgentGcpKmsKey), so concurrent createIfNotExists() calls race the
    // list-then-create above. Re-check real state rather than pattern-match
    // the error text — only swallow the error if the ring genuinely exists now.
    const matchesNow = await execCmdAndParseJson(listCmd);
    if (matchesNow.length === 0) {
      throw error;
    }
    logger.debug(`KMS key ring ${resourceName} already exists`);
  }
  return resourceName;
}

// Returns the full CryptoKey resource name. Never exports key material —
// only usable via KMS's own sign API.
export async function createKmsSignerKeyIfNotExists(
  project: string,
  location: string,
  keyRingId: string,
  keyId: string,
): Promise<string> {
  const resourceName = `projects/${project}/locations/${location}/keyRings/${keyRingId}/cryptoKeys/${keyId}`;
  const listCmd = `gcloud kms keys list --project=${project} --location=${location} --keyring=${keyRingId} --filter="name=${resourceName}" --format=json`;
  const matches = await execCmdAndParseJson(listCmd);
  if (matches.length > 0) {
    logger.debug(`KMS signing key ${resourceName} already exists`);
    return resourceName;
  }

  try {
    await execCmd(
      `gcloud kms keys create ${keyId} --project=${project} --location=${location} --keyring=${keyRingId} --purpose=asymmetric-signing --default-algorithm=ec-sign-secp256k1-sha256 --protection-level=hsm`,
    );
    logger.debug(`Created new KMS signing key ${resourceName}`);
  } catch (error) {
    // This key is shared across every chain that validator index signs for
    // (see AgentGcpKmsKey), so concurrent createIfNotExists() calls race the
    // list-then-create above. Re-check real state rather than pattern-match
    // the error text — only swallow the error if the key genuinely exists now.
    const matchesNow = await execCmdAndParseJson(listCmd);
    if (matchesNow.length === 0) {
      throw error;
    }
    logger.debug(`KMS signing key ${resourceName} already exists`);
  }
  return resourceName;
}

// Used to derive the key's Ethereum address; private key material never leaves KMS.
export async function getKmsPublicKeyPem(
  project: string,
  location: string,
  keyRingId: string,
  keyId: string,
  version = '1',
): Promise<string> {
  const [pem] = await execCmd(
    `gcloud kms keys versions get-public-key ${version} --project=${project} --location=${location} --keyring=${keyRingId} --key=${keyId} --output-file=-`,
  );
  return pem;
}

// Scoped to this one CryptoKey — not the key ring or project.
export async function grantKmsKeySignerRoleIfNotExists(
  project: string,
  location: string,
  keyRingId: string,
  keyId: string,
  serviceAccountEmail: string,
) {
  const member = `serviceAccount:${serviceAccountEmail}`;
  const role = 'roles/cloudkms.signerVerifier';
  const queueKey = `${project}/${location}/${keyRingId}/${keyId}`;

  await withKmsIamGrantQueue(queueKey, () =>
    retryAsync(
      async () => {
        const policy = await execCmdAndParseJson(
          `gcloud kms keys get-iam-policy ${keyId} --project=${project} --location=${location} --keyring=${keyRingId} --format=json`,
        );
        const hasRole = (policy.bindings || []).some(
          (binding: IamPolicyBinding) =>
            binding.role === role && binding.members?.includes(member),
        );
        if (hasRole) {
          logger.debug(
            `Service account ${serviceAccountEmail} already has ${role} on key ${keyId}`,
          );
          return;
        }

        await execCmd(
          `gcloud kms keys add-iam-policy-binding ${keyId} --project=${project} --location=${location} --keyring=${keyRingId} --member="${member}" --role="${role}"`,
        );
        logger.debug(
          `Granted ${role} to ${serviceAccountEmail} on key ${keyId}`,
        );
      },
      6,
      3000,
    ),
  );
}

export async function createGcsBucketIfNotExists(
  project: string,
  location: string,
  bucketName: string,
) {
  return withGcsBucketMutationQueue(bucketName, async () => {
    const listCmd = `gcloud storage buckets list --project=${project} --filter="name=${bucketName}" --format=json`;
    const matches = await execCmdAndParseJson(listCmd);
    if (matches.length > 0) {
      logger.debug(`GCS bucket ${bucketName} already exists`);
      return;
    }

    try {
      await execCmd(
        `gcloud storage buckets create gs://${bucketName} --project=${project} --location=${location} --uniform-bucket-level-access`,
      );
      logger.debug(`Created new GCS bucket ${bucketName}`);
    } catch (error) {
      // This bucket is shared across every chain that validator index writes
      // checkpoints for (see #configForValidator), so concurrent
      // createIfNotExists() calls race the list-then-create above. Re-check
      // real state rather than pattern-match the error text — only swallow the
      // error if the bucket genuinely exists now.
      const matchesNow = await execCmdAndParseJson(listCmd);
      if (matchesNow.length === 0) {
        throw error;
      }
      logger.debug(`GCS bucket ${bucketName} already exists`);
    }
  });
}

// Public, unauthenticated read — relayers with no relationship to this
// project still need to fetch checkpoints.
export async function grantPublicReadOnBucketIfNotExists(bucketName: string) {
  return withGcsBucketMutationQueue(bucketName, async () => {
    const role = 'roles/storage.objectViewer';
    const policy = await execCmdAndParseJson(
      `gcloud storage buckets get-iam-policy gs://${bucketName} --format=json`,
    );
    const hasRole = (policy.bindings || []).some(
      (binding: IamPolicyBinding) =>
        binding.role === role && binding.members?.includes('allUsers'),
    );
    if (hasRole) {
      logger.debug(`Bucket ${bucketName} is already publicly readable`);
      return;
    }
    await execCmd(
      `gcloud storage buckets add-iam-policy-binding gs://${bucketName} --member=allUsers --role="${role}"`,
    );
    logger.debug(`Granted public read on bucket ${bucketName}`);
  });
}

// Lets a pod running as this KSA impersonate the GSA via Workload Identity —
// no static credential anywhere.
export async function bindWorkloadIdentityUserIfNotExists(
  serviceAccountEmail: string,
  project: string,
  namespace: string,
  ksaName: string,
) {
  const member = `serviceAccount:${project}.svc.id.goog[${namespace}/${ksaName}]`;
  const role = 'roles/iam.workloadIdentityUser';
  // A just-created service account can take a few seconds to propagate to
  // other GCP APIs — retry the whole read-then-write rather than fail
  // outright on "does not exist" for a service account we just created.
  await retryAsync(
    async () => {
      const policy = await execCmdAndParseJson(
        `gcloud iam service-accounts get-iam-policy ${serviceAccountEmail} --project=${project} --format=json`,
      );
      const hasRole = (policy.bindings || []).some(
        (binding: IamPolicyBinding) =>
          binding.role === role && binding.members?.includes(member),
      );
      if (hasRole) {
        logger.debug(`${member} already bound to ${serviceAccountEmail}`);
        return;
      }
      await execCmd(
        `gcloud iam service-accounts add-iam-policy-binding ${serviceAccountEmail} --project=${project} --member="${member}" --role="${role}"`,
      );
      logger.debug(
        `Bound ${member} to ${serviceAccountEmail} via Workload Identity`,
      );
    },
    6,
    3000,
  );
}

export async function createServiceAccountKey(serviceAccountEmail: string) {
  const localKeyFile = '/tmp/tmp_key.json';
  await execCmd(
    `gcloud iam service-accounts keys create ${localKeyFile} --iam-account=${serviceAccountEmail}`,
  );
  const key = JSON.parse(fs.readFileSync(localKeyFile, 'utf8'));
  fs.rmSync(localKeyFile);
  logger.debug(`Created new service account key for ${serviceAccountEmail}`);
  return key;
}

// The alphanumeric project name / ID
export async function getCurrentProject() {
  const [result] = await execCmd('gcloud config get-value project');
  logger.debug(`Current GCP project ID: ${result.trim()}`);
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
  logger.debug(`Retrieved IAM policy bindings for ${memberEmail}`);
  return bindings;
}

async function createServiceAccount(
  serviceAccountName: string,
  project: string,
) {
  return execCmdAndParseJson(
    `gcloud iam service-accounts create ${serviceAccountName} --project=${project} --display-name="${serviceAccountName}" --format json`,
  );
}

async function getServiceAccountInfo(
  serviceAccountName: string,
  project: string,
) {
  // Filter by email, not displayName - displayName is mutable and not
  // guaranteed unique, so a filter on it could match a different service
  // account than the one `serviceAccountName` was created as, and callers
  // then grant that account KMS signer / bucket-admin access. The account ID
  // (and therefore its email) is fixed at creation time (see
  // createServiceAccount, which passes serviceAccountName as the account ID),
  // so deriving the same email here is the exact, unambiguous match.
  //
  // By filtering, we get an array with one element upon a match and an empty
  // array if there is not a match, which is desirable because it never errors.
  const email = `${serviceAccountName}@${project}.iam.gserviceaccount.com`;
  const matches = await execCmdAndParseJson(
    `gcloud iam service-accounts list --project=${project} --format json --filter email="${email}"`,
  );
  if (matches.length === 0) {
    logger.debug(`No service account found with name ${serviceAccountName}`);
    return undefined;
  }
  logger.debug(`Found service account with name ${serviceAccountName}`);
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

async function checkDockerTagExists({
  org = 'hyperlane-xyz',
  image,
  tag,
}: {
  org?: string;
  image: string;
  tag: string;
}): Promise<boolean> {
  try {
    // GHCR requires a bearer token even for public images
    const tokenRes = await fetch(
      `https://ghcr.io/token?service=ghcr.io&scope=repository:${org}/${image}:pull`,
    );
    if (!tokenRes.ok) return false;
    const { token } = (await tokenRes.json()) as { token: string };
    const url = `https://ghcr.io/v2/${org}/${image}/manifests/${tag}`;
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json',
      },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function checkAgentImageExists(tag: string) {
  return checkDockerTagExists({
    image: DockerImageNames.AGENT,
    tag,
  });
}

export async function checkMonorepoImageExists(tag: string) {
  return checkDockerTagExists({
    image: DockerImageNames.MONOREPO,
    tag,
  });
}

export function warnIfPrTag(component: string, tag: string) {
  if (tag.startsWith('pr-')) {
    logger.warn(
      `${component} is using a PR image tag: ${tag}. PR images are cleaned up after 1 week. Use a main branch tag for persistent deployments.`,
    );
  }
}

export async function checkNodeServicesImageExists(tag: string) {
  return checkDockerTagExists({
    image: DockerImageNames.NODE_SERVICES,
    tag,
  });
}
