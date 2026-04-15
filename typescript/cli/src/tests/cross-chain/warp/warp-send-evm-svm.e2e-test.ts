import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { expect } from 'chai';
import { Wallet } from 'ethers';
import { type StartedTestContainer } from 'testcontainers';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import { SealevelSigner, createRpc } from '@hyperlane-xyz/sealevel-sdk';
import {
  type SolanaTestValidator,
  airdropSol,
  createSplMint,
  getPreloadedPrograms,
  runSolanaNode,
} from '@hyperlane-xyz/sealevel-sdk/testing';
import { TokenType, type WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, strip0x } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_ADDRESSES_PATH_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  CROSS_CHAIN_CORE_CONFIG_PATH_BY_PROTOCOL,
  CROSS_CHAIN_E2E_TEST_TIMEOUT,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';
import { runEvmNode } from '../../nodes.js';

const EVM_CHAIN = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
const SVM_CHAIN = TEST_CHAIN_NAMES_BY_PROTOCOL.sealevel.CHAIN_NAME_1;
const EVM_KEY = HYP_KEY_BY_PROTOCOL.ethereum;
const SVM_KEY = HYP_KEY_BY_PROTOCOL.sealevel;
const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/send-evm-svm-warp-deploy.yaml`;
const TOKEN_SYMBOL = 'SVMSEND';

function getSvmWeb3Keypair(privateKey: string): Keypair {
  const keyBytes = Buffer.from(strip0x(privateKey), 'hex');
  assert(keyBytes.length === 32, 'Expected 32-byte Sealevel test private key');
  return Keypair.fromSeed(keyBytes);
}

describe('hyperlane warp send EVM+SVM e2e tests', function () {
  this.timeout(CROSS_CHAIN_E2E_TEST_TIMEOUT);

  let evmNodeInstance: StartedTestContainer;
  let svmNodeInstance: SolanaTestValidator;
  let svmProgramCleanup: (() => void) | undefined;

  let evmCoreAddresses: ChainAddresses;
  let svmCoreAddresses: ChainAddresses;
  let svmSigner: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;

  const evmCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    EVM_CHAIN,
    REGISTRY_PATH,
    CROSS_CHAIN_CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const svmCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Sealevel,
    SVM_CHAIN,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
  );

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/send-evm-svm-warp-read.yaml`,
  );

  before(async function () {
    const { programs, cleanup } = getPreloadedPrograms([]);
    svmProgramCleanup = cleanup;

    [evmNodeInstance, svmNodeInstance] = await Promise.all([
      runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2),
      runSolanaNode(
        TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
        programs,
      ),
    ]);

    const rpcUrl = TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl;
    svmSigner = await SealevelSigner.connectWithSigner([rpcUrl], SVM_KEY);
    const svmRpc = createRpc(rpcUrl);
    await airdropSol(svmRpc, svmSigner.getSignerAddress(), 50_000_000_000n);

    const svmCoreConfig = readYamlOrJson(CORE_CONFIG_PATH_BY_PROTOCOL.sealevel);
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      svmCoreConfig,
    );
    svmCore.setCoreInputPath(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );

    [evmCoreAddresses] = await Promise.all([
      evmCore.deployOrUseExistingCore(EVM_KEY),
      svmCore.deploy(SVM_KEY),
    ]);

    svmCoreAddresses = readYamlOrJson(
      CORE_ADDRESSES_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    ) as ChainAddresses;
  });

  after(async function () {
    await Promise.all([evmNodeInstance?.stop(), svmNodeInstance?.stop()]);
    svmProgramCleanup?.();
  });

  it('should send warp tokens from SVM origin to EVM destination via CLI', async function () {
    const rpcUrl = TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl;
    const rpc = createRpc(rpcUrl);
    const svmOwner = svmSigner.getSignerAddress();
    const evmOwner = new Wallet(EVM_KEY).address;
    const collateralMint = await createSplMint(rpc, svmSigner, 9);

    await mintSplToSigner({
      rpcUrl,
      mint: collateralMint,
      owner: svmOwner,
      amount: 5_000_000_000n,
    });

    const warpId = createWarpRouteConfigId(
      TOKEN_SYMBOL,
      `${EVM_CHAIN}-${SVM_CHAIN}`,
    );
    const warpDeployConfig: WarpRouteDeployConfig = {
      [EVM_CHAIN]: {
        type: TokenType.synthetic,
        mailbox: evmCoreAddresses.mailbox,
        owner: evmOwner,
        name: 'SVM Send Token',
        symbol: TOKEN_SYMBOL,
        decimals: 9,
      },
      [SVM_CHAIN]: {
        type: TokenType.collateral,
        token: String(collateralMint),
        mailbox: svmCoreAddresses.mailbox,
        owner: svmOwner,
        name: 'SVM Send Token',
        symbol: TOKEN_SYMBOL,
        decimals: 9,
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);

    const deployOutput = await warpCommands
      .deployRaw({
        warpRouteId: warpId,
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        skipConfirmationPrompts: true,
        extraArgs: [
          `--key.${ProtocolType.Ethereum}`,
          EVM_KEY,
          `--key.${ProtocolType.Sealevel}`,
          SVM_KEY,
        ],
      })
      .stdio('pipe')
      .nothrow();

    expect(deployOutput.exitCode).to.equal(0);

    const sendOutput = await warpCommands
      .sendRaw({
        origin: SVM_CHAIN,
        destination: EVM_CHAIN,
        warpRouteId: warpId,
        amount: 1,
        quick: true,
        skipValidation: true,
        extraArgs: [
          `--key.${ProtocolType.Ethereum}`,
          EVM_KEY,
          `--key.${ProtocolType.Sealevel}`,
          SVM_KEY,
        ],
      })
      .stdio('pipe')
      .nothrow();

    expect(sendOutput.exitCode).to.equal(0);
    const outputText = sendOutput.text();
    expect(outputText).to.include('Message ID:');
    expect(outputText).to.include('Explorer Link:');
  });
});

async function mintSplToSigner({
  rpcUrl,
  mint,
  owner,
  amount,
}: {
  rpcUrl: string;
  mint: string;
  owner: string;
  amount: bigint;
}) {
  const web3Keypair = getSvmWeb3Keypair(SVM_KEY);
  const ownerPubkey = new PublicKey(owner);
  const mintPubkey = new PublicKey(mint);
  const ata = getAssociatedTokenAddressSync(mintPubkey, ownerPubkey);

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountInstruction(
      web3Keypair.publicKey,
      ata,
      ownerPubkey,
      mintPubkey,
    ),
  );
  tx.add(
    createMintToInstruction(mintPubkey, ata, web3Keypair.publicKey, amount),
  );

  const connection = new Connection(rpcUrl, 'confirmed');
  await sendAndConfirmTransaction(connection, tx, [web3Keypair]);
}
