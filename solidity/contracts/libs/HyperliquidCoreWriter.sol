// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

library HyperliquidCoreWriter {
    address internal constant CORE_WRITER =
        0x3333333333333333333333333333333333333333;

    uint8 internal constant ACTION_VERSION = 1;

    uint24 internal constant SPOT_SEND_ACTION_ID = 6;
    uint24 internal constant SEND_ASSET_ACTION_ID = 13;

    uint32 internal constant CORE_PERPS_DEX_ID = 0;
    uint32 internal constant CORE_SPOT_DEX_ID = type(uint32).max;

    function formatSpotSend(
        address destination,
        uint64 token,
        uint64 amount
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                ACTION_VERSION,
                _formatActionId(SPOT_SEND_ACTION_ID),
                abi.encode(destination, token, amount)
            );
    }

    function formatSendAsset(
        address destination,
        address subAccount,
        uint32 sourceDex,
        uint32 destinationDex,
        uint64 token,
        uint64 amount
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                ACTION_VERSION,
                _formatActionId(SEND_ASSET_ACTION_ID),
                abi.encode(
                    destination,
                    subAccount,
                    sourceDex,
                    destinationDex,
                    token,
                    amount
                )
            );
    }

    function _formatActionId(uint24 actionId) private pure returns (bytes3) {
        return bytes3(actionId);
    }
}
