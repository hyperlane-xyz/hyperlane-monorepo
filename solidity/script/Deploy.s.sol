// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.6.0;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "forge-std/StdJson.sol";

import {ICREATE3Factory} from "../lib/create3-factory/src/ICREATE3Factory.sol";

import {Mailbox} from "../contracts/Mailbox.sol";
import {BytesLib} from "../contracts/libs/BytesLib.sol";

contract Deploy is Script {
    using stdJson for string;
    using BytesLib for bytes;

    function getCreate3Factory(string memory network)
        internal
        view
        returns (ICREATE3Factory)
    {
        string memory file = string.concat(
            "lib/create3-factory/deployments/",
            network,
            ".json"
        );
        string memory json = vm.readFile(file);
        return
            ICREATE3Factory(
                abi.decode(vm.parseJson(json, "CREATE3Factory"), (address))
            );
    }

    function getDomainId(string memory network) internal view returns (uint32) {
        string memory json = vm.readFile("chains.json");
        return
            abi.decode(
                vm.parseJson(json, string.concat(network, ".id")),
                (uint32)
            );
    }

    struct MultisigIsmConfig {
        uint256 threshold;
        address[] validators;
    }

    function getMultisigIsmConfig(string memory network)
        internal
        view
        returns (MultisigIsmConfig memory)
    {
        string memory json = vm.readFile("validators.json");
        uint256 threshold = abi.decode(
            vm.parseJson(json, string.concat(network, ".threshold")),
            (uint256)
        );
        bytes memory validatorBytes = json.parseRaw(
            string.concat(network, ".validators[*].address")
        );
        uint256 numValidators = validatorBytes.length / 32;
        address[] memory validators = new address[](numValidators);
        for (uint256 i = 0; i < validators.length; i++) {
            validators[i] = abi.decode(
                validatorBytes.slice(i * 32, 32),
                (address)
            );
        }
        return MultisigIsmConfig(threshold, validators);
    }

    function run() public {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        string memory network = vm.envString("NETWORK");
        MultisigIsmConfig memory config = getMultisigIsmConfig(network);

        // string memory salt = vm.envString("SALT");
        bytes32 salt = keccak256("SALT");

        uint32 domain = getDomainId(network);
        ICREATE3Factory factory = getCreate3Factory(network);
        factory.deploy(
            salt,
            abi.encodePacked(type(Mailbox).creationCode, abi.encode(domain))
        );
    }
}
