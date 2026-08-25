// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {MockMailbox} from "./MockMailbox.sol";

/**
 * @title MockHyperlaneEnvironment
 * @notice Test fixture managing a 3-domain Hyperlane cross-chain test environment.
 */
contract MockHyperlaneEnvironment {
    uint32 public constant DOMAIN_HUB = 1000;
    uint32 public constant DOMAIN_SPOKE_A = 2000;
    uint32 public constant DOMAIN_SPOKE_B = 3000;

    MockMailbox public mailboxHub;
    MockMailbox public mailboxSpokeA;
    MockMailbox public mailboxSpokeB;

    constructor() {
        mailboxHub = new MockMailbox(DOMAIN_HUB);
        mailboxSpokeA = new MockMailbox(DOMAIN_SPOKE_A);
        mailboxSpokeB = new MockMailbox(DOMAIN_SPOKE_B);

        // Interconnect Mailboxes
        mailboxHub.setRemoteMailbox(DOMAIN_SPOKE_A, address(mailboxSpokeA));
        mailboxHub.setRemoteMailbox(DOMAIN_SPOKE_B, address(mailboxSpokeB));

        mailboxSpokeA.setRemoteMailbox(DOMAIN_HUB, address(mailboxHub));
        mailboxSpokeA.setRemoteMailbox(DOMAIN_SPOKE_B, address(mailboxSpokeB));

        mailboxSpokeB.setRemoteMailbox(DOMAIN_HUB, address(mailboxHub));
        mailboxSpokeB.setRemoteMailbox(DOMAIN_SPOKE_A, address(mailboxSpokeA));
    }

    function setAutoRelay(bool enabled) external {
        mailboxHub.setAutoRelay(enabled);
        mailboxSpokeA.setAutoRelay(enabled);
        mailboxSpokeB.setAutoRelay(enabled);
    }

    function relayAll() external {
        mailboxHub.relayAll();
        mailboxSpokeA.relayAll();
        mailboxSpokeB.relayAll();
    }
}
