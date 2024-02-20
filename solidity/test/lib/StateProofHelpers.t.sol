// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {Test} from "forge-std/Test.sol";
import "forge-std/StdJson.sol";
import "../../contracts/libs/StateProofHelpers.sol";

/**
 * @title Test of StateProofHelper
 * @notice This test uses the JSON results from an RPC, such as https://www.quicknode.com/docs/ethereum/eth_getProof
 *
 * address: 0x3EF546F04a1B24EAF9dCe2ed4338A1b5c32e2a56 (TelepathyCcipReadhook on Sepolia)
 * storageSlot: 0x0 (slot for TelepathyCcipReadhook.dispatched)
 * blockNumber: 5322910
 * stateRoot: 0x03e88cdfbd9dc672604e797310dc332658844408a65fef43c83313f2cd19bb9b (sourced from https://etherscan.io/block/5322910, but also the hash of the 1st account proof)
 *
 * Alternatively, you can use cast index to access mappings:
 *
 * Get the the storage location for slot 0x0 (a nested mapping(address mailbox => mapping(uint256 messageNonce => messageId)))
 * cast index address "0xd81BDE27ce1217C5DaF4dE611577667534f997B0" 0
 *
 * Get the the index for nonce 0 at storage location calculated above
 * cast index uint256 0 0xc975e4c05def9782b312ab471f3a24f2361ceeffb778cb5c7bbde5b1c4c53074
 */
contract StateProofHelpersTest is Test {
    string proofsJson;
    bytes[] accountProof;
    bytes[] storageProof;

    address constant HOOK_ADDR = 0x3EF546F04a1B24EAF9dCe2ed4338A1b5c32e2a56;
    bytes32 constant stateRoot =
        bytes32(
            0x03e88cdfbd9dc672604e797310dc332658844408a65fef43c83313f2cd19bb9b
        );

    address constant MAILBOX_ADDR = 0xd81BDE27ce1217C5DaF4dE611577667534f997B0;
    bytes constant MESSAGE_ID =
        hex"31ede38d2e93c5aee49c836f329a626d8c6322abfbff3783e82e5759f870d7e9";
    uint256 constant ACCOUNT_PROOF_LENGTH = 7;
    uint256 constant STORAGE_PROOF_LENGTH = 1;
    uint256 constant DISPATCHED_SLOT = 0;
    uint32 constant MESSAGE_NONCE = 0;
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
        // mapping(address mailbox => mapping(uint256 messageNonce => messageId))
        bytes32 dispatchedSlot = keccak256(
            abi.encode(
                MESSAGE_NONCE,
                keccak256(abi.encode(MAILBOX_ADDR, DISPATCHED_SLOT))
            )
        );
        bytes memory delivery = StorageProof.getStorageBytes(
            keccak256(abi.encode(dispatchedSlot)),
            storageProof,
            storageRoot
        );
        assertTrue(keccak256(delivery) == keccak256(MESSAGE_ID));
    }
}
