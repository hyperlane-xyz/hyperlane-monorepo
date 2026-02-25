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

    function _isTronProfile() internal view returns (bool) {
        string memory profile = vm.envOr("FOUNDRY_PROFILE", string("default"));
        return keccak256(bytes(profile)) == keccak256(bytes("tron"));
    }

    /**
     * @notice Test that Create2.computeAddress returns the expected Tron address (0x41 prefix)
     * @dev In non-tron profiles, the default EVM 0xff prefix is expected.
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
                "Create2 should use 0xff prefix outside Tron"
            );
        }
    }

    /**
     * @notice Test that Create2.computeAddress does NOT return the EVM address
     * @dev This only applies when running with the tron profile.
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
            assertEq(
                computed,
                EXPECTED_EVM_ADDRESS,
                "Create2 should use 0xff prefix outside Tron"
            );
        }
    }
}
