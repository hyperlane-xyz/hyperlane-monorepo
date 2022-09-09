// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 **/
library EcdsaSignatureList {
    function signatureCount(bytes calldata _signatures)
        internal
        pure
        returns (uint8)
    {
        return uint8(bytes1(_signatures[0:1]));
    }

    function signatureAt(bytes calldata _signatures, uint8 _index)
        internal
        pure
        returns (bytes calldata)
    {
        return _signatures[_index + 1:(65 * _index) + 1];
    }
}
