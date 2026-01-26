import { EthJsonRpcBlockParameterTag } from '../../metadata/chainMetadataTypes.js';

export function buildBlockTagOverrides(
  blockTag?: number | EthJsonRpcBlockParameterTag,
) {
  return blockTag !== undefined ? { blockTag } : {};
}
