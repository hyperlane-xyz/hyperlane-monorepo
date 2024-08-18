// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test, StdStorage, stdStorage} from "forge-std/Test.sol";
import {MockLightClient} from "../../contracts/mock/MockLightClient.sol";

import {Message} from "../../contracts/libs/Message.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {SP1LightClientIsm} from "../../contracts/isms/ccip-read/SP1LightClientIsm.sol";
import {DispatchedHook} from "../../contracts/hooks/DispatchedHook.sol";
import {ICcipReadIsm} from "../../contracts/interfaces/isms/ICcipReadIsm.sol";
import {StateProofHelpersTest} from "../lib/StateProofHelpers.t.sol";
import {ISuccinctProofsService} from "../../contracts/interfaces/ccip-gateways/ISuccinctProofsService.sol";

contract SP1LightClientIsmTest is StateProofHelpersTest {
    using Message for bytes;
    using stdStorage for StdStorage;
    using TypeCasts for address;

    address internal alice = address(0x1);
    string[] urls = ["localhost:3001/telepathy-ccip/"];

    MockMailbox mailbox;
    SP1LightClientIsm sp1LightClientIsm;
    DispatchedHook hook;
    MockLightClient lightClient;

    function setUp() public override {
        super.setUp();
        sp1LightClientIsm = new SP1LightClientIsm();

        lightClient = new MockLightClient({
            genesisValidatorsRoot: EMPTY_BYTES32,
            genesisTime: 0,
            secondsPerSlot: 12,
            slotsPerPeriod: 8192,
            syncCommitteePeriod: 0,
            syncCommitteePoseidon: EMPTY_BYTES32,
            sourceChainId: 1,
            finalityThreshold: 461
        });

        deployCodeTo("DispatchedHook.sol", abi.encode(0), HOOK_ADDR);
        mailbox = MockMailbox(MAILBOX_ADDR);
        hook = DispatchedHook(HOOK_ADDR);

        sp1LightClientIsm.initialize({
            _destinationMailbox: address(mailbox),
            _dispatchedHook: address(hook),
            _lightClient: address(lightClient),
            _dispatchedSlot: DISPATCHED_SLOT,
            _offchainUrls: urls
        });

        _setExecutionStateRoot();
    }

    // ============ Helper Functions ============

    function _encodeTestMessage(
        uint32 _messageNonce
    ) internal pure returns (bytes memory) {
        return
            // Use a struct as the parameter
            MessageUtils.formatMessage({
                _version: 0,
                _nonce: _messageNonce,
                _originDomain: 0,
                _sender: hex"0000000000000000000000007fa9385be102ac3eac297483dd6233d62b3e1496",
                _destinationDomain: 0,
                _recipient: hex"0000000000000000000000007fa9385be102ac3eac297483dd6233d62b3e1496",
                _messageBody: hex"00000000000000000000000000000000000000000000000000000000000000a7"
            });
    }

    function _copyUrls() internal view returns (string[] memory offChainUrls) {
        uint256 len = sp1LightClientIsm.offchainUrlsLength();
        offChainUrls = new string[](len);
        for (uint256 i; i < len; i++) {
            offChainUrls[i] = sp1LightClientIsm.offchainUrls(i);
        }
    }

    /// @dev This Mocks what Succinct's Prover will set, in other words, this sets the head slot and state root
    function _setExecutionStateRoot() internal {
        // Set the head slot
        stdstore.target(address(lightClient)).sig("head()").checked_write(1);

        // Set the head slot to stateRoot
        stdstore
            .target(address(lightClient))
            .sig("executionStateRoots(uint256)")
            .with_key(1)
            .depth(0)
            .checked_write(stateRoot);
    }

    function _encodeProofs() internal view returns (bytes memory) {
        return abi.encode(accountProof, storageProof);
    }

    function testSP1LightClientIsm_setOffchainUrls_revertsWithNonOwner(
        address _nonOwner
    ) public {
        vm.assume(_nonOwner != address(this));

        urls.push("localhost:3001/telepathy-ccip-2/");
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(_nonOwner);
        sp1LightClientIsm.setOffchainUrls(urls);

        // Default to owner
        sp1LightClientIsm.setOffchainUrls(urls);
        assertEq(sp1LightClientIsm.offchainUrlsLength(), 2);
    }

    function testSP1LightClientIsm_getOffchainVerifyInfo_revertsCorrectly(
        uint32 _messageNonce
    ) public {
        bytes memory encodedMessage = _encodeTestMessage(_messageNonce);
        string[] memory offChainUrls = _copyUrls();
        bytes memory offChainLookupError = abi.encodeWithSelector(
            ICcipReadIsm.OffchainLookup.selector,
            address(sp1LightClientIsm),
            offChainUrls,
            abi.encodeWithSelector(
                ISuccinctProofsService.getProofs.selector,
                address(HOOK_ADDR),
                sp1LightClientIsm.dispatchedSlotKey(_messageNonce),
                sp1LightClientIsm.getHeadStateRoot()
            ),
            SP1LightClientIsm.process.selector,
            encodedMessage
        );
        vm.expectRevert(offChainLookupError);
        sp1LightClientIsm.getOffchainVerifyInfo(encodedMessage);
    }

    function testSP1LightClientIsm_verify_withMessage(
        uint32 _incorrectMessageNonce
    ) public {
        vm.assume(_incorrectMessageNonce != MESSAGE_NONCE);

        // Incorrect message
        bool verified = sp1LightClientIsm.verify(
            _encodeProofs(),
            _encodeTestMessage(_incorrectMessageNonce)
        );
        assertFalse(verified);

        // Correct message
        verified = sp1LightClientIsm.verify(
            _encodeProofs(),
            _encodeTestMessage(MESSAGE_NONCE)
        );
        assertTrue(verified);
    }
}
