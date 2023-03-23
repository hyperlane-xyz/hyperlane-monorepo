// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

library MOfNTestUtils {
    function choose(
        uint8 m,
        uint256[] memory choices,
        bytes32 seed
    ) internal pure returns (uint256[] memory) {
        uint256 bitmask = _bitmask(m, uint8(choices.length), seed);
        uint256[] memory ret = new uint256[](m);
        uint256 j = 0;
        for (uint256 i = 0; i < choices.length; i++) {
            bool chosen = (bitmask & (1 << i)) > 0;
            if (chosen) {
                ret[j] = choices[i];
                j += 1;
            }
        }
        return ret;
    }

    function choose(
        uint8 m,
        address[] memory choices,
        bytes32 seed
    ) internal pure returns (address[] memory) {
        uint256 bitmask = _bitmask(m, uint8(choices.length), seed);
        address[] memory ret = new address[](m);
        uint256 j = 0;
        for (uint256 i = 0; i < choices.length; i++) {
            bool chosen = (bitmask & (1 << i)) > 0;
            if (chosen) {
                ret[j] = choices[i];
                j += 1;
            }
        }
        return ret;
    }

    function _bitmask(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) private pure returns (uint256) {
        uint8 chosen = 0;
        uint256 bitmask = 0;
        bytes32 randomness = seed;
        while (chosen < m) {
            randomness = keccak256(abi.encodePacked(randomness));
            uint256 choice = (1 << (uint256(randomness) % n));
            if ((bitmask & choice) == 0) {
                bitmask = bitmask | choice;
                chosen += 1;
            }
        }
        return bitmask;
    }
}
