// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 **/
library MultisigIsmMetadata {
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

    function proof(bytes calldata _metadata, uint8 _index)
        internal
        pure
        returns (bytes32)
    {
        uint256 _start = 96 + _index * 32;
        uint256 _end = _start + 32;
        return bytes32(_metadata[_start:_end]);
    }

    function signatureCount(bytes calldata _signatures)
        internal
        pure
        returns (uint8)
    {
        return uint8(bytes1(_signatures[1120:1121]));
    }

    function signatureAt(bytes calldata _signatures, uint8 _index)
        internal
        pure
        returns (bytes calldata)
    {
        return _signatures[_index + 1:(65 * _index) + 1121];
    }
}
