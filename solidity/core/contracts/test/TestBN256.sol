// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "../../libs/BN256.sol";

contract TestBN256 {
    constructor() {}

    using BN256 for BN256.G1Point;

    // Expose useful useful view functions for testing
    function ecAdd(BN256.G1Point memory a, BN256.G1Point memory b)
        external
        view
        returns (BN256.G1Point memory)
    {
        return a.add(b);
    }

    function ecMul(BN256.G1Point memory a, uint256 b)
        external
        view
        returns (BN256.G1Point memory)
    {
        return a.mul(b);
    }

    function ecGen(uint256 s) public view returns (BN256.G1Point memory) {
        return BN256.g().mul(s);
    }
}
