import { expect } from 'chai';

import {
  getAwsIamClient,
  getAwsKmsClient,
  getAwsS3Client,
} from '../src/agents/aws/client.js';

describe('AWS clients', () => {
  it('reuses clients for the same region', () => {
    expect(getAwsIamClient('us-east-1')).to.equal(getAwsIamClient('us-east-1'));
    expect(getAwsKmsClient('us-east-1')).to.equal(getAwsKmsClient('us-east-1'));
    expect(getAwsS3Client('us-east-1')).to.equal(getAwsS3Client('us-east-1'));
  });

  it('separates clients by region', () => {
    expect(getAwsIamClient('us-east-1')).to.not.equal(
      getAwsIamClient('us-west-2'),
    );
    expect(getAwsKmsClient('us-east-1')).to.not.equal(
      getAwsKmsClient('us-west-2'),
    );
    expect(getAwsS3Client('us-east-1')).to.not.equal(
      getAwsS3Client('us-west-2'),
    );
  });
});
