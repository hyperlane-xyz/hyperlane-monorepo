// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title IWormholeVaaService
 * @notice EIP-3668 lookup ABI implemented by the CCIP-read Wormhole VAA
 * service.
 * @dev The service is untrusted transport. Its response is verified by
 * destination Wormhole Core inside `WormholeVaaHookIsm.verify`.
 */
interface IWormholeVaaService {
    function getWormholeVaa(
        bytes calldata hyperlaneMessage
    ) external view returns (bytes memory encodedVaa);
}
