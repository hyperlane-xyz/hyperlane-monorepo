import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
// eslint-disable-next-line import/no-nodejs-modules
import { lookup } from 'dns/promises';
// eslint-disable-next-line import/no-nodejs-modules
import { Agent as HttpAgent } from 'http';
// eslint-disable-next-line import/no-nodejs-modules
import { Agent as HttpsAgent } from 'https';
// eslint-disable-next-line import/no-nodejs-modules
import { BlockList, isIP, type LookupFunction } from 'net';
// FIXME: Is this used in the browser?
// eslint-disable-next-line import/no-nodejs-modules
import { Readable } from 'stream';

import { streamToString } from '@hyperlane-xyz/utils';

export const S3_BUCKET_REGEX =
  /^(?:https?:\/\/)?(.*)\.s3\.(.*)\.amazonaws.com\/?$/;

export interface S3Receipt<T = unknown> {
  data: T;
  modified: Date;
}

export interface S3Config {
  bucket: string;
  region: string;
  folder?: string;
  caching?: boolean;
  endpoint?: string;
  forcePathStyle?: boolean;
  endpointIsAnnounced?: boolean;
}

const blockedIpv4 = new BlockList();
const blockedIpv4Ranges: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
];
for (const [network, prefix] of blockedIpv4Ranges) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4');
}

const publicIpv6 = new BlockList();
publicIpv6.addSubnet('2000::', 3, 'ipv6');
const blockedIpv6 = new BlockList();
const blockedIpv6Ranges: ReadonlyArray<readonly [string, number]> = [
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
];
for (const [network, prefix] of blockedIpv6Ranges) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6');
}

export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !blockedIpv4.check(address, 'ipv4');
  }
  if (family === 6) {
    return (
      publicIpv6.check(address, 'ipv6') && !blockedIpv6.check(address, 'ipv6')
    );
  }
  return false;
}

export function validateAnnouncedS3Endpoint(endpoint: string): void {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Announced S3 endpoint must use http or https (${endpoint})`,
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `Announced S3 endpoint must not contain credentials, a path, query, or fragment (${endpoint})`,
    );
  }

  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const family = isIP(hostname);
  if (family !== 0 && !isPublicIp(hostname)) {
    throw new Error(
      `Announced S3 endpoint must not target a local or private IP address (${endpoint})`,
    );
  }
  if (
    family === 0 &&
    (!hostname.includes('.') ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal'))
  ) {
    throw new Error(
      `Announced S3 endpoint must not target a local hostname (${endpoint})`,
    );
  }
}

export function validateResolvedAddresses(
  hostname: string,
  addresses: readonly string[],
): void {
  const blockedAddress = addresses.find((address) => !isPublicIp(address));
  if (addresses.length === 0 || blockedAddress) {
    throw Object.assign(
      new Error(
        `Announced S3 endpoint ${hostname} resolved to ${
          blockedAddress ?? 'no addresses'
        }`,
      ),
      { code: 'EACCES' },
    );
  }
}

const publicDnsLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, {
    all: true,
    family: options.family,
    hints: options.hints,
    verbatim: options.verbatim,
  }).then(
    (addresses) => {
      try {
        validateResolvedAddresses(
          hostname,
          addresses.map(({ address }) => address),
        );
        if (options.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      } catch (error) {
        callback(
          error instanceof Error
            ? Object.assign(error, { code: 'EACCES' })
            : Object.assign(new Error(String(error)), { code: 'EACCES' }),
          '',
        );
      }
    },
    (error: NodeJS.ErrnoException) => callback(error, ''),
  );
};

export class S3Wrapper {
  private readonly client: S3Client;

  private cache: Record<string, S3Receipt<any>> | undefined;

  static fromBucketUrl(bucketUrl: string): S3Wrapper {
    const match = bucketUrl.match(S3_BUCKET_REGEX);
    if (!match) throw new Error('Could not parse bucket url');
    return new S3Wrapper({
      bucket: match[1],
      region: match[2],
      caching: true,
    });
  }

  constructor(readonly config: S3Config) {
    const {
      caching: _caching,
      endpointIsAnnounced,
      folder: _folder,
      ...clientConfig
    } = config;
    this.client = new S3Client({
      ...clientConfig,
      // explicitly set empty credentials to allow usage without env vars
      credentials: {
        accessKeyId: '',
        secretAccessKey: '',
      },
      signer: { sign: async (req) => req },
      ...(endpointIsAnnounced
        ? {
            requestHandler: new NodeHttpHandler({
              httpAgent: new HttpAgent({ lookup: publicDnsLookup }),
              httpsAgent: new HttpsAgent({ lookup: publicDnsLookup }),
            }),
          }
        : {}),
    });
    if (config.caching) {
      this.cache = {};
    }
  }

  formatKey(key: string): string {
    return this.config.folder ? `${this.config.folder}/${key}` : key;
  }

  async getS3Obj<T>(key: string): Promise<S3Receipt<T> | undefined> {
    const Key = this.formatKey(key);
    if (this.cache?.[Key]) {
      return this.cache![Key];
    }

    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key,
    });
    try {
      const response = await this.client.send(command);
      const body: string = await streamToString(response.Body as Readable);
      const result = {
        data: JSON.parse(body),
        modified: response.LastModified!,
      };
      if (this.cache) {
        this.cache[Key] = result;
      }
      return result;
    } catch (e: any) {
      if (e.message.includes('The specified key does not exist.')) {
        return;
      }
      throw e;
    }
  }

  url(key: string): string {
    const Key = this.formatKey(key);
    if (this.config.endpoint) {
      const endpoint = new URL(this.config.endpoint);
      if (this.config.forcePathStyle) {
        return `${endpoint.href.replace(/\/$/, '')}/${this.config.bucket}/${Key}`;
      }
      endpoint.hostname = `${this.config.bucket}.${endpoint.hostname}`;
      endpoint.pathname = Key;
      return endpoint.href;
    }
    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${Key}`;
  }
}
