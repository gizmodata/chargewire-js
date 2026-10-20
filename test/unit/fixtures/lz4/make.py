# Makes the LZ4 fixtures for test/unit/lz4.test.ts with real LZ4 implementations: the lz4
# CLI (reference implementation) and pyarrow (Arrow C++, which is what servers use).
#   python -I test/unit/fixtures/lz4/make.py   (needs `lz4` on PATH and pyarrow)
# server_lz4_frame.arrows is not made here: it is a Hardcharger result, captured with curl
# (see the test), because it has buffers left uncompressed (length -1), which pyarrow
# does not write.
import pathlib
import subprocess
import tempfile

import pyarrow as pa
import pyarrow.ipc as ipc

here = pathlib.Path(__file__).parent


def plaintext() -> bytes:
    """The same bytes as plaintext() in lz4.test.ts: incompressible, text, runs, a pattern."""
    x = 1
    out = bytearray()

    def rand() -> int:
        nonlocal x
        x = (x * 1103515245 + 12345) & 0x7FFFFFFF
        return x >> 16

    for _ in range(70_000):
        out.append(rand() & 0xFF)
    words = [b"warp", b"sql", b"arrow", b"lz4", b"frame", b"block", b"hardcharger", b"duckdb", b"zstd", b"batch"]
    while len(out) < 70_000 + 150_000:
        out += words[rand() % len(words)] + b" "
    out += bytes(90_000)
    out += bytes(range(40)) * 1_500
    return bytes(out)


def lz4_cli(name: str, data: bytes, *flags: str) -> None:
    # From a file, not stdin: the CLI writes the content size only when it knows it.
    with tempfile.TemporaryDirectory() as tmp:
        source = pathlib.Path(tmp) / "data"
        source.write_bytes(data)
        result = subprocess.run(["lz4", "-c", "-q", *flags, str(source)], capture_output=True, check=True)
    (here / name).write_bytes(result.stdout)


data = plaintext()
(here / "arrow.lz4").write_bytes(pa.compress(data, codec="lz4", asbytes=True))
(here / "arrow_empty.lz4").write_bytes(pa.compress(b"", codec="lz4", asbytes=True))
lz4_cli("independent_checksums.lz4", data, "-BI", "-BX", "-B4", "--content-size")
lz4_cli("linked_256k_no_checksum.lz4", data, "-BD", "-B5", "--no-frame-crc")
lz4_cli("empty.lz4", b"")

# An Arrow IPC stream with LZ4_FRAME buffers, written by Arrow C++.
n = 3000
table = pa.table(
    {
        "i": pa.array(range(n), type=pa.int64()),
        "d": pa.array([i * 1.5 for i in range(n)], type=pa.float64()),
        "s": pa.array([None if i % 3 == 0 else f"v{i}" for i in range(n)], type=pa.string()),
        "b": pa.array([i % 2 == 0 for i in range(n)], type=pa.bool_()),
    }
)
with pa.OSFile(str(here / "pyarrow_lz4.arrows"), "wb") as f:
    with ipc.new_stream(f, table.schema, options=ipc.IpcWriteOptions(compression="lz4")) as w:
        for batch in table.to_batches(max_chunksize=1000):
            w.write_batch(batch)
