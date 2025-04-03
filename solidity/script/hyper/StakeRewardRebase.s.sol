// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {HyperToken} from "../../contracts/token/extensions/HyperToken.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";

import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {IVault} from "../../contracts/interfaces/network/vault/IVault.sol";

import "forge-std/StdCheats.sol";

contract StakeRewardRebase is Script, StdCheats {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    string STAKE_RPC_URL = vm.envString("STAKE_RPC_URL");
    string REBASE_RPC_URL = vm.envString("REBASE_RPC_URL");

    address WARP_ROUTE_ADDRESS = vm.envAddress("WARP_ROUTE_ADDRESS");

    uint256 stakeFork;
    uint32 stakeDomainId;
    HyperToken public collateral;

    uint256 rebaseFork;
    uint32 rebaseDomainId;
    HypERC20 public synthetic;

    uint256 BALANCE = 1_000_000e18; // 1 million tokens, adjust decimals as needed

    function setUp() public {
        stakeFork = vm.createSelectFork(STAKE_RPC_URL);
        collateral = HyperToken(WARP_ROUTE_ADDRESS);
        deal(
            address(collateral),
            address(this), // sender
            BALANCE
        );

        stakeDomainId = collateral.localDomain();
        address stakeMailbox = address(collateral.mailbox());
        vm.etch(stakeMailbox, address(new MockMailbox(stakeDomainId)).code);

        rebaseFork = vm.createSelectFork(REBASE_RPC_URL);
        rebaseDomainId = uint32(block.chainid);

        vm.selectFork(stakeFork);
        synthetic = HypERC20(
            collateral.routers(rebaseDomainId).bytes32ToAddress()
        );

        vm.selectFork(rebaseFork);
        address rebaseMailbox = address(synthetic.mailbox());
        vm.etch(rebaseMailbox, address(new MockMailbox(rebaseDomainId)).code);
        MockMailbox(rebaseMailbox).addRemoteMailbox(
            stakeDomainId,
            MockMailbox(stakeMailbox)
        );
        vm.makePersistent(rebaseMailbox);

        vm.selectFork(stakeFork);
        MockMailbox(stakeMailbox).addRemoteMailbox(
            rebaseDomainId,
            MockMailbox(rebaseMailbox)
        );
        vm.makePersistent(stakeMailbox);
    }

    function run() external {
        vm.selectFork(stakeFork);
        uint256 fee = collateral.quoteGasPayment(rebaseDomainId);
        vm.deal(address(this), fee);
        collateral.transferRemote{value: fee}(
            rebaseDomainId,
            msg.sender.addressToBytes32(),
            1000
        );

        vm.selectFork(rebaseFork);
        MockMailbox(address(synthetic.mailbox())).handleNextInboundMessage();
        assert(synthetic.balanceOf(msg.sender) == 1000);
    }
}
