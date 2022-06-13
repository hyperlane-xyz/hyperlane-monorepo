import { ethers } from 'ethers';
import { AwsKmsSigner } from 'ethers-aws-kms-signer';

function getEnvVar(name: string, defaultValue?: string) {
  const value = process.env[name];
  if (value === undefined) {
    if (defaultValue === undefined) {
      throw Error(`Expected env var ${name}`);
    } else {
      return defaultValue;
    }
  }
  return value;
}

async function sendUnblockingTx() {
  const rpcUrl = getEnvVar('RPC_URL');
  // This should be the same nonce of the tx that is having issues in decimal form
  const nonce = getEnvVar('NONCE');
  // This should be > 10% higher than the existing gas price
  const gasPrice = getEnvVar('GAS_PRICE');

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  // The credentials that you've set up with the `aws` CLI are used here
  const signer = new AwsKmsSigner(
    {
      keyId: getEnvVar('AWS_KEY_ID'), // Get this from the AWS console, e.g. arn:aws:kms:us-east-1:XXXXXXXXXXXX:key/XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
      region: getEnvVar('AWS_REGION', 'us-east-1'),
    },
    provider,
  );

  const signerAddress = await signer.getAddress();

  const decimalStrToHexStr = (decimalStr: string) =>
    `0x${parseInt(decimalStr, 10).toString(16)}`;

  const tx = await signer.sendTransaction({
    from: signerAddress,
    to: signerAddress,
    value: 0,
    nonce: decimalStrToHexStr(nonce),
    gasPrice: decimalStrToHexStr(gasPrice),
  });

  console.log('tx', tx);
  console.log('tx receipt', await tx.wait());
}

sendUnblockingTx().catch(console.error);
