// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {Test} from "forge-std/Test.sol";
import "forge-std/StdJson.sol";
import "../../contracts/libs/StateProofHelpers.sol";
import "forge-std/console.sol";

/**
 * @title Test of StateProofHelper
 * @notice This test uses https://www.quicknode.com/docs/ethereum/eth_getProof Given:
 * address: 0xc005dc82818d67AF737725bD4bf75435d065D239 (Mailbox on mainnet)
 * storageSlot: 0x6A (slot for Mailbox.deliveries)
 * blockNumber: 1221E88 (19013256)
 * stateRoot: 0x46bdf4dd846f5342e246c2d5a1d321750f9f0937f4cb1de57bef56dea23c89f6 (sourced from https://etherscan.io/block/19013256)
 *
 * To query eth_getProof:
 curl https://docs-demo.quiknode.pro/ \
 -X POST \
 -H "Content-Type: application/json" \
 --data '{"method":"eth_getProof","params":["0xc005dc82818d67af737725bd4bf75435d065d239",["0x4374c903375ef1c6c66e6a9dc57b72742c6311d6569fb6fe2903a2172f8c31ff"],"0x1221E88"],"id":1,"jsonrpc":"2.0"}'
 */
contract StateProofHelpersTest is Test {
    address constant mailboxAddr = 0xc005dc82818d67AF737725bD4bf75435d065D239;
    bytes32 constant stateRoot =
        bytes32(
            0x46bdf4dd846f5342e246c2d5a1d321750f9f0937f4cb1de57bef56dea23c89f6
        );

    string proofsJson;

    bytes[] accountProof;
    bytes[] storageProof;

    bytes32 constant MESSAGE_ID =
        hex"44EFC92481301DB306CB0D8FF7E5FF5B2ABFFEA428677BC37BFFB8DE2B7D7D5F";
    uint256 constant ACCOUNT_PROOF_LENGTH = 9;
    uint256 constant STORAGE_PROOF_LENGTH = 3;
    uint256 constant DELIVERIES_SLOT = 106;
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
        return accountProof_;
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
            mailboxAddr,
            accountProof,
            stateRoot
        );

        // Calculate the deliveries value
        bytes32 deliveriesSlotKey = keccak256(
            abi.encode(keccak256(abi.encode(MESSAGE_ID, DELIVERIES_SLOT)))
        );
        bytes memory delivery = StorageProof.getStorageBytes(
            deliveriesSlotKey,
            storageProof,
            storageRoot
        );

        // The result of delivery should not be a null value
        assertTrue(keccak256(delivery) != EMPTY_BYTES32);
    }
}
