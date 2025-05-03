// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {CommitmentReadIsm} from "../../contracts/isms/ccip-read/CommitmentReadIsm.sol";

import {CallLib} from "../../contracts/middleware/InterchainAccountRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract CommitmentReadIsmTest is Test {
    uint32 internal origin = 1;
    uint32 internal destination = 2;

    string[] internal urls;
    CommitmentReadIsm internal ism;
    MockHyperlaneEnvironment internal environment;
    MockMailbox mailboxOrigin;
    MockMailbox mailboxDestination;

    uint256 internal transferAmount = 0.001 ether;
    uint256 internal gasLimit = 50_000;

    function setUp() public {
        urls = new string[](1);
        urls[0] = "https://ccip-server-gateway.io";

        environment = new MockHyperlaneEnvironment(origin, destination);
        mailboxOrigin = environment.mailboxes(origin);
        mailboxDestination = environment.mailboxes(destination);
        ism = new CommitmentReadIsm(mailboxDestination);
        ism.setUrls(urls);
    }

    function testUrls() public {
        assertEq(urls.length, 1);
        assertEq(urls[0], "https://ccip-server-gateway.io");
    }

    /**
     * We don't need to test `verify` since it's well tested in InterchainAccountRouter.t.sol
     * when we test the message processing flow for commit/reveal messages.
     */
}
