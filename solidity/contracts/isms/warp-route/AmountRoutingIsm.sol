// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// ============ Internal Imports ============
import {AbstractRoutingIsm} from "../routing/AbstractRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";

/**
 * @title AmountRoutingIsm
 */
contract AmountRoutingIsm is AbstractRoutingIsm, PackageVersioned {
    using Message for bytes;
    using TokenMessage for bytes;

    IInterchainSecurityModule public immutable lower;
    IInterchainSecurityModule public immutable upper;
    uint256 public immutable threshold;

    // ============ Mutable Storage ============

    constructor(address _lower, address _upper, uint256 _threshold) {
        lower = IInterchainSecurityModule(_lower);
        upper = IInterchainSecurityModule(_upper);
        threshold = _threshold;
    }

    // ============ Public Functions ============
    /**
     * @notice Returns the ISM responsible for verifying _message
     * @dev Routes to upper ISM if amount > threshold, otherwise lower ISM.
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return module The ISM to use to verify _message
     */
    function route(
        bytes calldata _message
    ) public view override returns (IInterchainSecurityModule) {
        uint256 amount = _message.body().amount();
        if (amount >= threshold) {
            return upper;
        } else {
            return lower;
        }
    }
}
