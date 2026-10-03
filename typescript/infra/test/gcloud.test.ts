import { expect } from 'chai';

import { isGcpNotFoundError } from '../src/utils/gcloud.js';

describe('isGcpNotFoundError', () => {
  it('recognizes a structured GCP NOT_FOUND error through wrappers', () => {
    const gcpError = Object.assign(new Error('secret missing'), { code: 5 });
    const wrapped = new Error('Error fetching GCP secret', {
      cause: gcpError,
    });

    expect(isGcpNotFoundError(wrapped)).to.equal(true);
  });

  it('does not classify malformed JSON containing not found as missing', () => {
    let parseError: unknown;
    try {
      JSON.parse('not found');
    } catch (error: unknown) {
      parseError = error;
    }

    expect(isGcpNotFoundError(parseError)).to.equal(false);
  });

  it('does not classify transient or permission errors by message text', () => {
    expect(
      isGcpNotFoundError(new Error('getaddrinfo ENOTFOUND secretmanager')),
    ).to.equal(false);
    expect(
      isGcpNotFoundError(
        Object.assign(new Error('PERMISSION_DENIED: resource not found'), {
          code: 7,
        }),
      ),
    ).to.equal(false);
  });
});
