// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/utils/Create2.sol";

/**
 * @title TronCreate2Test
 * @notice Tests that the correct Create2 library is being used based on the foundry profile.
 *
 * When compiled with FOUNDRY_PROFILE=tron, the Create2 library should use 0x41 prefix.
 * When compiled with default profile, it should use 0xff prefix.
 *
 * The test computes a CREATE2 address and compares against known expected values
 * calculated for each prefix.
 */
contract TronCreate2Test is Test {
    // Test inputs
    address constant DEPLOYER = 0x1234567890123456789012345678901234567890;
    bytes32 constant SALT = bytes32(uint256(1));
    bytes32 constant BYTECODE_HASH = keccak256("test bytecode");

    // Pre-computed expected addresses for each prefix
    // These are computed as: keccak256(prefix ++ deployer ++ salt ++ bytecodeHash)[12:]

    // Expected address when using 0xff prefix (standard EVM)
    // keccak256(0xff ++ deployer ++ salt ++ bytecodeHash)[12:]
    address constant EXPECTED_EVM_ADDRESS =
        0x63ffBB31CD11331fcA3705D34A3Fed0db387C5c8;

    // Expected address when using 0x41 prefix (Tron)
    // keccak256(0x41 ++ deployer ++ salt ++ bytecodeHash)[12:]
    address constant EXPECTED_TRON_ADDRESS =
        0x2447B82A6E96d9d4Fb407235DBC9Faeb44902A8f;

    /**
     * @notice Detect whether we are running under the Tron foundry profile.
     * @dev Checks if the FOUNDRY_PROFILE env var equals 'tron'.
     */
    function _isTronProfile() internal view returns (bool) {
        // vm.envOr returns the fallback when the env var is unset
        string memory profile = vm.envOr("FOUNDRY_PROFILE", string("default"));
        return keccak256(bytes(profile)) == keccak256(bytes("tron"));
    }

    /**
     * @notice Test that Create2.computeAddress returns the expected address for the active profile.
     * @dev With FOUNDRY_PROFILE=tron the 0x41 prefix is used; otherwise 0xff.
     */
    function test_computeAddress_usesTronPrefix() public view {
        address computed = Create2.computeAddress(
            SALT,
            BYTECODE_HASH,
            DEPLOYER
        );

        if (_isTronProfile()) {
            assertEq(
                computed,
                EXPECTED_TRON_ADDRESS,
                "Create2 should use 0x41 prefix for Tron"
            );
        } else {
            assertEq(
                computed,
                EXPECTED_EVM_ADDRESS,
                "Create2 should use 0xff prefix for EVM"
            );
        }
    }

    /**
     * @notice Test that Create2.computeAddress does NOT return the wrong-profile address.
     */
    function test_computeAddress_notEvmPrefix() public view {
        address computed = Create2.computeAddress(
            SALT,
            BYTECODE_HASH,
            DEPLOYER
        );

        if (_isTronProfile()) {
            assertTrue(
                computed != EXPECTED_EVM_ADDRESS,
                "Create2 should NOT use 0xff prefix for Tron"
            );
        } else {
            assertTrue(
                computed != EXPECTED_TRON_ADDRESS,
                "Create2 should NOT use 0x41 prefix for EVM"
            );
        }
    }
}
