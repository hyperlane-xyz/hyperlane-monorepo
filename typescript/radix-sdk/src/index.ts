import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  LTSRadixEngineToolkit,
  NetworkId,
  PrivateKey,
  SimpleTransactionBuilder,
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
          `Transaction ${intentHashTransactionId} was not committed successfully - instead it resulted in: ${statusOutput.intent_status} with description: ${statusOutput.intent_status_description}`,
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

const main = async () => {
  const account1 = await generateNewEd25519VirtualAccount(networkId);
  const account2 = await generateNewEd25519VirtualAccount(networkId);
  const knownAddresses =
    await LTSRadixEngineToolkit.Derive.knownAddresses(networkId);
  const xrd = knownAddresses.resources.xrdResource;

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
  const builder = await SimpleTransactionBuilder.new({
    networkId,
    validFromEpoch: constructionMetadata.ledger_state.epoch,
    fromAccount: account1.address,
    signerPublicKey: account1.publicKey,
  });

  // Note - by default this sets to permanently reject after 2 epochs (5-10 minutes)
  const unsignedTransaction = builder
    .transferFungible({
      toAccount: account2.address,
      resourceAddress: xrd,
      amount: 100,
    })
    .compileIntent();

  const notarySignature = account1.privateKey.signToSignature(
    unsignedTransaction.hashToNotarize,
  );

  const notarizedTransaction =
    unsignedTransaction.compileNotarized(notarySignature);

  const intentHashTransactionId = notarizedTransaction.transactionId.id;

  console.log(
    `Submitting XRD transfer from account 1 to account 2: ${intentHashTransactionId}`,
  );
  await gateway.transaction.innerClient.transactionSubmit({
    transactionSubmitRequest: {
      notarized_transaction_hex: notarizedTransaction.toHex(),
    },
  });
  await pollForCommit(gateway, intentHashTransactionId);
};

main();
