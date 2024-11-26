// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {Test} from "forge-std/Test.sol";
import "forge-std/StdJson.sol";
import "../../contracts/libs/StateProofHelpers.sol";

/**
 * @title Test of StateProofHelper
 * @notice This test uses the JSON results from an RPC, such as https://www.quicknode.com/docs/ethereum/eth_getProof
 *
 * address: 0x7DDf66a264656A36eB0Ff4bC6eC562028B983B90 (DispatchedHook on Holesky)
 * storageSlot: 0x66ce4e8e12a5403828e3fb3176b429cb926ef9dc29fd04c1b3c13ed2787d98d6 (slot for DispatchedHook.dispatched)
 * blockNumber: 2151871
 * stateRoot: 0x03e88cdfbd9dc672604e797310dc332658844408a65fef43c83313f2cd19bb9b (sourced from https://holesky.etherscan.io/block/2151871)
 *
 * You can use cast index to access storage slot of DispatchedHook.dispatched for nonce 138:
 *
 * Get the the storage location for slot 0x0 (mapping(uint256 messageNonce => messageId))
 * cast index address "0x7DDf66a264656A36eB0Ff4bC6eC562028B983B90" 0
 *
 * Get the the index for nonce 0 at storage location calculated above
 * cast index uint256 138 0
 * > 0x66ce4e8e12a5403828e3fb3176b429cb926ef9dc29fd04c1b3c13ed2787d98d6
 */
contract StateProofHelpersTest is Test {
    string proofsJson;
    bytes[] accountProof;
    bytes[] storageProof;

    address constant HOOK_ADDR = 0x7DDf66a264656A36eB0Ff4bC6eC562028B983B90;
    bytes32 constant stateRoot =
        bytes32(
            0x8284b05f9fecfb3b8089dc7671e647563fdba6b1c6b4ce10d257a5f18fd471cf
        );

    address constant MAILBOX_ADDR = 0x46f7C5D896bbeC89bE1B19e4485e59b4Be49e9Cc;
    bytes constant MESSAGE_ID =
        hex"42a71a941db463ca31d30e30837b436a24fafbf1e0210e5013dcc5af8029989c";
    uint256 constant ACCOUNT_PROOF_LENGTH = 9;
    uint256 constant STORAGE_PROOF_LENGTH = 1;
    uint256 constant DISPATCHED_SLOT = 0;
    uint32 constant MESSAGE_NONCE = 138;
    bytes32 constant EMPTY_BYTES32 = bytes32("");

    function setUp() public virtual {
        proofsJson = vm.readFile("./test/test-data/getProof-data.json");
        accountProof = getAccountProofs();
        storageProof = getStorageProofs();
    }

    function getAccountProofs()
        public
        view
        returns (bytes[] memory accountProof_)
    {
        accountProof_ = new bytes[](ACCOUNT_PROOF_LENGTH);
        string memory prefix;
        for (uint i = 0; i < ACCOUNT_PROOF_LENGTH; i++) {
            prefix = string.concat(
                ".accountProof[",
                string.concat(vm.toString(i), "]")
            );
            accountProof_[i] = stdJson.readBytes(proofsJson, prefix);
        }
    }

    function getStorageProofs()
        public
        view
        returns (bytes[] memory storageProof_)
    {
        storageProof_ = new bytes[](STORAGE_PROOF_LENGTH);
        string memory prefix;

        for (uint i = 0; i < STORAGE_PROOF_LENGTH; i++) {
            prefix = string.concat(
                ".storageProof[0].proof[",
                string.concat(vm.toString(i), "]")
            );
            storageProof_[i] = stdJson.readBytes(proofsJson, prefix);
        }
    }

    function testStateProofHelpersTest_getStorageRoot_setsDeliveriesValue()
        public
    {
        // Calculate the storage root
        bytes32 storageRoot = StorageProof.getStorageRoot(
            HOOK_ADDR,
            accountProof,
            stateRoot
        );

        // Calculate the dispatched slot
        // mapping(uint256 messageNonce => messageId)
        bytes32 dispatchedSlot = keccak256(
            abi.encode(MESSAGE_NONCE, DISPATCHED_SLOT)
        );
        bytes memory delivery = StorageProof.getStorageBytes(
            keccak256(abi.encode(dispatchedSlot)),
            storageProof,
            storageRoot
        );
        assertTrue(keccak256(delivery) == keccak256(MESSAGE_ID));
    }
}
