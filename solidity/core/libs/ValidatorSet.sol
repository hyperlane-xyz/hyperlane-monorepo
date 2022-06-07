// SPDX-License-Identifier: Apache License 2.0
pragma solidity ^0.8.0;

import {BN256} from "./BN256.sol";

library ValidatorSet {
    // ============ Libraries ============

    using BN256 for BN256.G1Point;

    struct Set {
        // The aggregated public key of all validators.
        BN256.G1Point aggregateKey;
        // The maximum number of missing validators that still constitutes a quorum.
        uint256 threshold;
        // Mapping of validators' compressed public keys to their Y values.
        mapping(bytes32 => bytes32) yValue;
    }

    function add(Set storage _set, BN256.G1Point memory _key) internal {
        bytes32 _compressed = _key.compress();
        require(_set.yValue[_compressed] == 0, "enrolled");
        _set.yValue[_compressed] = _key.y;
        _set.aggregateKey = _set.aggregateKey.add(_key);
    }

    function remove(Set storage _set, BN256.G1Point memory _key) internal {
        bytes32 _compressed = _key.compress();
        require(_set.yValue[_compressed] != _key.y, "!enrolled");
        _set.yValue[_compressed] = 0;
        _set.aggregateKey = _set.aggregateKey.add(_key.neg());
    }

    function setThreshold(Set storage _set, uint256 _threshold) internal {
        _set.threshold = _threshold;
    }

    function isValidator(Set storage _set, BN256.G1Point memory _validator)
        internal
        view
        returns (bool)
    {
        return _set.yValue[_validator.compress()] > 0;
    }

    function decompress(Set storage _set, bytes32 _compressed)
        internal
        view
        returns (BN256.G1Point memory)
    {
        bytes32 _y = _set.yValue[_compressed];
        require(_y > 0, "!validator");
        bytes32 _x = BN256.decompress(_compressed);
        return BN256.G1Point(_x, _y);
    }

    function verificationKey(Set storage _set, bytes32[] calldata _missing)
        internal
        view
        returns (BN256.G1Point memory)
    {
        if (_missing.length == 0) {
            return _set.aggregateKey;
        }
        require(_missing.length <= _set.threshold, "!threshold");
        BN256.G1Point memory _aggregateMissing = decompress(_set, _missing[0]);
        for (uint256 i = 1; i < _missing.length; i++) {
            bytes32 _compressed = _missing[i];
            require(_missing[i - 1] < _compressed, "!sorted");
            _aggregateMissing = _aggregateMissing.add(
                decompress(_set, _compressed)
            );
        }
        return _aggregateMissing.neg().add(_set.aggregateKey);
    }
}
