// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {IMultisigIsm} from "../interfaces/isms/IMultisigIsm.sol";
import {AbstractCcipReadIsm} from "../isms/ccip-read/AbstractCcipReadIsm.sol";
import {CcipReadIsmMetadata} from "../libs/isms/CcipReadIsmMetadata.sol";

contract TestCcipReadIsm is AbstractCcipReadIsm {
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

    function validatorsAndThreshold(bytes calldata _message)
        public
        view
        virtual
        override
        returns (address[] memory, uint8)
    {
        return (validators, threshold);
    }
}
