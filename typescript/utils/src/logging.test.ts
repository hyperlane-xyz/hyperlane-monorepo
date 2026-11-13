import { expect } from 'chai';
import { BigNumber } from 'ethers';

import {
  REDACTED_HOST,
  REDACTED_URL,
  ethersBigNumberSerializer,
  redactErrorMessage,
  redactErrorStack,
  redactSecrets,
} from './logging.js';

describe('Logging Utilities', () => {
  describe('ethersBigNumberSerializer', () => {
    it('should serialize a BigNumber object correctly', () => {
      const key = 'testKey';
      const value = {
        type: 'BigNumber',
        hex: '0x1a',
      };
      const result = ethersBigNumberSerializer(key, value);
      expect(result).to.equal(BigNumber.from(value.hex).toString());
    });

    it('should return the value unchanged if it is not a BigNumber', () => {
      const key = 'testKey';
      const value = { some: 'object' };
      const result = ethersBigNumberSerializer(key, value);
      expect(result).to.equal(value);
    });

    it('should return the value unchanged if it is null', () => {
      const key = 'testKey';
      const value = null;
      const result = ethersBigNumberSerializer(key, value);
      expect(result).to.equal(value);
    });

    it('should return the value unchanged if it is not an object', () => {
      const key = 'testKey';
      const value = 'string';
      const result = ethersBigNumberSerializer(key, value);
      expect(result).to.equal(value);
    });
  });

  describe('secret redaction', () => {
    const SECRET_HOST = 'secret-host.invalid';
    const SECRET_PATH = 'apikey-SECRET123';
    const ethersMessage =
      'missing response (requestBody="{\\"method\\":\\"eth_call\\"}", requestMethod="POST", ' +
      `serverError={"errno":-3008,"code":"ENOTFOUND","syscall":"getaddrinfo","hostname":"${SECRET_HOST}"}, ` +
      `url="https://${SECRET_HOST}/${SECRET_PATH}", code=SERVER_ERROR, version=web/5.8.0)`;
    const redactedEthersMessage =
      'missing response (requestBody="{\\"method\\":\\"eth_call\\"}", requestMethod="POST", ' +
      `serverError={"errno":-3008,"code":"ENOTFOUND","syscall":"getaddrinfo","hostname":"${REDACTED_HOST}"}, ` +
      `url="${REDACTED_URL}", code=SERVER_ERROR, version=web/5.8.0)`;

    interface Case {
      name: string;
      input: string;
      expected: string;
    }
    const cases: Case[] = [
      {
        name: 'redacts the url and hostname of an ethers server error',
        input: ethersMessage,
        expected: redactedEthersMessage,
      },
      {
        name: 'redacts websocket and credentialed urls',
        input: `connect failed wss://user:pw@${SECRET_HOST}:8546/${SECRET_PATH}?key=1 and http://${SECRET_HOST}`,
        expected: `connect failed ${REDACTED_URL} and ${REDACTED_URL}`,
      },
      {
        name: 'redacts assigned hostnames',
        input: `getaddrinfo ENOTFOUND hostname=${SECRET_HOST}, code=X`,
        expected: `getaddrinfo ENOTFOUND hostname=${REDACTED_HOST}, code=X`,
      },
      {
        name: 'keeps messages without secrets unchanged',
        input: `call revert exception (method="defaultHook()", data="0x", code=CALL_EXCEPTION)`,
        expected: `call revert exception (method="defaultHook()", data="0x", code=CALL_EXCEPTION)`,
      },
    ];
    for (const c of cases) {
      it(c.name, () => {
        expect(redactSecrets(c.input)).to.equal(c.expected);
      });
    }

    it('redacts the message of errors and non-Error values', () => {
      expect(redactErrorMessage(new Error(ethersMessage))).to.equal(
        redactedEthersMessage,
      );
      expect(
        redactErrorMessage({ message: `bad https://${SECRET_HOST}/k` }),
      ).to.equal(`bad ${REDACTED_URL}`);
      expect(redactErrorMessage(`plain https://${SECRET_HOST}/k`)).to.equal(
        `plain ${REDACTED_URL}`,
      );
    });

    interface StackCase {
      name: string;
      error: unknown;
      expected: string | undefined;
    }
    const frames =
      '    at read (file:///app/dist/read.js:12:3)\n' +
      '    at async node:internal/process/task_queues:95:5';
    const withStack = (message: string, stack: string): Error => {
      const error = new Error(message);
      error.stack = stack;
      return error;
    };
    const withoutStack = new Error(ethersMessage);
    delete withoutStack.stack;
    const stackCases: StackCase[] = [
      {
        name: 'redacts the message and keeps the frames',
        error: withStack(ethersMessage, `Error: ${ethersMessage}\n${frames}`),
        expected: `Error: ${redactedEthersMessage}\n${frames}`,
      },
      {
        name: 'keeps a stack with an empty message',
        error: withStack('', `Error\n${frames}`),
        expected: `Error\n${frames}`,
      },
      {
        name: 'redacts a multi-line message and keeps the frames',
        error: withStack(
          `first https://${SECRET_HOST}/${SECRET_PATH}\nsecond`,
          `Error: first https://${SECRET_HOST}/${SECRET_PATH}\nsecond\n${frames}`,
        ),
        expected: `Error: first ${REDACTED_URL}\nsecond\n${frames}`,
      },
      {
        name: 'keeps a stack whose message has no secrets and appears in the frames',
        error: withStack('read', `Error: read\n${frames}`),
        expected: `Error: read\n${frames}`,
      },
      {
        name: 'redacts the whole stack when it does not contain the message',
        error: withStack('other', `Error: ${ethersMessage}\n${frames}`),
        expected:
          `Error: ${redactedEthersMessage}\n` +
          `    at read (${REDACTED_URL})\n` +
          '    at async node:internal/process/task_queues:95:5',
      },
      {
        name: 'returns undefined for an error without a stack',
        error: withoutStack,
        expected: undefined,
      },
      {
        name: 'returns undefined for non-Error values',
        error: { message: ethersMessage, stack: ethersMessage },
        expected: undefined,
      },
    ];
    for (const c of stackCases) {
      it(`redactErrorStack ${c.name}`, () => {
        expect(redactErrorStack(c.error)).to.equal(c.expected);
      });
    }
  });
});
