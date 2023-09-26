FUNCTION=$1

LN1_EXAMPLES_ADDRESS="0xd1eaef049ac77e63f2ffefae43e14c1a73700f25cde849b6614dc3f3580123fc"
LN1_IGPS_ADDRESS="0xc5cb1f1ce6951226e9c46ce8d42eda1ac9774a0fef91e2910939119ef0c95568"
LN1_ISMS_ADDRESS="0x6bbae7820a27ff21f28ba5a4b64c8b746cdd95e2b3264a686dd15651ef90a2a1"
LN1_LIBRARY_ADDRESS="0xe818394d0f37cd6accd369cdd4e723c8dc4f9b8d2517264fec3d9e8cabc66541"
LN1_MAILBOX_ADDRESS="0x476307c25c54b76b331a4e3422ae293ada422f5455efed1553cf4de1222a108f"
LN1_ROUTER_ADDRESS="0xafce3ab5dc5d513c13e746cef4d65bf54f4abdcb34ea8ab0728d01c035610e3d"
LN1_VALIDATOR_ANNOUNCE_ADDRESS="0xa4a4eb4bab83650ba62cabe9ce429ad021b29c12f2fbf808768838255c7e191d"

LN2_EXAMPLES_ADDRESS="0xb2586f8d1347b988157b9e7aaea24d19064dfb596835145db1f93ff931948732"
LN2_IGPS_ADDRESS="0xea7d568d0705450331a8f09fd1c823faec91f4ef1c7e6ed4b12c0c53d0c08bc8"
LN2_ISMS_ADDRESS="0x39a36a558e955f29f60f9e7ad7e391510fcd6a744d8aec9b86952106bfc3e5e2"
LN2_LIBRARY_ADDRESS="0xc29e4ea7972150a5f3bd6531eba94907ce2be3b47eb17eaee40d381d2fd9122c"
LN2_MAILBOX_ADDRESS="0xd338e68ca12527e77cab474ee8ec91ffa4e6512ced9ae8f47e28c5c7c4804b78"
LN2_ROUTER_ADDRESS="0xd85669f567da6d24d296dccb7a7bfa1c666530eeb0e7b294791094e7a2dce8e3"
LN2_VALIDATOR_ANNOUNCE_ADDRESS="0xce1f65297828eaa6e460724a869317154f05cdde26619c0e5c0ca23aac3f69c7"

APTOSDEVNET_DOMAIN=14477
APTOSTESTNET_DOMAIN=14402
APTOSLOCALNET1_DOMAIN=14411
APTOSLOCALNET2_DOMAIN=14412
BSCTESTNET_DOMAIN=97

REST_API_URL="http://0.0.0.0:8080/v1"
# VALIDATOR_ETH_SIGNER="0x598264ff31f198f6071226b2b7e9ce360163accd"

# inits
function init_ln1_modules() {  
  # To make use of aptos cli
  export PATH="/root/.local/bin:$PATH"

  cd "$(pwd)"
  # init validator
  cd ../validator-announce && aptos move run --assume-yes --function-id $LN1_VALIDATOR_ANNOUNCE_ADDRESS::validator_announce::initialize --args address:$LN1_MAILBOX_ADDRESS u32:$APTOSLOCALNET1_DOMAIN --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet1/validator-announce-keypair.json"

  cd ../mailbox && aptos move run --assume-yes --function-id $LN1_MAILBOX_ADDRESS::mailbox::initialize --args u32:$APTOSLOCALNET1_DOMAIN --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet1/mailbox-keypair.json"

  cd ../isms && aptos move run --assume-yes --function-id $LN1_ISMS_ADDRESS::multisig_ism::set_validators_and_threshold --args 'address:["0x598264ff31f198f6071226b2b7e9ce360163accd"]' u64:1 u32:$APTOSLOCALNET2_DOMAIN  --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet1/isms-keypair.json"
}

function init_ln2_modules() {  
  # To make use of aptos cli
  export PATH="/root/.local/bin:$PATH"

  cd "$(pwd)"
  # init validator
  cd ../validator-announce && aptos move run --assume-yes --function-id $LN2_VALIDATOR_ANNOUNCE_ADDRESS::validator_announce::initialize --args address:$LN2_MAILBOX_ADDRESS u32:$APTOSLOCALNET2_DOMAIN --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet2/validator-announce-keypair.json"

  cd ../mailbox && aptos move run --assume-yes --function-id $LN2_MAILBOX_ADDRESS::mailbox::initialize --args u32:$APTOSLOCALNET2_DOMAIN --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet2/mailbox-keypair.json"

  cd ../isms && aptos move run --assume-yes --function-id $LN2_ISMS_ADDRESS::multisig_ism::set_validators_and_threshold --args 'address:["0x598264ff31f198f6071226b2b7e9ce360163accd"]' u64:1 u32:$APTOSLOCALNET1_DOMAIN --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet2/isms-keypair.json"
}

function send_hello() {
  # 48656c6c6f20576f726c6421
  # 'u8:[0x48,0x65,0x6c,0x6c,0x6f,0x20,0x57,0x6f,0x72,0x6c,0x64,0x21]'
  cd examples && aptos move run --function-id $HELLO_WORLD_ADDRESS::hello_world::send_message --args u32:$BSCTESTNET_DOMAIN string:"Hello World!"
}

#`address:0x1 bool:true u8:0 u256:1234 "bool:[true, false]" 'address:[["0xace", "0xbee"], []]'`

if [[ $FUNCTION == "" ]]; then
    echo "input function name"
else
    $FUNCTION
fi
