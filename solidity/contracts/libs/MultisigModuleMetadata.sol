// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 * [   0:  32] Merkle root
 * [  32:  64] Root index
 * [  64:  96] Origin mailbox address
 * [  96:1120] Merkle proof
 * [1120:1152] Threshold
 * [1152:????] Validator signatures
 * [????:????] Validator addresses
 **/
library MultisigModuleMetadata {
    // TODO: Technically root is recoverable from the proof and the message...
    function root(bytes calldata _metadata) internal pure returns (bytes32) {
        return bytes32(_metadata[0:32]);
    }

    function index(bytes calldata _metadata) internal pure returns (uint256) {
        return uint256(bytes32(_metadata[32:64]));
    }

    function originMailbox(bytes calldata _metadata)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(_metadata[64:96]);
    }

    function proof(bytes calldata _metadata)
        internal
        pure
        returns (bytes32[32] memory)
    {
        return abi.decode(_metadata[96:1120], (bytes32[32]));
    }

    function threshold(bytes calldata _metadata)
        internal
        pure
        returns (uint256)
    {
        return uint256(bytes32(_metadata[1120:1152]));
    }

    function signatureAt(bytes calldata _metadata, uint256 _index)
        internal
        pure
        returns (bytes calldata)
    {
        uint256 _start = 1152 + (_index * 65);
        uint256 _end = _start + 65;
        return _metadata[_start:_end];
    }

    function validatorAt(bytes calldata _metadata, uint256 _index)
        internal
        pure
        returns (address)
    {
        // Validator addresses are left padded to bytes32 in order to match
        // abi.encodePacked(address[]).
        uint256 _start = 1152 +
            (threshold(_metadata)) *
            65 +
            (_index * 32) +
            12;
        uint256 _end = _start + 20;
        return address(bytes20(_metadata[_start:_end]));
    }

    function validators(bytes calldata _metadata)
        internal
        pure
        returns (bytes calldata)
    {
        uint256 _start = 1152 + (threshold(_metadata)) * 65;
        uint256 _end = _metadata.length;
        return _metadata[_start:_end];
    }
}
