// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {IMultisigIsm} from "../interfaces/isms/IMultisigIsm.sol";
import {AbstractCcipReadIsm} from "../isms/ccip-read/AbstractCcipReadIsm.sol";
import {Message} from "../libs/Message.sol";

contract TestCcipReadIsm is AbstractCcipReadIsm {
    using Message for bytes;

    address[] public validators;
    uint8 public threshold;

    constructor(
        address[] memory _validators,
        uint8 _threshold,
        string[] memory _offchainUrls
    ) {
        validators = _validators;
        threshold = _threshold;
        offchainUrls = _offchainUrls;
    }

    /**
     * No-op
     */
    function handle() external pure {
        return;
    }

    /**
     * No-op
     */
    function verify(bytes calldata, bytes calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}
