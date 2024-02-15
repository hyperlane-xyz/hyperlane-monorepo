// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test, StdStorage, stdStorage} from "forge-std/Test.sol";
import {Message} from "../../contracts/libs/Message.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {TelepathyCcipReadIsm} from "../../contracts/isms/ccip-read/telepathy/TelepathyCcipReadIsm.sol";
import {ICcipReadIsm} from "../../contracts/interfaces/isms/ICcipReadIsm.sol";
import {StateProofHelpersTest} from "../lib/StateProofHelpers.t.sol";
import {ISuccinctProofsService} from "../../contracts/interfaces/ccip-gateways/ISuccinctProofsService.sol";

contract TelepathyCcipReadIsmTest is StateProofHelpersTest {
    using Message for bytes;
    using stdStorage for StdStorage;
    using TypeCasts for address;

    address internal alice = address(0x1);
    string[] urls = ["localhost:3001/telepathy-ccip/"];

    TelepathyCcipReadIsm internal telepathyCcipReadIsm;
    MockMailbox mailbox;
    bytes constant correctCessageBody = hex"48656c6c6f21";

    function setUp() public override {
        super.setUp();
        telepathyCcipReadIsm = new TelepathyCcipReadIsm({
            genesisValidatorsRoot: EMPTY_BYTES32,
            genesisTime: 0,
            secondsPerSlot: 12,
            slotsPerPeriod: 8192,
            syncCommitteePeriod: 0,
            syncCommitteePoseidon: EMPTY_BYTES32,
            sourceChainId: 1,
            finalityThreshold: 461,
            stepFunctionId: EMPTY_BYTES32,
            rotateFunctionId: EMPTY_BYTES32,
            gatewayAddress: address(5)
        });
        deployCodeTo("MockMailbox.sol", abi.encode(0), mailboxAddr);
        mailbox = MockMailbox(mailboxAddr);
        telepathyCcipReadIsm.initialize(mailbox, DELIVERIES_SLOT, urls);

        _setExecutionStateRoot();
    }

    // ============ Helper Functions ============

    function _encodeTestMessage(
        bytes memory _messageBody
    ) internal pure returns (bytes memory) {
        // These are real onchain message values for a messageId of 44EFC92481301DB306CB0D8FF7E5FF5B2ABFFEA428677BC37BFFB8DE2B7D7D5F
        return
            MessageUtils.formatMessage(
                uint8(3),
                643,
                43114,
                hex"000000000000000000000000d54ff402adf0a7cbad9626b1261bf4beb26a437a",
                1,
                hex"0000000000000000000000007ff2bf58c38a41ad7c9cbc14e780e8a7edbbd48d",
                _messageBody
            );
    }

    function _copyUrls() internal view returns (string[] memory offChainUrls) {
        uint256 len = telepathyCcipReadIsm.offchainUrlsLength();
        offChainUrls = new string[](len);
        for (uint256 i; i < len; i++) {
            offChainUrls[i] = telepathyCcipReadIsm.offchainUrls(i);
        }
    }

    /// @dev In the future, we can get a proof from Succient and make this test a bit better by calling step()
    function _setExecutionStateRoot() internal {
        // Set the head slot
        stdstore
            .target(address(telepathyCcipReadIsm))
            .sig("head()")
            .checked_write(1);

        // Set the head slot to stateRoot
        stdstore
            .target(address(telepathyCcipReadIsm))
            .sig("executionStateRoots(uint256)")
            .with_key(1)
            .depth(0)
            .checked_write(stateRoot);
    }

    function _encodeProofs() internal view returns (bytes memory) {
        return abi.encode(accountProof, storageProof);
    }

    function testTelepathyCcip_setOffchainUrls_revertsWithNonOwner(
        address _nonOwner
    ) public {
        vm.assume(_nonOwner != address(this));

        urls.push("localhost:3001/telepathy-ccip-2/");
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(_nonOwner);
        telepathyCcipReadIsm.setOffchainUrls(urls);

        // Default to owner
        telepathyCcipReadIsm.setOffchainUrls(urls);
        assertEq(telepathyCcipReadIsm.offchainUrlsLength(), 2);
    }

    function testTelepathyCcip_getOffchainVerifyInfo_revertsCorrectly(
        bytes calldata _message
    ) public {
        bytes memory encodedMessage = _encodeTestMessage(_message);
        string[] memory offChainUrls = _copyUrls();
        bytes memory offChainLookupError = abi.encodeWithSelector(
            ICcipReadIsm.OffchainLookup.selector,
            address(telepathyCcipReadIsm),
            offChainUrls,
            abi.encodeWithSelector(
                ISuccinctProofsService.getProofs.selector,
                address(mailbox),
                telepathyCcipReadIsm.storageKey(encodedMessage.id()),
                1
            ), // Mailbox Addr, storageKeys, blockNumber
            TelepathyCcipReadIsm.process.selector,
            encodedMessage
        );
        vm.expectRevert(offChainLookupError);
        telepathyCcipReadIsm.getOffchainVerifyInfo(encodedMessage);
    }

    function testTelepathyCcip_verify_withMessage(
        bytes calldata _incorrectMessageId
    ) public {
        bytes memory correctMessage = _encodeTestMessage(correctCessageBody);
        vm.assume(keccak256(_incorrectMessageId) != keccak256(correctMessage));

        // Incorrect message
        bool verified = telepathyCcipReadIsm.verify(
            _encodeProofs(),
            _incorrectMessageId
        );
        assertFalse(verified);

        // Correct message
        verified = telepathyCcipReadIsm.verify(_encodeProofs(), correctMessage);
        assertTrue(verified);
    }
}
