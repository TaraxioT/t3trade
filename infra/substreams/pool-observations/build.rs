fn main() {
    substreams_ethereum::Abigen::new("PoolEvents", "abi/pool-events.json")
        .expect("failed to load the pool events ABI")
        .generate()
        .expect("failed to generate ABI bindings")
        .write_to_file("src/abi/pool_events.rs")
        .expect("failed to write ABI bindings");

    prost_build::compile_protos(&["proto/pool.proto"], &["proto/"]).unwrap();
}
