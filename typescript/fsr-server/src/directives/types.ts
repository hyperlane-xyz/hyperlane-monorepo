/**
 * Magic number prefix for directive messages.
 * This is a protocol constant used to identify valid directives.
 * Not a secret - this value is part of the public protocol specification.
 */
export const MAGIC_NUMBER =
  '0xFAF09B8DEEC3D47AB5A2F9007ED1C8AD83E602B7FDAA1C47589F370CDA6BF2E1';

/**
 * Directive types for different providers
 */
export enum DirectiveType {
  EVMLog = 0x01,
}
