fn main() {
    abigen::generate_bindings_for_dir("abis", "src/contracts", abigen::BuildType::Starknet);
}
