// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.0;

import {Test} from "forge-std/Test.sol";
import "forge-std/console.sol";

import {LibBit} from "../../contracts/libs/LibBit.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {CCIPIsm} from "../../contracts/isms/hook/CCIPIsm.sol";
import {CCIPHook} from "../../contracts/hooks/CCIPHook.sol";
import {eXRD, ERC20Mintable, IERC20} from "../../contracts/eXRD.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {HypFiatToken} from "../../contracts/token/extensions/HypFiatToken.sol";

contract eXRDTest is Test {
    using TypeCasts for address;
    using TokenMessage for bytes;
    using Message for bytes;

    // Hyperlane setup
    uint32 constant ETHEREUM_DOMAIN_ID = 1;
    uint32 constant RADIX_DOMAIN_ID = 1633970780;
    address constant DUMMY_RADIX_REMOTE_ROUTER_ADDRESS = address(0x420);
    uint256 constant RADIX_REMOTE_ROUTER_GAS = 300_000;
    address constant ETH_MAILBOX_ADDRESS =
        0xc005dc82818d67AF737725bD4bf75435d065D239;

    // Radix setup
    //  https://etherscan.io/address/0x6468e79A80C0eaB0F9A2B574c8d5bC374Af59414
    address internal eXRDAdress = 0x6468e79A80C0eaB0F9A2B574c8d5bC374Af59414;
    eXRD internal eXRDContract = eXRD(eXRDAdress);
    address eXRD_CURRENT_OWNER = 0xeA21b954301eBA217574b2031C2496d9D13027fa;

    // Variables
    HypFiatToken internal hypFiat;
    uint256 internal mainnetFork;
    address constant DUMMY_RECIPIENT = address(0x42069);

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"));

        deployHypFiat();
        grantMinterRoleToHypFiat();

        // for sending value
        vm.deal(ETH_MAILBOX_ADDRESS, 2 ** 255);
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployHypFiat() public {
        vm.selectFork(mainnetFork);

        hypFiat = new HypFiatToken(
            address(eXRDContract),
            uint256(1),
            ETH_MAILBOX_ADDRESS
        );

        hypFiat.enrollRemoteRouter(
            RADIX_DOMAIN_ID,
            DUMMY_RADIX_REMOTE_ROUTER_ADDRESS.addressToBytes32()
        );

        hypFiat.setDestinationGas(RADIX_DOMAIN_ID, RADIX_REMOTE_ROUTER_GAS);
    }

    function grantMinterRoleToHypFiat() public {
        vm.prank(eXRD_CURRENT_OWNER);
        ERC20Mintable(eXRDAdress).addMinter(address(hypFiat));
    }

    ///////////////////////////////////////////////////////////////////
    ///                         FORK TESTS                          ///
    ///////////////////////////////////////////////////////////////////

    /* ============ HypFiatToken.handle ============ */
    function testFork_handleIncomingMessage() public {
        vm.selectFork(mainnetFork);

        assertEq(eXRDContract.balanceOf(DUMMY_RECIPIENT), 0);

        bytes memory tokenMessage = abi.encodePacked(
            DUMMY_RECIPIENT.addressToBytes32(),
            uint256(1)
        );

        vm.prank(ETH_MAILBOX_ADDRESS);
        hypFiat.handle(
            RADIX_DOMAIN_ID,
            address(DUMMY_RADIX_REMOTE_ROUTER_ADDRESS).addressToBytes32(),
            tokenMessage
        );

        assertEq(eXRDContract.balanceOf(DUMMY_RECIPIENT), 1);
    }

    function testFork_transferRemoteToRadix() public {
        // Receive some funds from radix first
        vm.selectFork(mainnetFork);
        uint256 amount = 100;
        bytes memory tokenMessage = abi.encodePacked(
            DUMMY_RECIPIENT.addressToBytes32(),
            uint256(amount)
        );

        vm.prank(ETH_MAILBOX_ADDRESS);
        hypFiat.handle(
            RADIX_DOMAIN_ID,
            address(DUMMY_RADIX_REMOTE_ROUTER_ADDRESS).addressToBytes32(),
            tokenMessage
        );

        assertEq(eXRDContract.balanceOf(DUMMY_RECIPIENT), amount);

        // actual Test
        vm.startPrank(DUMMY_RECIPIENT);
        eXRDContract.approve(address(hypFiat), amount);

        hypFiat.transferRemote(
            RADIX_DOMAIN_ID,
            DUMMY_RECIPIENT.addressToBytes32(),
            amount
        );
        vm.stopPrank();
    }
}
