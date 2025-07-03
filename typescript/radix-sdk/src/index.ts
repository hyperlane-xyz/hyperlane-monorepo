import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  LTSRadixEngineToolkit,
  ManifestBuilder,
  NetworkId,
  NotarizedTransaction,
  PrivateKey,
  RadixEngineToolkit,
  Signature,
  SignatureWithPublicKey,
  SimpleTransactionBuilder,
  TransactionBuilder,
  TransactionHeader,
  TransactionManifest,
  decimal,
  enumeration,
  expression,
  generateRandomNonce,
  u32,
} from '@radixdlt/radix-engine-toolkit';
import { getRandomValues } from 'crypto';

export async function generateSecureRandomBytes(
  count: number,
): Promise<Uint8Array> {
  const byteArray = new Uint8Array(count);
  getRandomValues(byteArray);
  return byteArray;
}

// NOTE - the below function is for example purposes only
// It is up to you to ensure that your generation of key pairs is safe for production use
async function generateEd25519PrivateKey(): Promise<PrivateKey> {
  return new PrivateKey.Ed25519(await generateSecureRandomBytes(32));
}

const networkId = NetworkId.Stokenet; // For mainnet, use NetworkId.Mainnet
const applicationName = 'Hyperlane Test';
const dashboardBase = 'https://stokenet-dashboard.radixdlt.com'; // For mainnet, use "https://dashboard.radixdlt.com"

async function generateNewEd25519VirtualAccount(networkId: number) {
  const privateKey = await generateEd25519PrivateKey();
  const publicKey = privateKey.publicKey();
  const address = await LTSRadixEngineToolkit.Derive.virtualAccountAddress(
    publicKey,
    networkId,
  );
  return {
    privateKey,
    publicKey,
    address,
    dashboardLink: `${dashboardBase}/account/${address}`,
  };
}

async function pollForCommit(
  gateway: GatewayApiClient,
  intentHashTransactionId: string,
): Promise<void> {
  const pollAttempts = 200;
  const pollDelayMs = 5000;

  for (let i = 0; i < pollAttempts; i++) {
    const statusOutput =
      await gateway.transaction.innerClient.transactionStatus({
        transactionStatusRequest: { intent_hash: intentHashTransactionId },
      });
    switch (statusOutput.intent_status) {
      case 'CommittedSuccess':
        console.info(
          `Transaction ${intentHashTransactionId} was committed successfully: ${dashboardBase}/transaction/${intentHashTransactionId}`,
        );
        return;
      case 'CommittedFailure':
        // You will typically wish to build a new transaction and try again.
        throw new Error(
          `Transaction ${intentHashTransactionId} was not committed successfully - instead it resulted in: ${statusOutput.intent_status} with description: ${statusOutput.error_message}`,
        );
      case 'CommitPendingOutcomeUnknown':
        // We keep polling
        if (i < pollAttempts) {
          console.debug(
            `Transaction ${intentHashTransactionId} [status poll ${
              i + 1
            }/${pollAttempts} - retrying in ${pollDelayMs}ms] - STATUS: ${
              statusOutput.intent_status
            } DESCRIPTION: ${statusOutput.intent_status_description}`,
          );
          await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
        } else {
          throw new Error(
            `Transaction ${intentHashTransactionId} was not committed successfully within ${pollAttempts} poll attempts over ${
              pollAttempts * pollDelayMs
            }ms - instead it resulted in STATUS: ${
              statusOutput.intent_status
            } DESCRIPTION: ${statusOutput.intent_status_description}`,
          );
        }
    }
  }
}

async function getTestnetXrd(
  gateway: GatewayApiClient,
  accountAddress: string,
): Promise<string> {
  const constructionMetadata =
    await gateway.transaction.innerClient.transactionConstruction();

  const freeXrdForAccountTransaction =
    await SimpleTransactionBuilder.freeXrdFromFaucet({
      networkId,
      toAccount: accountAddress,
      validFromEpoch: constructionMetadata.ledger_state.epoch,
    });

  const intentHashTransactionId = freeXrdForAccountTransaction.transactionId.id;

  await gateway.transaction.innerClient.transactionSubmit({
    transactionSubmitRequest: {
      notarized_transaction_hex: freeXrdForAccountTransaction.toHex(),
    },
  });
  await pollForCommit(gateway, intentHashTransactionId);

  return intentHashTransactionId;
}

