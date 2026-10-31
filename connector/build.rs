fn main() -> Result<(), Box<dyn std::error::Error>> {
    let descriptors = protox::compile(["relay.proto"], ["../protocol"])?;
    prost_build::compile_fds(descriptors)?;
    println!("cargo:rerun-if-changed=../protocol/relay.proto");
    Ok(())
}
