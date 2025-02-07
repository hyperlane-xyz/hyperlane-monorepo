// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

// ============ Internal Imports ============
import {AbstractRoutingIsm} from "../routing/AbstractRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";

/**
 * @title DomainRoutingIsm
 */
contract DomainRoutingIsm is AbstractRoutingIsm, Ownable, PackageVersioned {
    using Message for bytes;
    using TokenMessage for bytes;
    using Address for address;

    IInterchainSecurityModule public immutable lower;
    IInterchainSecurityModule public immutable upper;

    // ============ Mutable Storage ============
    uint256 public threshold;

    constructor(
        address _owner,
        address _lower,
        address _upper,
        uint256 _threshold
    ) Ownable() {
        lower = IInterchainSecurityModule(_lower);
        upper = IInterchainSecurityModule(_upper);
        setThreshold(_threshold);
        _transferOwnership(_owner);
    }

    function setThreshold(uint256 _threshold) public onlyOwner {
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
        if (amount > threshold) {
            return upper;
        } else {
            return lower;
        }
    }
}
