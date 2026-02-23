// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {FraudType, Attribution} from "../libs/FraudMessage.sol";
import {AttributeCheckpointFraud} from "../AttributeCheckpointFraud.sol";

contract TestAttributeCheckpointFraud is AttributeCheckpointFraud {
    constructor() AttributeCheckpointFraud() {}

    function mockSetAttribution(
        address signer,
        bytes32 digest,
        FraudType fraudType
    ) external {
        _attributions[signer][digest] = Attribution({
            fraudType: fraudType,
            timestamp: uint48(block.timestamp)
        });
    }
}
