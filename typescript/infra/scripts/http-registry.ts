import {
  HttpServer,
  type SignerBackends,
} from '@hyperlane-xyz/http-registry-server';
import { IRegistry } from '@hyperlane-xyz/registry';
import { assert } from '@hyperlane-xyz/utils';
import { z } from 'zod';

import { getRegistry as getMainnet3Registry } from '../config/environments/mainnet3/chains.js';
import { getRegistry as getTestnet4Registry } from '../config/environments/testnet4/chains.js';
import { resetRegistry } from '../config/registry.js';
import { assertEnvironment } from '../src/config/deploy-environment.js';
import {
  TURNKEY_ROLE_PROTOCOL,
  TURNKEY_SIGNER_PROTOCOLS,
  TurnkeyRole,
  getTurnkeyRolesForProtocol,
} from '../src/roles.js';
import {
  TurnkeyTransactionSignerBackend,
  getTurnkeyConfig,
} from '../src/utils/turnkey.js';

import { getArgs } from './agent-utils.js';

async function main() {
  const args = getArgs()
    .describe('port', 'port to deploy on')
    .describe('writeMode', 'enable write operations (disabled by default)')
    .boolean('writeMode')
    .default({ port: 3333, environment: 'mainnet3', writeMode: false });

  for (const protocol of TURNKEY_SIGNER_PROTOCOLS) {
    args.option(`signer.${protocol}`, {
      choices: getTurnkeyRolesForProtocol(protocol),
      description: `Turnkey role exposed as the ${protocol} signer`,
      type: 'string',
    });
  }

  const {
    environment: rawEnvironment,
    port,
    writeMode,
    signer: rawSigner,
  } = await args.argv;

  const environment = assertEnvironment(rawEnvironment);
  const signer = z
    .record(z.enum(TURNKEY_SIGNER_PROTOCOLS), z.nativeEnum(TurnkeyRole))
    .superRefine((config, context) => {
      for (const protocol of TURNKEY_SIGNER_PROTOCOLS) {
        const role = config[protocol];
        if (role && TURNKEY_ROLE_PROTOCOL[role] !== protocol) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [protocol],
            message: `${role} is not a ${protocol} Turnkey role`,
          });
        }
      }
    })
    .parse(rawSigner ?? {});

  const environmentToRegistry: Record<string, () => Promise<IRegistry>> = {
    mainnet3: getMainnet3Registry,
    testnet4: getTestnet4Registry,
  };

  const getRegistry = environmentToRegistry[environment];
  assert(getRegistry, `Uninitialized registry for environment: ${environment}`);

  const signers: SignerBackends = {};
  for (const protocol of TURNKEY_SIGNER_PROTOCOLS) {
    const role = signer[protocol];
    if (!role) continue;
    const backend = new TurnkeyTransactionSignerBackend(
      await getTurnkeyConfig(environment, role),
      protocol,
    );
    await backend.healthCheck();
    signers[protocol] = backend;
  }

  const httpRegistryServer = await HttpServer.create(
    async () => {
      // Reset the registry singleton to pick up new files on refresh
      resetRegistry();
      return getRegistry();
    },
    {
      writeMode,
      signerToken: process.env.HYP_HTTP_SIGNER_TOKEN,
      signers,
    },
  );
  await httpRegistryServer.start(port.toString());
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
