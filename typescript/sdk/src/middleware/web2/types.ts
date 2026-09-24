import { BytesLike } from 'ethers';

export enum HttpMethod {
  GET = 0,
  POST = 1,
  PUT = 2,
  DELETE = 3,
  PATCH = 4,
  HEAD = 5,
}

export enum MessageType {
  REQUEST = 0,
  RESPONSE = 1,
}

export interface Web2RequestParams {
  targetDomain: number;
  method: HttpMethod;
  url: string;
  headers: string;
  body: BytesLike;
  callbackAddress: string;
  callbackData: BytesLike;
}

export interface Web2Request {
  requestId: string;
  sender: string;
  method: HttpMethod;
  url: string;
  headers: string;
  body: string;
  callbackAddress: string;
  callbackData: string;
}

export interface Web2Response {
  requestId: string;
  callbackAddress: string;
  statusCode: number;
  headers: string;
  responseBody: string;
  callbackData: string;
}

export interface Web2IsmMetadataConfig {
  endpointHash: string;
  timestamp: number;
  requestId: string;
  signatures: string[];
}

export interface Web2KeeperConfig {
  originDomain: number;
  web2Domain: number;
  routerAddress: string;
  mailboxAddress: string;
  ismAddress?: string;
  privateKeys: string[];
  maxAttestationAge?: number;
  requestTimeoutMs?: number;
}
