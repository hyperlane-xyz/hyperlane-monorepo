// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {IMultisigIsm} from "../interfaces/isms/IMultisigIsm.sol";
import {AbstractCcipReadIsm} from "../isms/ccip-read/AbstractCcipReadIsm.sol";
import {CcipReadIsmMetadata} from "../libs/isms/CcipReadIsmMetadata.sol";
import {Message} from "../libs/Message.sol";

contract TestCcipReadIsm is AbstractCcipReadIsm {
    using Message for bytes;
    using CcipReadIsmMetadata for bytes;

    address[] public validators;
    uint8 public threshold;

    constructor(
        address[] memory _validators,
        uint8 _threshold,
        string[] memory _offchainUrls,
        bytes memory _offchainCallData
    ) {
        validators = _validators;
        threshold = _threshold;
        offchainUrls = _offchainUrls;
        offchainCallData = _offchainCallData;
    }

    function validatorsAndThreshold(bytes calldata)
        public
        view
        virtual
        override
        returns (address[] memory, uint8)
    {
        return (validators, threshold);
    }

    /**
     * @notice Returns the digest to be used for signature verification.
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return digest The digest to be signed by validators
     */
    function digest(bytes calldata, bytes calldata _message)
        internal
        pure
        override
        returns (bytes32)
    {
        return keccak256(_message.body());
    }

    /**
     * @notice Returns the signature at a given index from the metadata.
     * @param _metadata ABI encoded module metadata
     * @param _index The index of the signature to return
     * @return signature Packed encoding of signature (65 bytes)
     */
    function signatureAt(bytes calldata _metadata, uint256 _index)
        internal
        pure
        virtual
        override
        returns (bytes memory)
    {
        return CcipReadIsmMetadata.signatureAt(_metadata, _index);
    }
}
