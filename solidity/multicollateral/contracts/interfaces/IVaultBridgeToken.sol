// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IVaultBridgeToken {
    function asset() external view returns (address);

    function depositAndBridge(
        uint256 assets,
        address receiver,
        uint32 destinationNetworkId,
        bool forceUpdateGlobalExitRoot
    ) external payable returns (uint256 shares);

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) external returns (uint256 assets);
}
