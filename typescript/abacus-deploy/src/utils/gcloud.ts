import fs from 'fs';
import { execCmd, execCmdAndParseJson } from './utils';

interface IamCondition {
  title: string;
  expression: string;
}

export async function fetchGCPSecret(
  secretName: string,
  parseJson: boolean = true,
) {
  const [output] = await execCmd(
    `gcloud secrets versions access latest --secret ${secretName}`,
  );
  if (parseJson) {
    return JSON.parse(output);
  }
  return output;
}

// Returns the email of the service account
export async function createServiceAccountIfNotExists(
  serviceAccountName: string,
) {
  let serviceAccountInfo = await getServiceAccountInfo(serviceAccountName);
  if (!serviceAccountInfo) {
    serviceAccountInfo = await createServiceAccount(serviceAccountName);
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
  console.log('matchedBinding', matchedBinding, 'matchedBinding.condition', matchedBinding.condition)
  if (iamConditionsEqual(condition, matchedBinding.condition)) {
    return;
  }
  await execCmd(
    `gcloud projects add-iam-policy-binding $(gcloud config get-value project) --member="serviceAccount:${serviceAccountEmail}" --role="${role}" ${
      condition ? `--condition=title='${condition.title}',expression='${condition.expression}'` : ''
    }`
  );
}

export async function createServiceAccountKey(serviceAccountEmail: string) {
  const localKeyFile = '/tmp/tmp_key.json';
  await execCmd(
    `gcloud iam service-accounts keys create ${localKeyFile} --iam-account=${serviceAccountEmail}`,
  );
  const key = JSON.parse(fs.readFileSync(localKeyFile, 'utf8'));
  fs.rmSync(localKeyFile);
  return key;
}

// The alphanumeric project name / ID 
export async function getCurrentProject() {
  const [result] = await execCmd('gcloud config get-value project');
  return result.trim();
}

// The numeric project number
export async function getCurrentProjectNumber() {
  const [result] = await execCmd('gcloud projects list --filter="$(gcloud config get-value project)" --format="value(PROJECT_NUMBER)"');
  return result.trim();
}

async function getIamMemberPolicyBindings(memberEmail: string) {
  // This puts out an ugly array of the form: [{ "bindings": { "role": "roles/..." }}, ...]
  const unprocessedRoles = await execCmdAndParseJson(
    `gcloud projects get-iam-policy $(gcloud config get-value project) --format "json(bindings)" --flatten="bindings[].members" --filter="bindings.members:${memberEmail}"`,
  );
  return unprocessedRoles.map(
    (unprocessedRoleObject: any) => ({
      role: unprocessedRoleObject.bindings.role,
      condition: unprocessedRoleObject.bindings.condition,
    })
  );
}

async function createServiceAccount(serviceAccountName: string) {
  return execCmdAndParseJson(
    `gcloud iam service-accounts create ${serviceAccountName} --display-name="${serviceAccountName}" --format json`,
  );
}

async function getServiceAccountInfo(serviceAccountName: string) {
  // By filtering, we get an array with one element upon a match and an empty
  // array if there is not a match, which is desireable because it never errors.
  const matches = await execCmdAndParseJson(
    `gcloud iam service-accounts list --format json --filter displayName="${serviceAccountName}"`,
  );
  if (matches.length === 0) {
    return undefined;
  }
  return matches[0];
}

function iamConditionsEqual(a: IamCondition | undefined, b: IamCondition | undefined) {
  // If both are undefined, they're equal
  if (a === undefined && b === undefined) {
    return true;
  }
  return a && b && a.title === b.title && a.expression === b.expression;
}