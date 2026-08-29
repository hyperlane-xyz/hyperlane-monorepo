import {
  SignerAccountResponseSchema,
  SignerTransactionResponseSchema,
  SignerTypedDataResponseSchema,
  type Eip712Payload,
  type SignerAccountResponse,
  type EncodedBytes,
} from '@hyperlane-xyz/http-registry-server';
import { errorToString, strip0x } from '@hyperlane-xyz/utils';

const DEFAULT_HTTP_SIGNER_TIMEOUT_MS = 30_000;
const MAX_HTTP_SIGNER_RESPONSE_BYTES = 256 * 1024;

export class HttpSignerClient {
  private readonly token: string;
  private readonly accountRequests = new Map<
    string,
    Promise<SignerAccountResponse>
  >();

  constructor(
    private readonly baseUrl: URL,
    token = process.env.HYP_HTTP_SIGNER_TOKEN,
    private readonly timeoutMs = DEFAULT_HTTP_SIGNER_TIMEOUT_MS,
  ) {
    if (!token) {
      throw new Error(
        'HYP_HTTP_SIGNER_TOKEN is required when using an HTTP signer',
      );
    }
    this.token = token;
  }

  getAccount(chain: string): Promise<SignerAccountResponse> {
    const cached = this.accountRequests.get(chain);
    if (cached) return cached;

    const request = this.request(
      'account discovery',
      chain,
      `/signer/account/${encodeURIComponent(chain)}`,
      undefined,
      SignerAccountResponseSchema,
    ).catch((error) => {
      this.accountRequests.delete(chain);
      throw error;
    });
    this.accountRequests.set(chain, request);
    return request;
  }

  async signTransaction(chain: string, unsignedTransaction: string) {
    return this.signEncodedTransaction(chain, {
      encoding: 'hex',
      value: strip0x(unsignedTransaction),
    });
  }

  async signEncodedTransaction(chain: string, transaction: EncodedBytes) {
    return this.request(
      'transaction signing',
      chain,
      '/signer/transaction',
      {
        chain,
        transaction,
      },
      SignerTransactionResponseSchema,
    );
  }

  async signTypedData(chain: string, typedData: Eip712Payload) {
    return this.request(
      'typed-data signing',
      chain,
      '/signer/typed-data',
      { chain, typedData },
      SignerTypedDataResponseSchema,
    );
  }

  private async request<T>(
    operation: string,
    chain: string,
    path: string,
    body: object | undefined,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const detail = errorToString(error);
      throw new Error(
        `HTTP signer ${operation} failed for ${chain}: ${detail}`,
        { cause: error },
      );
    }

    const responseBody = await this.readJson(response, operation, chain);
    if (!response.ok) {
      const message =
        typeof responseBody === 'object' &&
        responseBody !== null &&
        'message' in responseBody &&
        typeof responseBody.message === 'string'
          ? responseBody.message
          : response.statusText;
      throw new Error(
        `HTTP signer ${operation} failed for ${chain} (${response.status}): ${message}`,
      );
    }

    try {
      return schema.parse(responseBody);
    } catch (error) {
      throw new Error(
        `HTTP signer returned an invalid ${operation} response for ${chain}`,
        { cause: error },
      );
    }
  }

  private async readJson(
    response: Response,
    operation: string,
    chain: string,
  ): Promise<unknown> {
    const contentLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_HTTP_SIGNER_RESPONSE_BYTES
    ) {
      await response.body?.cancel();
      throw new Error(
        `HTTP signer ${operation} response for ${chain} exceeds ${MAX_HTTP_SIGNER_RESPONSE_BYTES} bytes`,
      );
    }

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    if (reader) {
      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          throw new Error(
            `Failed to read HTTP signer ${operation} response for ${chain} (${response.status})`,
            { cause: error },
          );
        }
        if (result.done) break;
        totalBytes += result.value.byteLength;
        if (totalBytes > MAX_HTTP_SIGNER_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error(
            `HTTP signer ${operation} response for ${chain} exceeds ${MAX_HTTP_SIGNER_RESPONSE_BYTES} bytes`,
          );
        }
        chunks.push(result.value);
      }
    }

    const responseBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      responseBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      return JSON.parse(new TextDecoder().decode(responseBytes));
    } catch (error) {
      throw new Error(
        `HTTP signer returned a non-JSON ${operation} response for ${chain} (${response.status})`,
        { cause: error },
      );
    }
  }
}
