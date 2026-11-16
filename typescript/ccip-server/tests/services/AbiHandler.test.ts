import { expect } from 'chai';

import { VaaPendingError } from '../../src/services/WormholeVaaFetcher.js';
import {
  AttestationPendingError,
  CommitmentAccessDeniedError,
} from '../../src/utils/errors.js';
import { RpcUnavailableError } from '../../src/utils/rpcErrors.js';
import { respondWithAbiError } from '../utils/abiHandler.js';

const SECRET_HOST = 'secret-host.invalid';
const SECRET_PATH = 'apikey-SECRET123';
const ETHERS_SERVER_ERROR =
  'missing response (requestBody="{\\"method\\":\\"eth_call\\"}", requestMethod="POST", ' +
  `serverError={"errno":-3008,"code":"ENOTFOUND","syscall":"getaddrinfo","hostname":"${SECRET_HOST}"}, ` +
  `url="https://${SECRET_HOST}/${SECRET_PATH}", code=SERVER_ERROR, version=web/5.8.0)`;
const VAA_ID = `2/${'00'.repeat(32)}/7`;

describe('ABI handler error responses', () => {
  interface Case {
    name: string;
    error: Error;
    statusCode: number;
    body: { error: string };
  }
  const cases: Case[] = [
    {
      name: 'returns a fixed body for an unavailable RPC',
      error: new RpcUnavailableError(new Error(ETHERS_SERVER_ERROR)),
      statusCode: 500,
      body: { error: 'Internal server error' },
    },
    {
      name: 'returns a fixed body for an ordinary error',
      error: new Error(`call to https://${SECRET_HOST}/${SECRET_PATH} failed`),
      statusCode: 500,
      body: { error: 'Internal server error' },
    },
    {
      name: 'returns the message of a pending CCTP attestation',
      error: new AttestationPendingError(),
      statusCode: 500,
      body: { error: 'CCTP attestation is pending' },
    },
    {
      name: 'returns the message of a pending Wormhole VAA',
      error: new VaaPendingError(VAA_ID),
      statusCode: 500,
      body: { error: `VAA ${VAA_ID} is pending Guardian signatures` },
    },
    {
      name: 'returns the message of a denied commitment read',
      error: new CommitmentAccessDeniedError(),
      statusCode: 403,
      body: { error: 'Signer not authorized for this commitment' },
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const { response, lines } = await respondWithAbiError(c.error, 'debug');
      expect(response.statusCode).to.equal(c.statusCode);
      expect(response.json()).to.deep.equal(c.body);
      for (const text of [response.body, ...lines]) {
        expect(text).to.not.include(SECRET_HOST);
        expect(text).to.not.include(SECRET_PATH);
      }
    });
  }

  it('logs the redacted RPC error with its stack frames', async () => {
    const { lines } = await respondWithAbiError(
      new RpcUnavailableError(new Error(ETHERS_SERVER_ERROR)),
    );
    const handlerErrors = lines
      .filter((line) => line.includes('Error in ABI handler'))
      .map((line): unknown => JSON.parse(line));
    expect(handlerErrors).to.have.length(1);
    const [entry] = handlerErrors;
    expect(entry).to.be.an('object');
    expect(entry).to.have.property('error').that.includes('<redacted-url>');
    expect(entry).to.have.property('error').that.includes('code=SERVER_ERROR');
    expect(entry)
      .to.have.property('error')
      .that.includes('"hostname":"<redacted-host>"');
    expect(entry).to.have.property('stack').that.includes('AbiHandler.test.ts');
  });
});
