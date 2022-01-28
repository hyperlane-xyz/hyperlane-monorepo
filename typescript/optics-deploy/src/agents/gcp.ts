import { Wallet } from 'ethers';
import { rm, writeFile } from 'fs/promises';
import { KEY_ROLES } from '../agents';
import { Chain, replaceDeployer } from '../chain';
import { CoreConfig } from '../core/CoreDeploy';
import { execCmd, include, strip0x } from '../utils';

function isAttestationKey(role: string) {
  return role.endsWith('attestation');
}

// This is the type for how the keys are persisted in GCP
export interface SecretManagerPersistedKeys {
  privateKey: string;
  address: string;
  role: string;
  environment: string;
  // Exists if key is an attestation key
  // TODO: Add this to the type
  chainName?: string;
}

export async function deleteAgentGCPKeys(
  environment: string,
  chainNames: string[],
) {
  await Promise.all(
    KEY_ROLES.map(async (role) => {
      if (isAttestationKey(role)) {
        await Promise.all(
          chainNames.map((chainName) =>
            execCmd(
              `gcloud secrets delete ${gcpKeyIdentifier(
                environment,
                role,
                chainName,
              )} --quiet`,
            ),
          ),
        );
      } else {
        await execCmd(
          `gcloud secrets delete ${gcpKeyIdentifier(
            environment,
            role,
            'any',
          )} --quiet`,
        );
      }
    }),
  );
  await execCmd(
    `gcloud secrets delete optics-key-${environment}-addresses --quiet`,
  );
}

async function createAgentGCPKey(
  environment: string,
  role: string,
  chainName: string,
  rotate = false,
) {
  const wallet = Wallet.createRandom();
  const address = await wallet.getAddress();
  const identifier = gcpKeyIdentifier(environment, role, chainName);
  const fileName = `${identifier}.txt`;

  let labels = `environment=${environment},role=${role}`;
  if (isAttestationKey(role)) labels += `,chain=${chainName}`;

  await writeFile(
    fileName,
    JSON.stringify({
      role,
      environment,
      privateKey: wallet.privateKey,
      address,
      ...include(isAttestationKey(role), { chainName }),
    }),
  );

  if (rotate) {
    await execCmd(
      `gcloud secrets versions add ${identifier} --data-file=${fileName}`,
    );
  } else {
    await execCmd(
      `gcloud secrets create ${identifier} --data-file=${fileName} --replication-policy=automatic --labels=${labels}`,
    );
  }

  await rm(fileName);
  return {
    role,
    environment,
    address,
    chainName,
  };
}

// The identifier for a key within GCP Secret Manager
function gcpKeyIdentifier(
  environment: string,
  role: string,
  chainName: string,
) {
  return isAttestationKey(role)
    ? `optics-key-${environment}-${chainName}-${role}`
    : `optics-key-${environment}-${role}`;
}

// The identifier for a key within a memory representation
export function memoryKeyIdentifier(role: string, chainName: string) {
  return isAttestationKey(role) ? `${chainName}-${role}` : role;
}

function persistKeyAsAddress(key: {
  role: string;
  environment: string;
  address: string;
  chainName: string;
}) {
  return {
    role: isAttestationKey(key.role)
      ? `${key.chainName}-${key.role}`
      : key.role,
    address: key.address,
  };
}

export async function rotateGCPKey(
  environment: string,
  role: string,
  chainName: string,
) {
  const newKey = await createAgentGCPKey(environment, role, chainName, true);
  const addressesIdentifier = `optics-key-${environment}-addresses`;
  const fileName = `${addressesIdentifier}.txt`;
  const [addressesRaw] = await execCmd(
    `gcloud secrets versions access latest --secret ${addressesIdentifier}`,
  );
  const addresses = JSON.parse(addressesRaw);
  const filteredAddresses = addresses.filter((_: any) => {
    const matchingRole = memoryKeyIdentifier(role, chainName);
    return _.role !== matchingRole;
  });

  filteredAddresses.push(persistKeyAsAddress(newKey));

  await writeFile(fileName, JSON.stringify(filteredAddresses));
  await execCmd(
    `gcloud secrets versions add ${addressesIdentifier} --data-file=${fileName}`,
  );
  await rm(fileName);

  return newKey;
}

export async function createAgentGCPKeys(
  environment: string,
  chainNames: string[],
) {
  const keys = await Promise.all(
    KEY_ROLES.flatMap((role) => {
      if (isAttestationKey(role)) {
        return chainNames.map((chainName) =>
          createAgentGCPKey(environment, role, chainName),
        );
      } else {
        // Chain name doesnt matter for non attestation keys
        return [createAgentGCPKey(environment, role, 'any')];
      }
    }),
  );
  const fileName = `optics-key-${environment}-addresses.txt`

  await writeFile(
    fileName,
    JSON.stringify(keys.map(persistKeyAsAddress)),
  );
  await execCmd(
    `gcloud secrets create optics-key-${environment}-addresses --data-file=${fileName} --replication-policy=automatic --labels=environment=${environment}`,
  );
  await rm(fileName);
}

async function getAgentGCPKey(
  environment: string,
  role: string,
  chainName: string,
) {
  const [secretRaw] = await execCmd(
    `gcloud secrets versions access latest --secret ${gcpKeyIdentifier(
      environment,
      role,
      chainName,
    )}`,
  );
  const secret: SecretManagerPersistedKeys = JSON.parse(secretRaw);
  return [memoryKeyIdentifier(role, chainName), secret] as [
    string,
    SecretManagerPersistedKeys,
  ];
}

// This function returns all the GCP keys for a given home chain in a dictionary where the key is either the role or `${chainName}-${role}` in the case of attestation keys
export async function getAgentGCPKeys(environment: string, chainName: string) {
  const secrets = await Promise.all(
    KEY_ROLES.map((role) => getAgentGCPKey(environment, role, chainName)),
  );
  return Object.fromEntries(secrets);
}

// Modifies a Chain configuration with the deployer key pulled from GCP
export async function addDeployerGCPKey(environment: string, chain: Chain) {
  const [deployerSecretRaw] = await execCmd(
    `gcloud secrets versions access latest --secret optics-key-${environment}-deployer`,
  );
  const deployerSecret = JSON.parse(deployerSecretRaw).privateKey;
  return replaceDeployer(chain, strip0x(deployerSecret));
}

// Modifies a Core configuration with the relevant watcher/updater addresses pulled from GCP
export async function addAgentGCPAddresses(
  environment: string,
  chain: Chain,
  config: CoreConfig,
): Promise<CoreConfig> {
  const [addressesRaw] = await execCmd(
    `gcloud secrets versions access latest --secret optics-key-${environment}-addresses`,
  );
  const addresses = JSON.parse(addressesRaw);
  const watcher = addresses.find(
    (_: any) => _.role === `${chain.name}-watcher-attestation`,
  ).address;
  const updater = addresses.find(
    (_: any) => _.role === `${chain.name}-updater-attestation`,
  ).address;
  const deployer = addresses.find((_: any) => _.role === 'deployer').address;
  return {
    ...config,
    updater: updater,
    recoveryManager: deployer,
    watchers: [watcher],
  };
}
