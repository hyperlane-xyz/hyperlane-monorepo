// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import {Test} from "forge-std/Test.sol";

import {Mailbox} from "../contracts/Mailbox.sol";
import {PolymerISM} from "../contracts/isms/PolymerIsm.sol";
import {ICrossL2ProverV2} from "@polymerdao/prover-contracts/contracts/interfaces/ICrossL2ProverV2.sol";

contract DeployTest is Test {
    Mailbox mailbox;
    PolymerISM polymerIsm;

    function setUp() public {
        vm.createSelectFork("https://rpc.everclear.raas.gelato.cloud");

        // Set the contracts with their deployed addresses
        mailbox = Mailbox(address(0xd84ab43D7F2F99339657E4bfaE3C955bE8d3099C));
        polymerIsm = PolymerISM(
            address(0x593cA6a919b9946Aa8a9aBFd7C499F3fEe8D7A9E)
        );
    }

    function test_do_fork() public {
        // Print contract addresses and configuration
        console.log("Mailbox address:", address(mailbox));
        console.log("PolymerISM address:", address(polymerIsm));
        console.log(
            "PolymerISM.polymerProver:",
            address(polymerIsm.polymerProver())
        );
        console.log("PolymerISM.originMailbox:", polymerIsm.originMailbox());
        console.log("Local domain:", mailbox.localDomain());

        bytes
            memory message = hex"03000000030000210500000000000000000000000046cb3da13fd222887ef869e2db5ab73c854fcf0d000062ef00000000000000000000000026f5ffd72537b60589c704aeee2d13b9a76075ac48656c6c6f2066726f6d204261736520746f2045766572636c6561722053746167696e6721";

        /* // Parse the message data to better understand what's happening */
        /* // Extract relevant info from the message */
        /* // Format is: version (1 byte) + nonce (4 bytes) + origin (4 bytes) + sender (32 bytes) + destination (4 bytes) + recipient (32 bytes) + body */
        /* uint8 version = uint8(message[0]); */
        /* uint32 origin; */
        /* assembly { */
        /*     origin := mload(add(message, 9)) // 1 (version) + 4 (nonce) + 4 (origin) */
        /* } */
        /* origin = origin >> (256 - 32); // Adjust for big-endian format */

        /* // Print message details */
        /* console.log("Message version:", version); */
        /* console.log("Message origin domain:", origin); */

        // Wrap in try-catch to see the exact revert reason
        bytes
            memory metadata = hex"388c0127b39ea1ed373a86946f771903d64d06dc0564812b36e13ecb7384d6eac1e5808852d8172fcd5e7ce297ecda6b19834b3b8a88d45c12ba2286138da2fe01c9365b14f0797dbe3c105f0db8196baa33d70bc31c12d45a311106cf2edee11c0000210500000000000a6d5e0000000001cd27c00048000401cfd84ab43d7f2f99339657e4bfae3c955be8d3099c769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c81400000000000000000000000046cb3da13fd222887ef869e2db5ab73c854fcf0d00000000000000000000000000000000000000000000000000000000000062ef00000000000000000000000026f5ffd72537b60589c704aeee2d13b9a76075ac0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000007203000000030000210500000000000000000000000046cb3da13fd222887ef869e2db5ab73c854fcf0d000062ef00000000000000000000000026f5ffd72537b60589c704aeee2d13b9a76075ac48656c6c6f2066726f6d204261736520746f2045766572636c6561722053746167696e6721000000000000000000000000000012080002bcb5532d29290204bcb55320ccbafb67ac2cbd3a0bb248e47853c47c3e6d972048d870397b1848b9b11df6412029290406bcb55320ea6dfd0cce2c0e7e51c64673baf3e4e8d79d44d2e0c345534fa146849f4deb6a202929060abcb55320292d1466a2507c7a324564ce9bf99eb65e6ef1f806674fba8cc5488fdf7e6ca02029290812bcb553207210551f8e95a270c3b512235376a861dfc329e5196f9f312dc6f77b7656fcf72029290a32bcb5532084608803e71e137cb8768fa64be45dfc6518bf7b5ea9a5898c518cb8f9e957402029290c72bcb553201d20370496ff1d753ac05bc7921d59e652f0712146bfbe6c0d6b5d5fdeb6010a202a2a0ef201bcb553203736980094ddb169cb14828526ea5f9dceb6bc649c277a42ac231812a8cc307a202a2a10f202bcb553202a5608d35b375eba9c671f071175e56e2ff558bc34cb4b7afc2b46a6109ee719202a2a12f204bcb553204ea32f297ad629b64473fd648ec3faeac2eabdccf416506b7cd2de2a29e69c59202a2a14e607bcb55320826019f75d0d62e29e68f53db1210791449dae9a098ee9b75b8b8b3d7ca623ef202a2a16820dbcb55320f67e062b9bf7f52e7ccd59ad5d75dcdaab60376cb0084628f6f3f69b135484cc202a2a1a9227bcb55320e943eb7e3d19c63028861e1eaf079158a6f7bf327332627b90eb3806dcb7051820092a1cf451bcb5532020b76d3fc10f3572c7dae13245d6d3a3309027dc2d41d904fefc93b9fd894390492b2b1ed2af01bcb55320c047c82528afda0100c8e403a5a6b971f5e8c4e5cb69a88e1af1659d5de904e0200a2b2282f003bcb55320205bef1b26d62c41e26f0010cd6eb9692172554451f01b6a85f4080c78857944fd2b2b24bc9a06bcb55320b83ed8c2365da68f52e15f53a3c46af340c541299d0ed09abccaf4d096c09c4b202b2b26a4f20abcb553207e245aefe47b6999d431d7f609b5d17e406f5d7b665a8a9c329f26c6d10f0a06200a2b28eacf16bcb5532020ad2d4bf5c02bffb541e4cbfd6744432aa6dad760b8d161cfaf43dd65465f9258";

        try polymerIsm.verify(metadata, message) returns (bool result) {
            console.log("Verification successful:", result);
        } catch Error(string memory reason) {
            console.log("Error:", reason);
        } catch (bytes memory lowLevelData) {
            console.log(
                "Low level error with data:",
                vm.toString(lowLevelData)
            );
        }

        // Now try direct call to the validateEvent function on polymerProver
        address proverAddress = address(polymerIsm.polymerProver());
        console.log(
            "Attempting to call validateEvent directly on prover:",
            proverAddress
        );

        try ICrossL2ProverV2(proverAddress).validateEvent(metadata) returns (
            uint32 chainId,
            address emitter,
            bytes memory topics,
            bytes memory data
        ) {
            console.log("validateEvent succeeded:");
            console.log("  Chain ID:", chainId);
            console.log("  Emitter:", emitter);
            console.log("  Topics length:", topics.length);
            console.log("  Data length:", data.length);
        } catch Error(string memory reason) {
            console.log("validateEvent error:", reason);
        } catch (bytes memory lowLevelData) {
            console.log(
                "validateEvent low level error with data:",
                vm.toString(lowLevelData)
            );
        }

        /* // Try the full mailbox process call (commented out to avoid duplicate output) */
        /* console.log("\nAttempting mailbox.process call:"); */
        /* try mailbox.process(metadata, message) { */
        /*     console.log("Process call succeeded"); */
        /* } catch Error(string memory reason) { */
        /*     console.log("Process error:", reason); */
        /* } catch (bytes memory lowLevelData) { */
        /*     console.log("Process low level error with data:", vm.toString(lowLevelData)); */
        /* } */
    }
}
