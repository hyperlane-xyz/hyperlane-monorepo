// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import "forge-std/Test.sol";

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {TestMailbox} from "@hyperlane-xyz/core/contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "@hyperlane-xyz/core/contracts/test/TestPostDispatchHook.sol";
import {TypeCasts} from "@hyperlane-xyz/core/contracts/libs/TypeCasts.sol";

import {ERC721Test} from "../contracts/test/ERC721Test.sol";
import {TokenRouter} from "../contracts/libs/TokenRouter.sol";
import {HypERC721} from "../contracts/HypERC721.sol";
import {HypERC721Collateral} from "../contracts/HypERC721Collateral.sol";

abstract contract HypTokenTest is Test {
    using TypeCasts for address;

    uint256 internal constant INITIAL_SUPPLY = 10;
    string internal constant NAME = "Hyperlane Hedgehogs";
    string internal constant SYMBOL = "HHH";

    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 22;
    uint256 internal constant TRANSFER_ID = 0;

    ERC721Test internal localPrimaryToken =
        new ERC721Test(NAME, SYMBOL, INITIAL_SUPPLY * 2);
    ERC721Test internal remotePrimaryToken =
        new ERC721Test(NAME, SYMBOL, INITIAL_SUPPLY * 2);
    TestMailbox internal localMailbox;
    TestMailbox internal remoteMailbox;
    TokenRouter internal localToken;
    TokenRouter internal remoteToken;
    TestPostDispatchHook internal noopHook;

    function setUp() public virtual {
        noopHook = new TestPostDispatchHook();

        localMailbox = new TestMailbox(ORIGIN);
        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));

        remoteMailbox = new TestMailbox(DESTINATION);

        remoteToken = new HypERC721Collateral(address(remotePrimaryToken));
    }

    function _deployRemoteToken(bool isCollateral) internal {
        if (isCollateral) {
            remoteToken = new HypERC721Collateral(address(remotePrimaryToken));
            HypERC721Collateral(address(remoteToken)).initialize(
                address(remoteMailbox)
            );
            remotePrimaryToken.transferFrom(
                address(this),
                address(remoteToken),
                0
            ); // need for processing messages
        } else {
            remoteToken = new HypERC721();
            HypERC721(address(remoteToken)).initialize(
                address(remoteMailbox),
                0,
                NAME,
                SYMBOL
            );
        }
        remoteToken.enrollRemoteRouter(
            ORIGIN,
            address(localToken).addressToBytes32()
        );
    }

    function _processTransfers(address _recipient, uint256 _tokenId) internal {
        vm.prank(address(remoteMailbox));
        remoteToken.handle(
            ORIGIN,
            address(localToken).addressToBytes32(),
            abi.encodePacked(_recipient.addressToBytes32(), _tokenId)
        );
    }

    function _expectTransferRemote(uint256 _msgValue, uint256 _tokenId) public {
        localToken.transferRemote{value: _msgValue}(
            DESTINATION,
            ALICE.addressToBytes32(),
            _tokenId
        );

        _processTransfers(BOB, _tokenId);
        assertEq(remoteToken.balanceOf(BOB), 1);
    }

    function testBenchmark_overheadGasUsage() public {
        vm.prank(address(localMailbox));

        uint256 gasBefore = gasleft();
        localToken.handle(
            DESTINATION,
            address(remoteToken).addressToBytes32(),
            abi.encodePacked(BOB.addressToBytes32(), INITIAL_SUPPLY + 1)
        );
        uint256 gasAfter = gasleft();
        console.log("Overhead gas usage: %d", gasBefore - gasAfter);
    }
}

