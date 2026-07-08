import { expect } from 'chai';

import { keyPolicyWithSigner } from '../src/agents/aws/key.js';
import type { KeyPolicy } from '../src/agents/aws/key.js';

describe('keyPolicyWithSigner', () => {
  it('preserves root access and merges signer principals idempotently', () => {
    const rootPrincipal = 'arn:aws:iam::625457692493:root';
    const existingSigner =
      'arn:aws:iam::625457692493:user/fastpath-mainnet3-key-validator-ethereum-0';
    const newSigner =
      'arn:aws:iam::625457692493:user/fastpath-mainnet3-key-validator-arbitrum-0';
    const rootStatement = {
      Sid: 'Enable IAM User Permissions',
      Effect: 'Allow',
      Principal: {
        AWS: rootPrincipal,
      },
      Action: 'kms:*',
      Resource: '*',
    };
    const policy: KeyPolicy = {
      Version: '2012-10-17',
      Id: 'key-default-1',
      Statement: [
        rootStatement,
        {
          Effect: 'Allow',
          Principal: {
            AWS: existingSigner,
          },
          Action: ['kms:GetPublicKey', 'kms:Sign', 'kms:DescribeKey'],
          Resource: '*',
        },
      ],
    };
    const originalPolicy = JSON.parse(JSON.stringify(policy)) as KeyPolicy;

    const mergedPolicy = keyPolicyWithSigner(policy, newSigner);

    expect(policy).to.deep.equal(originalPolicy);
    expect(mergedPolicy.Statement[0]).to.deep.equal(rootStatement);

    const signerStatement = mergedPolicy.Statement.find(
      (statement) =>
        Array.isArray(statement.Action) &&
        statement.Action.includes('kms:Sign') &&
        statement.Principal?.AWS !== rootPrincipal,
    );

    expect(signerStatement?.Principal?.AWS).to.deep.equal(
      [existingSigner, newSigner].sort(),
    );
    expect(keyPolicyWithSigner(mergedPolicy, newSigner)).to.deep.equal(
      mergedPolicy,
    );
  });
});
