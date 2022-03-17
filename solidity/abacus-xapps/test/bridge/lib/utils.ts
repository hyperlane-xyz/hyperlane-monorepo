import { assert } from 'chai';
import { ethers } from 'ethers';

import * as types from './types';

// Formats Transfer Message
export function formatTransfer(
  to: ethers.BytesLike,
  amnt: number | ethers.BytesLike,
): ethers.BytesLike {
  return ethers.utils.solidityPack(
    ['bytes1', 'bytes32', 'uint256'],
    [types.BridgeMessageTypes.TRANSFER, to, amnt],
  );
}

// Formats Details Message
export function formatDetails(
  name: string,
  symbol: string,
  decimals: number,
): ethers.BytesLike {
  return ethers.utils.solidityPack(
    ['bytes1', 'bytes32', 'bytes32', 'uint8'],
    [types.BridgeMessageTypes.DETAILS, name, symbol, decimals],
  );
}

// Formats Request Details message
export function formatRequestDetails(): ethers.BytesLike {
  return ethers.utils.solidityPack(
    ['bytes1'],
    [types.BridgeMessageTypes.REQUEST_DETAILS],
  );
}

// Formats the Token ID
export function formatTokenId(domain: number, id: string): ethers.BytesLike {
  return ethers.utils.solidityPack(['uint32', 'bytes32'], [domain, id]);
}

export function formatMessage(
  tokenId: ethers.BytesLike,
  action: ethers.BytesLike,
): ethers.BytesLike {
  return ethers.utils.solidityPack(['bytes', 'bytes'], [tokenId, action]);
}

export function serializeTransferAction(
  transferAction: types.TransferAction,
): ethers.BytesLike {
  const { type, recipient, amount } = transferAction;

  assert(type === types.BridgeMessageTypes.TRANSFER);
  return formatTransfer(recipient, amount);
}

export function serializeDetailsAction(
  detailsAction: types.DetailsAction,
): ethers.BytesLike {
  const { type, name, symbol, decimals } = detailsAction;

  assert(type === types.BridgeMessageTypes.DETAILS);
  return formatDetails(name, symbol, decimals);
}

export function serializeRequestDetailsAction(
  requestDetailsAction: types.RequestDetailsAction,
): ethers.BytesLike {
  assert(
    requestDetailsAction.type === types.BridgeMessageTypes.REQUEST_DETAILS,
  );
  return formatRequestDetails();
}

export function serializeAction(action: types.Action): ethers.BytesLike {
  let actionBytes: ethers.BytesLike = [];
  switch (action.type) {
    case types.BridgeMessageTypes.TRANSFER: {
      actionBytes = serializeTransferAction(action as types.TransferAction);
      break;
    }
    case types.BridgeMessageTypes.DETAILS: {
      actionBytes = serializeDetailsAction(action as types.DetailsAction);
      break;
    }
    case types.BridgeMessageTypes.REQUEST_DETAILS: {
      actionBytes = serializeRequestDetailsAction(action);
      break;
    }
    default: {
      console.error('Invalid action');
      break;
    }
  }
  return actionBytes;
}

export function serializeTokenId(
  tokenId: types.TokenIdentifier,
): ethers.BytesLike {
  if (typeof tokenId.domain !== 'number' || typeof tokenId.id !== 'string') {
    throw new Error('!types');
  }
  return formatTokenId(tokenId.domain as number, tokenId.id as string);
}

export function serializeMessage(message: types.Message): ethers.BytesLike {
  const tokenId = serializeTokenId(message.tokenId);
  const action = serializeAction(message.action);
  return formatMessage(tokenId, action);
}