contract HypERC721Test is HypTokenTest, IERC721Receiver {
    using TypeCasts for address;

    HypERC721 internal hyp721;

    function setUp() public override {
        super.setUp();

        localToken = new HypERC721();
        hyp721 = HypERC721(address(localToken));

        hyp721.initialize(address(localMailbox), INITIAL_SUPPLY, NAME, SYMBOL);

        hyp721.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
    }

    function testInitialize_revert_ifAlreadyInitialized() public {
        vm.expectRevert("Initializable: contract is already initialized");
        hyp721.initialize(address(localMailbox), INITIAL_SUPPLY, NAME, SYMBOL);
    }

    function testTotalSupply() public {
        assertEq(hyp721.balanceOf(address(this)), INITIAL_SUPPLY);
    }

    function testLocalTransfer() public {
        hyp721.transferFrom(address(this), ALICE, 0);
        assertEq(hyp721.balanceOf(address(this)), INITIAL_SUPPLY - 1);
        assertEq(hyp721.balanceOf(ALICE), 1);
    }

    function testLocalYTransfer_revert_invalidTokenId() public {
        vm.expectRevert("ERC721: invalid token ID");
        hyp721.transferFrom(address(this), ALICE, INITIAL_SUPPLY);
    }

    function testRemoteTransfer(bool isCollateral) public {
        _deployRemoteToken(isCollateral);
        _expectTransferRemote(25000, 0);
        assertEq(hyp721.balanceOf(address(this)), INITIAL_SUPPLY - 1);
    }

    function testRemoteTransfer_revert_unowned() public {
        hyp721.transferFrom(address(this), BOB, 1);

        _deployRemoteToken(false);
        vm.expectRevert("!owner");
        _expectTransferRemote(25000, 1);
        assertEq(hyp721.balanceOf(address(this)), INITIAL_SUPPLY - 1);
    }

    function testRemoteTransfer_revert_invalidTokenId() public {
        _deployRemoteToken(false);
        vm.expectRevert("ERC721: invalid token ID");
        _expectTransferRemote(25000, INITIAL_SUPPLY);
        assertEq(hyp721.balanceOf(address(this)), INITIAL_SUPPLY);
    }

    function onERC721Received(
        address, /*operator*/
        address, /*from*/
        uint256, /*tokenId*/
        bytes calldata /*data*/
    ) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract HypERC721CollateralTest is HypTokenTest {
    using TypeCasts for address;

    HypERC721Collateral internal hyp721Collateral;

    function setUp() public override {
        super.setUp();

        localToken = new HypERC721Collateral(address(localPrimaryToken));
        hyp721Collateral = HypERC721Collateral(address(localToken));

        hyp721Collateral.initialize(address(localMailbox));

        hyp721Collateral.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );

        localPrimaryToken.transferFrom(
            address(this),
            address(hyp721Collateral),
            INITIAL_SUPPLY + 1
        );
        localPrimaryToken.ownerOf(0);
    }

    function testInitialize_revert_ifAlreadyInitialized() public {
        vm.expectRevert("Initializable: contract is already initialized");
        hyp721Collateral.initialize(ALICE);
    }

    function testRemoteTransfer(bool isCollateral) public {
        localPrimaryToken.ownerOf(0);
        localPrimaryToken.approve(address(hyp721Collateral), 0);
        _deployRemoteToken(isCollateral);
        _expectTransferRemote(25000, 0);
        assertEq(
            hyp721Collateral.balanceOf(address(this)),
            INITIAL_SUPPLY * 2 - 2
        );
    }

    function testRemoteTransfer_revert_unowned() public {
        localPrimaryToken.transferFrom(address(this), BOB, 1);

        _deployRemoteToken(false);
        vm.expectRevert("ERC721: caller is not token owner or approved");
        _expectTransferRemote(25000, 1);
        assertEq(
            hyp721Collateral.balanceOf(address(this)),
            INITIAL_SUPPLY * 2 - 2
        );
    }

    function testRemoteTransfer_revert_invalidTokenId() public {
        _deployRemoteToken(false);
        vm.expectRevert("ERC721: invalid token ID");
        _expectTransferRemote(25000, INITIAL_SUPPLY * 2);
        assertEq(
            hyp721Collateral.balanceOf(address(this)),
            INITIAL_SUPPLY * 2 - 1
        );
    }
}
