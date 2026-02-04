import { eqAddress } from '@hyperlane-xyz/utils';

import type { MatchingList, MatchingListElement } from './matchingList.js';

/**
 * Message-like object for matching against a MatchingList.
 * All fields are optional - only fields present in the matching list element
 * will be checked.
 */
export interface MatchingListMessage {
  id?: string;
  origin?: number;
  destination?: number;
  sender?: string;
  recipient?: string;
  body?: string;
}

/**
 * Check if a message matches a matching list.
 *
 * Matching logic:
 * - Empty/undefined list = wildcard (matches all messages)
 * - Element matches if ALL specified fields match (AND logic)
 * - List matches if ANY element matches (OR logic)
 *
 * @param list The matching list to check against
 * @param message The message to check
 * @returns true if the message matches the list
 */
export function messageMatchesMatchingList(
  list: MatchingList | undefined,
  message: MatchingListMessage,
): boolean {
  // Empty/undefined list = wildcard (matches all)
  if (!list || list.length === 0) {
    return true;
  }
  // Match if ANY element matches (OR logic)
  return list.some((element) => messageMatchesElement(element, message));
}

/**
 * Check if a message matches a single matching list element.
 * ALL specified fields in the element must match (AND logic).
 */
function messageMatchesElement(
  element: MatchingListElement,
  message: MatchingListMessage,
): boolean {
  if (
    element.originDomain !== undefined &&
    !matchesDomain(element.originDomain, message.origin)
  ) {
    return false;
  }

  if (
    element.destinationDomain !== undefined &&
    !matchesDomain(element.destinationDomain, message.destination)
  ) {
    return false;
  }

  if (
    element.senderAddress !== undefined &&
    !matchesAddress(element.senderAddress, message.sender)
  ) {
    return false;
  }

  if (
    element.recipientAddress !== undefined &&
    !matchesAddress(element.recipientAddress, message.recipient)
  ) {
    return false;
  }

  if (
    element.messageId !== undefined &&
    !matchesAddress(element.messageId, message.id)
  ) {
    return false;
  }

  if (
    element.bodyRegex !== undefined &&
    !matchesBodyRegex(element.bodyRegex, message.body)
  ) {
    return false;
  }

  return true;
}

/**
 * Check if a domain value matches a domain pattern.
 * @param pattern '*' (wildcard), single domain, or array of domains
 * @param value The domain value to check
 */
function matchesDomain(
  pattern: '*' | number | number[],
  value: number | undefined,
): boolean {
  if (value === undefined) {
    return false;
  }
  if (pattern === '*') {
    return true;
  }
  if (Array.isArray(pattern)) {
    return pattern.includes(value);
  }
  return pattern === value;
}

/**
 * Check if an address/hash value matches an address pattern.
 * Uses case-insensitive comparison for hex addresses.
 * @param pattern '*' (wildcard), single address, or array of addresses
 * @param value The address value to check (can be checksummed or lowercase)
 */
function matchesAddress(
  pattern: string | string[],
  value: string | undefined,
): boolean {
  if (value === undefined) {
    return false;
  }
  if (pattern === '*') {
    return true;
  }
  if (Array.isArray(pattern)) {
    return pattern.some((p) => eqAddress(p, value));
  }
  return eqAddress(pattern, value);
}

/**
 * Check if a message body matches a regex pattern.
 * @param regex The regex pattern string
 * @param body The message body to check
 */
function matchesBodyRegex(regex: string, body: string | undefined): boolean {
  if (body === undefined) {
    return false;
  }
  try {
    const re = new RegExp(regex);
    return re.test(body);
  } catch {
    // Invalid regex - treat as no match
    return false;
  }
}
