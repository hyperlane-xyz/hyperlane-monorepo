import { expect } from 'chai';

import { isPublicIp, validateResolvedAddresses } from './s3.js';
import { parseS3StorageLocation } from './validator.js';

describe('S3 validator storage locations', () => {
  it('preserves question marks in legacy folder names', () => {
    const config = parseS3StorageLocation(
      's3://test-bucket/us-east-1/releases?candidate',
    );

    expect(config).to.deep.equal({
      bucket: 'test-bucket',
      region: 'us-east-1',
      folder: 'releases?candidate',
      caching: true,
    });
  });

  it('parses versioned custom endpoints and encoded folders', () => {
    const config = parseS3StorageLocation(
      's3+custom://test-bucket/nyc3/releases%3Fcandidate?endpoint=https%3A%2F%2Fnyc3.digitaloceanspaces.com&forcePathStyle=true',
    );

    expect(config).to.deep.equal({
      bucket: 'test-bucket',
      region: 'nyc3',
      folder: 'releases?candidate',
      caching: true,
      endpoint: 'https://nyc3.digitaloceanspaces.com',
      forcePathStyle: true,
      endpointIsAnnounced: true,
    });
  });

  it('rejects private endpoint addresses from any DNS answer', () => {
    expect(isPublicIp('8.8.8.8')).to.be.true;
    expect(isPublicIp('127.0.0.1')).to.be.false;
    expect(() =>
      validateResolvedAddresses('s3.example.com', [
        '8.8.8.8',
        '169.254.169.254',
      ]),
    ).to.throw('169.254.169.254');
    expect(() =>
      parseS3StorageLocation(
        's3+custom://test-bucket/us-east-1?endpoint=http%3A%2F%2F127.0.0.1%3A9000',
      ),
    ).to.throw('local or private IP address');
  });
});
