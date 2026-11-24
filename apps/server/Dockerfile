# Build from the repository root:
#   docker build -f apps/server/Dockerfile -t termindo-server .
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
# Plain RUN (no BuildKit cache mounts) so it also builds with the classic builder.
RUN cargo build --release --locked -p termindo-server \
 && cp target/release/termindo-server /termindo-server

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 termindo
COPY --from=build /termindo-server /usr/local/bin/termindo-server
USER termindo
ENV TERMINDO_BIND=0.0.0.0:8080 \
    RUST_LOG=info
EXPOSE 8080
CMD ["termindo-server"]
