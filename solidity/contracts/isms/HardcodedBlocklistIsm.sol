// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "../libs/Message.sol";
import "../interfaces/IInterchainSecurityModule.sol";

/**
 * @title HardcodedBlocklistIsm
 * @notice A “compile‐time” blocklist ISM. All blocked message IDs are baked into code,
 * so verify() never performs a storage lookup.
 */
contract HardcodedBlocklistIsm is IInterchainSecurityModule {
    using Message for bytes;

    uint8 public immutable moduleType = uint8(Types.NULL);

    // ─── Begin “compile‐time” blocklist ───
    // Whenever you want to change which messageIDs are blocked, edit these values
    // and re‐compile/re‐deploy.
    bytes32 public constant BLOCKED_ID_1 =
        0xbd7eccf869f79031b18d57308b36bf424cea41aec5e631a6d9b8922fee2620ba;
    bytes32 public constant BLOCKED_ID_2 =
        0xe9711b78964bee999fd9022536328802ccdf2db3e98beb1331ae54fe614bc891;
    // ─── End “compile‐time” blocklist ───

    /**
     * @notice Verify that `message` is not in the hardcoded blocklist.
     * metadata (unused)
     * @param message The raw Hyperlane‐encoded message bytes.
     * @return True if message.id() does *not* match any BLOCKED_ID_* constant.
     */
    function verify(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external pure override returns (bool) {
        bytes32 id = message.id();

        // Simple chain of comparisons:
        if (id == BLOCKED_ID_1) return false;
        if (id == BLOCKED_ID_2) return false;

        return true;
    }
}
