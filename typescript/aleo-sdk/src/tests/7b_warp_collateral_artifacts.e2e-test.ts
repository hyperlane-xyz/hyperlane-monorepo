import {
  Account,
  AleoKeyProvider,
  NetworkRecordProvider,
  ProgramManager,
} from '@provablehq/sdk';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { token_registry } from '../artifacts.js';
import { AleoSigner } from '../clients/signer.js';
import {
  TEST_ALEO_BURN_ADDRESS,
  TEST_ALEO_CHAIN_METADATA,
  TEST_ALEO_PRIVATE_KEY,
} from '../testing/constants.js';
import {
  fromAleoAddress,
  getProgramSuffix,
  stringToU128,
} from '../utils/helper.js';
import { AleoWarpArtifactManager } from '../warp/warp-artifact-manager.js';

import {
  type WarpTestSuiteContext,
  warpArtifactTestSuite,
} from './warp-artifact-test-suite.js';

chai.use(chaiAsPromised);

const COLLATERAL_TOKEN_DENOM = `${Date.now()}${Math.floor(Math.random() * 1000)}field`;
const COLLATERAL_TOKEN_NAME = 'Test Token';
const COLLATERAL_TOKEN_SYMBOL = 'TEST';
const COLLATERAL_TOKEN_DECIMALS = 6;

describe('7b. Aleo Warp Collateral Token Artifact API (e2e)', function () {
  this.timeout(300_000);

  const ctx = {} as WarpTestSuiteContext;

  before(async () => {
    delete process.env['ALEO_WARP_SUFFIX'];

    const aleoSigner = (await AleoSigner.connectWithSigner(
      [TEST_ALEO_CHAIN_METADATA.rpcUrl],
      TEST_ALEO_PRIVATE_KEY,
      { metadata: { chainId: 1 } },
    )) as AleoSigner;

    ctx.aleoSigner = aleoSigner;
    ctx.providerSdkSigner = aleoSigner;

    const ismManagerProgramId = await aleoSigner.getIsmManager();

    const mailbox = await aleoSigner.createMailbox({ domainId: 1234 });
    ctx.mailboxAddress = mailbox.mailboxAddress;

    const { programId } = fromAleoAddress(ctx.mailboxAddress);
    const suffix = getProgramSuffix(programId);
    const hookManagerProgramId = await aleoSigner.getHookManager(suffix);

    const aleoClient = (aleoSigner as any).aleoClient;
    ctx.artifactManager = new AleoWarpArtifactManager(aleoClient, {
      ismManagerAddress: ismManagerProgramId,
      hookManagerAddress: hookManagerProgramId,
    });

    // Deploy token_registry for collateral tests
    const aleoAccount = new Account({
      privateKey: TEST_ALEO_PRIVATE_KEY,
    });

    const keyProvider = new AleoKeyProvider();
    keyProvider.useCache(true);

    const networkRecordProvider = new NetworkRecordProvider(
      aleoAccount,
      aleoClient,
    );

    const programManager = new ProgramManager(
      TEST_ALEO_CHAIN_METADATA.rpcUrl,
      keyProvider,
      networkRecordProvider,
    );
    programManager.setAccount(aleoAccount);

    try {
      const tx = await programManager.buildDevnodeDeploymentTransaction({
        program: token_registry,
        priorityFee: 0,
        privateFee: false,
      });
      const txId = await programManager.networkClient.submitTransaction(tx);
      await aleoClient.waitForTransactionConfirmation(txId);
    } catch (e) {
      rootLogger.warn(
        'Token registry deployment skipped:',
        (e as Error).message,
      );
    }

    // Register test token
    const registeredToken = await aleoClient.getProgramMappingValue(
      'token_registry.aleo',
      'registered_tokens',
      COLLATERAL_TOKEN_DENOM,
    );

    if (!registeredToken) {
      await aleoSigner.sendAndConfirmTransaction({
        programName: 'token_registry.aleo',
        functionName: 'register_token',
        priorityFee: 0,
        privateFee: false,
        inputs: [
          COLLATERAL_TOKEN_DENOM,
          `${stringToU128(COLLATERAL_TOKEN_NAME).toString()}u128`,
          `${stringToU128(COLLATERAL_TOKEN_SYMBOL).toString()}u128`,
          `${COLLATERAL_TOKEN_DECIMALS}u8`,
          `100000000u128`,
          `false`,
          TEST_ALEO_BURN_ADDRESS,
        ],
      });
    }
  });

  warpArtifactTestSuite(ctx, {
    type: AltVM.TokenType.collateral,
    name: 'collateral',
    getConfig: () => ({
      type: AltVM.TokenType.collateral,
      owner: ctx.aleoSigner.getSignerAddress(),
      mailbox: ctx.mailboxAddress,
      token: COLLATERAL_TOKEN_DENOM,
      remoteRouters: {},
      destinationGas: {},
    }),
    expectedFields: {
      token: COLLATERAL_TOKEN_DENOM,
      name: COLLATERAL_TOKEN_NAME,
      symbol: COLLATERAL_TOKEN_SYMBOL,
      decimals: COLLATERAL_TOKEN_DECIMALS,
    },
  });
});
