// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {TelepathyCcipReadIsm} from "../../contracts/isms/ccip-read/telepathy/TelepathyCcipReadIsm.sol";
import {ICcipReadIsm} from "../../contracts/interfaces/isms/ICcipReadIsm.sol";
import "forge-std/console.sol";

contract TelepathyCcipReadIsmTest is Test {
    string[] urls = ["localhost:3001/telepathy-ccip/"];
    TelepathyCcipReadIsm internal telepathyCcipReadIsm;
    MockMailbox mailbox;

    function setUp() public {
        telepathyCcipReadIsm = new TelepathyCcipReadIsm({
            genesisValidatorsRoot: bytes32(""),
            genesisTime: 0,
            secondsPerSlot: 12,
            slotsPerPeriod: 8192,
            syncCommitteePeriod: 0,
            syncCommitteePoseidon: bytes32(""),
            sourceChainId: 1,
            finalityThreshold: 461,
            stepFunctionId: bytes32(""),
            rotateFunctionId: bytes32(""),
            gatewayAddress: address(5)
        });
        mailbox = new MockMailbox(0);
        telepathyCcipReadIsm.initialize(mailbox, urls);
    }

    function _copyUrls() internal view returns (string[] memory offChainUrls) {
        uint256 len = telepathyCcipReadIsm.offchainUrlsLength();
        offChainUrls = new string[](len);
        for (uint256 i; i < len; i++) {
            offChainUrls[i] = telepathyCcipReadIsm.offchainUrls(i);
        }
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
        string[] memory offChainUrls = _copyUrls();
        bytes memory offChainLookupError = abi.encodeWithSelector(
            ICcipReadIsm.OffchainLookup.selector,
            address(telepathyCcipReadIsm),
            offChainUrls,
            _message,
            TelepathyCcipReadIsm.process.selector,
            _message
        );
        vm.expectRevert(offChainLookupError);
        telepathyCcipReadIsm.getOffchainVerifyInfo(_message);
    }

    function testTelepathyCcip_verify_correctStorageRoot() public {}
}
