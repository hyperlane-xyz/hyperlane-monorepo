// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

// ============ Internal Imports ============
import {Message} from "../../libs/Message.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";

/**
 * @title AmountPartition
 */
abstract contract AmountPartition is PackageVersioned {
    using Message for bytes;
    using TokenMessage for bytes;
    using Address for address;

    address public immutable lower;
    address public immutable upper;
    uint256 public immutable threshold;

    constructor(address _lower, address _upper, uint256 _threshold) {
        require(
            _lower.isContract() && _upper.isContract(),
            "AmountPartition: lower and upper must be contracts"
        );
        lower = _lower;
        upper = _upper;
        threshold = _threshold;
    }

    function _partition(
        bytes calldata _message
    ) internal view returns (address) {
        uint256 amount = _message.body().amount();
        if (amount >= threshold) {
            return upper;
        } else {
            return lower;
        }
    }
}
