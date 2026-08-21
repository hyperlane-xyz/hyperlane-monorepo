// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

/**
 * @title RequestLib
 * @notice Encodes Wormhole Executor execution requests.
 * @dev Mirrors `wormhole-sdk/libraries/Executor.sol` from Wormhole Solidity SDK
 * v1.1.0. A v1 VAA request identifies the publication to deliver by its
 * `(emitter chain, emitter address, sequence)` locator.
 */
library RequestLib {
    /// @notice Request type tag for a multisig-attested v1 VAA.
    bytes4 internal constant REQUEST_TYPE_VAA_V1 = "ERV1";

    function encodeVaaMultiSigRequest(
        uint16 emitterChainId,
        bytes32 emitterAddress,
        uint64 sequence
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                REQUEST_TYPE_VAA_V1,
                emitterChainId,
                emitterAddress,
                sequence
            );
    }
}

/**
 * @title RelayInstructionLib
 * @notice Encodes Wormhole Executor relay instructions.
 * @dev Mirrors `wormhole-sdk/libraries/RelayInstructions.sol` from Wormhole
 * Solidity SDK v1.1.0.
 */
library RelayInstructionLib {
    /// @notice Instruction tag requesting destination gas and value.
    uint8 internal constant GAS_INSTRUCTION = 1;

    function encodeGas(
        uint128 gasLimit,
        uint128 msgValue
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(GAS_INSTRUCTION, gasLimit, msgValue);
    }
}
