fn main() {
    abigen::generate_bindings_for_dir("./abis", "./src/contracts", abigen::BuildType::Fuels);

    cynic_codegen::register_schema("fuel")
        .from_sdl_file("./src/indexer/query/schemas/fuel.graphql")
        .unwrap()
        .as_default()
        .unwrap();
}
