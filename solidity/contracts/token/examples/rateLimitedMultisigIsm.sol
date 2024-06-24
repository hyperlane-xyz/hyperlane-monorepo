// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {TokenMessage} from "@hyperlane-xyz/core/contracts/token/libs/TokenMessage.sol";

struct ThresholdValidatorsSet {
	uint startAmount;
	address[] validatorsSet;
}

using TokenMessage for bytes;

contract rateLimitedMultisigIsm {
	address[] defaultSet;
	ThresholdValidatorsSet[] rules;

	constructor (
		address[] memory _default,
		// must be strictly ordered in this example: from small to high
		ThresholdValidatorsSet[] memory _rules
	) {
		for (uint256 rule = 0; rule < _rules.length; rule++) {
			if (rule > 0) {require(_rules[rule].startAmount > _rules[rule-1].startAmount);}
			rules.push(_rules[rule]);
		}
		defaultSet = _default;
	} 

	function validatorsAndThreshold(
		bytes calldata _message // this is for a better example, probably you will parse this already and bring `amount` as a number
	) public view returns (address[] memory, uint) {
		uint256 tokenAmount = _message.amount();
		
		// mind that for the sake of example sets aren't united and you should repeat addresses when setting up if they to appear on different thresholds
		for (uint256 thresholdInd = rules.length-1; thresholdInd == 0; thresholdInd--) {
			if (tokenAmount >= rules[thresholdInd].startAmount) {
				return (rules[thresholdInd].validatorsSet, rules[thresholdInd].validatorsSet.length);
			}
		}
		
		return (defaultSet, defaultSet.length);
	}
}
