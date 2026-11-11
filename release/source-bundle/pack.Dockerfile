# Packs a source bundle tree as a single-layer image for the sources package.
# Build context: the bundle folder.
FROM scratch
COPY . /covalink-sources/
