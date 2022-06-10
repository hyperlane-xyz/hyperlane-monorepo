// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {BN256} from "../../libs/BN256.sol";
import {ValidatorSet} from "../../libs/ValidatorSet.sol";

contract TestValidatorSet {
    using ValidatorSet for ValidatorSet.Set;

    ValidatorSet.Set public set;

    // solhint-disable-next-line no-empty-blocks
    constructor() {}

    function add(BN256.G1Point calldata _key) external {
        set.add(_key);
    }

    function remove(BN256.G1Point calldata _key) external {
        set.remove(_key);
    }

    function setThreshold(uint256 _threshold) external {
        set.setThreshold(_threshold);
    }

    function isValidator(BN256.G1Point calldata _key)
        external
        view
        returns (bool)
    {
        return set.isValidator(_key);
    }

    function decompress(bytes32 _compressed)
        external
        view
        returns (BN256.G1Point memory)
    {
        return set.decompress(_compressed);
    }

    function verificationKey(bytes32[] calldata _missing)
        external
        view
        returns (BN256.G1Point memory)
    {
        return set.verificationKey(_missing);
    }
}
