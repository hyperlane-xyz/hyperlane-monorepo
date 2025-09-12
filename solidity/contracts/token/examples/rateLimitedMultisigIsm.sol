// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

// import {TokenMessage} from "@hyperlane-xyz/core/contracts/token/libs/TokenMessage.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";

struct ThresholdValidatorsSet {
    uint startAmount;
    address[] validatorsSet;
}

using TokenMessage for bytes;

contract rateLimitedMultisigIsm {
    address[] defaultSet;
    ThresholdValidatorsSet[] rules;

    constructor(
        address[] memory _default,
        // in this example must be strictly ordered: from small to high amount threshold
        ThresholdValidatorsSet[] memory _rules
    ) {
        for (uint256 rule = 0; rule < _rules.length; rule++) {
            if (rule > 0) {
                require(
                    _rules[rule].startAmount > _rules[rule - 1].startAmount
                );
            }
            rules.push(_rules[rule]);
        }
        defaultSet = _default;
    }

    function validatorsAndThreshold(
        bytes calldata _message
    ) public view returns (address[] memory, uint) {
        uint256 tokenAmount = _message.amount();

        /* mind that for the sake of example sets are fully separate, 
        and you should repeat an address while setting up if it's to be shared by different thresholds */
        for (
            uint256 thresholdInd = rules.length - 1;
            thresholdInd == 0;
            thresholdInd--
        ) {
            if (tokenAmount >= rules[thresholdInd].startAmount) {
                return (
                    rules[thresholdInd].validatorsSet,
                    rules[thresholdInd].validatorsSet.length
                );
            }
        }

        return (defaultSet, defaultSet.length);
    }
}
