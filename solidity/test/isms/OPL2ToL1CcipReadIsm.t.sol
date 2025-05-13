// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {MockOptimismPortal} from "../../contracts/mock/MockOptimism.sol";
import {OPL2ToL1Withdrawal} from "../../contracts/libs/OPL2ToL1Withdrawal.sol";
import {IOptimismPortal} from "../../contracts/interfaces/optimism/IOptimismPortal.sol";
import {OPL2ToL1CcipReadIsm} from "../../contracts/isms/hook/OPL2ToL1CcipReadIsm.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";

import {console} from "forge-std/console.sol";

contract OPL2ToL1CcipReadIsmTest is Test {
    uint32 internal origin = 1;
    uint32 internal destination = 2;

    string[] internal urls;
    OPL2ToL1CcipReadIsm internal ism;
    MockOptimismPortal internal portal;
    MockHyperlaneEnvironment internal environment;
    MockMailbox mailboxOrigin;
    MockMailbox mailboxDestination;

    address internal vtbOrigin = address(10);
    address internal hookOrigin = address(11);
    address internal vtbDestination = address(12);
    uint256 internal transferAmount = 0.001 ether;
    uint256 internal gasLimit = 50_000;

    function setUp() public {
        urls = new string[](1);
        urls[0] = "https://ccip-server-gateway.io";

        environment = new MockHyperlaneEnvironment(origin, destination);
        mailboxOrigin = environment.mailboxes(origin);
        mailboxDestination = environment.mailboxes(destination);

        portal = new MockOptimismPortal();
        ism = new OPL2ToL1CcipReadIsm(
            urls,
            address(portal),
            address(mailboxDestination)
        );
    }

    function expectInvalidWithdrawalHashRevert(
        bytes32 invalidHash,
        bytes32 expectedHash
    ) private {
        vm.expectRevert(
            abi.encodeWithSelector(
                OPL2ToL1CcipReadIsm.InvalidWithdrawalHash.selector,
                invalidHash,
                expectedHash
            )
        );
    }

    function getDummyVerifyMetadata(
        IOptimismPortal.WithdrawalTransaction memory _tx
    ) private returns (bytes memory) {
        uint256 gameIndex = 0;
        IOptimismPortal.OutputRootProof memory outputRootProof;
        bytes[] memory proof;
        return abi.encode(_tx, gameIndex, outputRootProof, proof);
    }

    function testFuzz_verify_revertWhen_differentWithdrawalHashes(
        int32 seed
    ) public {
        IOptimismPortal.WithdrawalTransaction
            memory invalidWithdrawalTx = IOptimismPortal.WithdrawalTransaction(
                0, // nonce;
                vtbOrigin,
                vtbDestination,
                transferAmount,
                gasLimit,
                bytes("") // data
            );

        bytes32 invalidWithdrawalHash = OPL2ToL1Withdrawal.hashWithdrawal(
            invalidWithdrawalTx
        );
        bytes32 withdrawalHash = keccak256(abi.encode(seed));

        vm.assume(withdrawalHash != invalidWithdrawalHash);

        mailboxOrigin.dispatch(
            destination,
            TypeCasts.addressToBytes32(address(ism)),
            abi.encode(withdrawalHash) // messageBody
        );

        uint256 nonce = mailboxDestination.inboundProcessedNonce();
        bytes memory message = mailboxDestination.inboundMessages(nonce);
        bytes memory metadata = getDummyVerifyMetadata(invalidWithdrawalTx);

        expectInvalidWithdrawalHashRevert(
            invalidWithdrawalHash,
            withdrawalHash
        );
        ism.verify(metadata, message);
    }
}
