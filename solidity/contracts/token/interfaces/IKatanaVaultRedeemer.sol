// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IKatanaVaultRedeemer {
    function redeem(
        uint256 _shares,
        uint256 _minAssetsOut
    ) external returns (uint256 assetsOut);
}