// @ts-ignore
const main = async () => {
  const account1 = await generateNewEd25519VirtualAccount(networkId);
  const account2 = await generateNewEd25519VirtualAccount(networkId);
  // const knownAddresses =
  //   await LTSRadixEngineToolkit.Derive.knownAddresses(networkId);
  // const xrd = knownAddresses.resources.xrdResource;

  console.log(`Account 1: ${account1.dashboardLink}`);
  console.log(`Account 2: ${account2.dashboardLink}`);

  const gateway = GatewayApiClient.initialize({
    applicationName,
    networkId,
  });

  // NOTE - The faucet is empty on mainnet
  const faucetIntentHashTransactionId = await getTestnetXrd(
    gateway,
    account1.address,
  );

  console.log(
    `Account 1 has been topped up with 10000 Testnet XRD: ${dashboardBase}/transaction/${faucetIntentHashTransactionId}`,
  );

  const constructionMetadata =
    await gateway.transaction.innerClient.transactionConstruction();

  const transactionHeader: TransactionHeader = {
    networkId,
    startEpochInclusive: constructionMetadata.ledger_state.epoch,
    endEpochExclusive: constructionMetadata.ledger_state.epoch + 2,
    nonce: generateRandomNonce(),
    notaryPublicKey: account1.publicKey,
    notaryIsSignatory: true,
    tipPercentage: 0,
  };

  const transactionManifest: TransactionManifest = new ManifestBuilder()
    .callMethod(
      'component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh',
      'lock_fee',
      [decimal(5000)],
    )
    .callFunction(
      'package_tdx_2_1p5p5p5xsp0gde442jpyw4renphj7thkg0esulfsyl806nqc309gvp4',
      'Mailbox',
      'mailbox_instantiate',
      [u32(75898670)],
    )
    .callMethod(account1.address, 'try_deposit_batch_or_refund', [
      expression('EntireWorktop'),
      enumeration(0),
    ])
    .build();

  const signIntent = (hashToSign: Uint8Array): SignatureWithPublicKey => {
    return account1.privateKey.signToSignatureWithPublicKey(hashToSign);
  };

  const notarizeIntent = (hashToSign: Uint8Array): Signature => {
    return account1.privateKey.signToSignature(hashToSign);
  };

  const transaction: NotarizedTransaction = await TransactionBuilder.new().then(
    (builder) =>
      builder
        .header(transactionHeader)
        .manifest(transactionManifest)
        .sign(signIntent)
        .notarize(notarizeIntent),
  );

  const compiledNotarizedTransaction =
    await RadixEngineToolkit.NotarizedTransaction.compile(transaction);

  const intentHashTransactionId =
    await RadixEngineToolkit.NotarizedTransaction.intentHash(transaction);

  console.log(
    `Submitting create mailbox transaction: ${intentHashTransactionId.id}`,
  );
  await gateway.transaction.innerClient.transactionSubmit({
    transactionSubmitRequest: {
      notarized_transaction_hex: Buffer.from(
        compiledNotarizedTransaction,
      ).toString('hex'),
    },
  });
  await pollForCommit(gateway, intentHashTransactionId.id);

  const transactionReceipt =
    await gateway.transaction.innerClient.transactionCommittedDetails({
      transactionCommittedDetailsRequest: {
        intent_hash: intentHashTransactionId.id,
      },
    });
  console.log(transactionReceipt);
};

// retrieve newly created mailbox id after init
// @ts-ignore
const getTransactionDetails = async () => {
  const gateway = GatewayApiClient.initialize({
    applicationName,
    networkId,
  });

  const transactionReceipt = await gateway.transaction.getCommittedDetails(
    'txid_tdx_2_1wf3z84nvnpltuv6uar7y3phcz7k4qqn74n2chgc9mzfnlzkh256s047a6g',
  );
  const mailbox = (
    transactionReceipt.transaction.receipt?.state_updates as any
  ).new_global_entities.find(
    (entity: any) => entity.entity_type === 'GlobalGenericComponent',
  ).entity_address;

  console.log(mailbox);
};

// @ts-ignore
const getMailboxState = async () => {
  const gateway = GatewayApiClient.initialize({
    applicationName,
    networkId,
  });

  const transactionReceipt = await gateway.state.innerClient.stateEntityDetails(
    {
      stateEntityDetailsRequest: {
        addresses: [
          'component_tdx_2_1cr4cc66g9prezvyw9vhznsx4wm0admw6a2q4mxewfvpzx09mp049wc',
        ],
      },
    },
  );

  console.log((transactionReceipt.items[0].details as any).state.fields);
};

// main();
// getTransactionDetails();
getMailboxState();
