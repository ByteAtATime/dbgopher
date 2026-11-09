FROM rust:1.99-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY protocol protocol
COPY connector connector
RUN cargo build --release --locked --manifest-path connector/Cargo.toml

FROM scratch
COPY --from=build /src/connector/target/release/connector /connector
ENV CONNECTOR_STATE_DIR=/state
VOLUME /state
ENTRYPOINT ["/connector"]
