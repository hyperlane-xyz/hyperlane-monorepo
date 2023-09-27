FUNCTION=$1

LN1_EXAMPLES_ADDRESS="0xd1eaef049ac77e63f2ffefae43e14c1a73700f25cde849b6614dc3f3580123fc"
LN1_IGPS_ADDRESS="0xc5cb1f1ce6951226e9c46ce8d42eda1ac9774a0fef91e2910939119ef0c95568"
LN1_ISMS_ADDRESS="0x6bbae7820a27ff21f28ba5a4b64c8b746cdd95e2b3264a686dd15651ef90a2a1"
LN1_LIBRARY_ADDRESS="0xe818394d0f37cd6accd369cdd4e723c8dc4f9b8d2517264fec3d9e8cabc66541"
LN1_MAILBOX_ADDRESS="0x476307c25c54b76b331a4e3422ae293ada422f5455efed1553cf4de1222a108f"
LN1_ROUTER_ADDRESS="0xafce3ab5dc5d513c13e746cef4d65bf54f4abdcb34ea8ab0728d01c035610e3d"
LN1_VALIDATOR_ANNOUNCE_ADDRESS="0xa4a4eb4bab83650ba62cabe9ce429ad021b29c12f2fbf808768838255c7e191d"

LN2_EXAMPLES_ADDRESS="0xb2586f8d1347b988157b9e7aaea24d19064dfb596835145db1f93ff931948732"
# [178,88,111,141,19,71,185,136,21,123,158,122,174,162,77,25,6,77,251,89,104,53,20,93,177,249,63,249,49,148,135,50]
LN2_IGPS_ADDRESS="0xea7d568d0705450331a8f09fd1c823faec91f4ef1c7e6ed4b12c0c53d0c08bc8"
LN2_ISMS_ADDRESS="0x39a36a558e955f29f60f9e7ad7e391510fcd6a744d8aec9b86952106bfc3e5e2"
LN2_LIBRARY_ADDRESS="0xc29e4ea7972150a5f3bd6531eba94907ce2be3b47eb17eaee40d381d2fd9122c"
LN2_MAILBOX_ADDRESS="0xd338e68ca12527e77cab474ee8ec91ffa4e6512ced9ae8f47e28c5c7c4804b78"
LN2_ROUTER_ADDRESS="0xd85669f567da6d24d296dccb7a7bfa1c666530eeb0e7b294791094e7a2dce8e3"
LN2_VALIDATOR_ANNOUNCE_ADDRESS="0xce1f65297828eaa6e460724a869317154f05cdde26619c0e5c0ca23aac3f69c7"

LN1_VALIDATOR_SIGNER_ADDRESS="0x21779477148b80ec9e123cc087a04ebbfb4a9de0ba64aa8f31510a0266423bb9"
LN1_VALIDATOR_ETH_ADDY="0x04e7bc384e10353c714327f7b85b3d0ceb52bf6d"
LN1_RELAYER_SIGNER_ADDRESS="0x8b4376073a408ece791f4adc34a8afdde405bae071711dcbb95ca4e5d4f26c93"

LN2_VALIDATOR_SIGNER_ADDRESS="0xef7adb55757d157d1a1f76d5d04806aba4f9099a32260b9356d6dd53c177cd1e"
LN2_VALIDATOR_ETH_ADDY="0x8a9f9818b6ba031c5f2c8baf850942d4c98fa2ee"
LN2_RELAYER_SIGNER_ADDRESS="0xcc7867910e0c3a1b8f304255123a4459c0222c78987d628f1effbf122f436b7b"

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

  # setting router
  L1_ROUTER_CAP="$LN1_EXAMPLES_ADDRESS::hello_world::HelloWorld"
  # enroll ln2 router
  cd ../router && aptos move run --assume-yes --function-id $LN1_ROUTER_ADDRESS::router::enroll_remote_router --type-args $L1_ROUTER_CAP --args u32:$APTOSLOCALNET2_DOMAIN "u8:[178,88,111,141,19,71,185,136,21,123,158,122,174,162,77,25,6,77,251,89,104,53,20,93,177,249,63,249,49,148,135,50]" --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet1/examples-keypair.json"

  cd ../mailbox && aptos move run --assume-yes --function-id $LN1_MAILBOX_ADDRESS::mailbox::initialize --args u32:$APTOSLOCALNET1_DOMAIN --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet1/mailbox-keypair.json"
  
  # set ln2 validator to ism
  cd ../isms && aptos move run --assume-yes --function-id $LN1_ISMS_ADDRESS::multisig_ism::set_validators_and_threshold --args 'address:["'$LN2_VALIDATOR_ETH_ADDY'"]' u64:1 u32:$APTOSLOCALNET2_DOMAIN  --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet1/isms-keypair.json"
}

function init_ln2_modules() {  
  # To make use of aptos cli
  export PATH="/root/.local/bin:$PATH"

  cd "$(pwd)"
  # init validator
  cd ../validator-announce && aptos move run --assume-yes --function-id $LN2_VALIDATOR_ANNOUNCE_ADDRESS::validator_announce::initialize --args address:$LN2_MAILBOX_ADDRESS u32:$APTOSLOCALNET2_DOMAIN --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet2/validator-announce-keypair.json"

  # setting router
  L2_ROUTER_CAP="$LN2_EXAMPLES_ADDRESS::hello_world::HelloWorld"
  # enroll ln1 router
  cd ../router && aptos move run --assume-yes --function-id $LN2_ROUTER_ADDRESS::router::enroll_remote_router --type-args $L2_ROUTER_CAP --args u32:$APTOSLOCALNET1_DOMAIN "u8:[209,234,239,4,154,199,126,99,242,255,239,174,67,225,76,26,115,112,15,37,205,232,73,182,97,77,195,243,88,1,35,252]" --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet2/examples-keypair.json"

  cd ../mailbox && aptos move run --assume-yes --function-id $LN2_MAILBOX_ADDRESS::mailbox::initialize --args u32:$APTOSLOCALNET2_DOMAIN --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet2/mailbox-keypair.json"
  
  # set ln1 validator to ism
  cd ../isms && aptos move run --assume-yes --function-id $LN2_ISMS_ADDRESS::multisig_ism::set_validators_and_threshold --args 'address:["'$LN1_VALIDATOR_ETH_ADDY'"]' u64:1 u32:$APTOSLOCALNET1_DOMAIN  --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet2/isms-keypair.json"
}

function send_hello_ln1_to_ln2() {
  
  export PATH="/root/.local/bin:$PATH"

  cd "$(pwd)"

  cd ../examples && aptos move run --function-id $LN1_EXAMPLES_ADDRESS::hello_world::send_message --args u32:$APTOSLOCALNET2_DOMAIN string:"Hello World!" --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet1/examples-keypair.json" --assume-yes
}
function send_hello_ln2_to_ln1() {
  
  export PATH="/root/.local/bin:$PATH"

  cd "$(pwd)"

  cd ../examples && aptos move run --function-id $LN2_EXAMPLES_ADDRESS::hello_world::send_message --args u32:$APTOSLOCALNET1_DOMAIN string:"Hello World!" --url $REST_API_URL --private-key-file "../e2e/aptos-test-keys/localnet2/examples-keypair.json" --assume-yes
}

#`address:0x1 bool:true u8:0 u256:1234 "bool:[true, false]" 'address:[["0xace", "0xbee"], []]'`

if [[ $FUNCTION == "" ]]; then
    echo "input function name"
else
    $FUNCTION
fi
