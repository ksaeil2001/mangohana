#!/usr/bin/env python3
"""Generate Trio's approved concept 2 icon set deterministically.

The generated files are deliberately limited to the brand-owned paths under
the requested output root.  All validation happens before any output path is
created or replaced.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import struct
import sys
import tempfile
from pathlib import Path

try:
    import PIL
    from PIL import Image
except Exception as exc:  # pragma: no cover - exercised when Pillow is absent
    print(f"brand generation failed: Pillow import error ({exc.__class__.__name__})", file=sys.stderr)
    raise SystemExit(1)


EXPECTED_PILLOW_VERSION = "12.1.0"
EXPECTED_SOURCE_SHA256 = "08276cdab69d6d2da74d3b46134af812b4b1f130b8ac9eee2316c8c154473a08"
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = Path("build") / "brand" / "trio-concept-2-source.png"
DEFAULT_OUTPUT_ROOT = Path("build")
LINUX_SIZES = (16, 24, 32, 48, 64, 128, 256, 512)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS_REPRESENTATIONS = (
    (b"ic11", 32),
    (b"ic12", 64),
    (b"ic07", 128),
    (b"ic13", 256),
    (b"ic08", 256),
    (b"ic14", 512),
    (b"ic09", 512),
    (b"ic10", 1024),
)


def resolve_repo_path(path: Path) -> Path:
    return path if path.is_absolute() else REPO_ROOT / path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    args = parser.parse_args()
    args.source = resolve_repo_path(args.source)
    args.output_root = resolve_repo_path(args.output_root)
    return args


def png_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    # Explicitly use RGBA and fixed compression settings so Pillow's output is
    # stable across repeated runs with the pinned version.
    image.convert("RGBA").save(
        output,
        format="PNG",
        optimize=False,
        compress_level=9,
    )
    return output.getvalue()


def resized_rgba(image: Image.Image, size: int) -> Image.Image:
    resized = image.resize((size, size), resample=Image.Resampling.LANCZOS)
    # Rebuild from raw pixels to discard source metadata and keep all generated
    # PNGs in the same explicit RGBA mode.
    return Image.frombytes("RGBA", resized.size, resized.tobytes())


def build_ico(pngs: dict[int, bytes]) -> bytes:
    header = struct.pack("<HHH", 0, 1, len(ICO_SIZES))
    entries = bytearray()
    image_data = bytearray()
    image_offset = len(header) + 16 * len(ICO_SIZES)

    for size in ICO_SIZES:
        data = pngs[size]
        dimension = 0 if size == 256 else size
        entries.extend(
            struct.pack(
                "<BBBBHHII",
                dimension,
                dimension,
                0,
                0,
                1,
                32,
                len(data),
                image_offset,
            )
        )
        image_data.extend(data)
        image_offset += len(data)

    return bytes(header + entries + image_data)


def build_icns(pngs: dict[int, bytes]) -> bytes:
    chunks = [(chunk_type, pngs[size]) for chunk_type, size in ICNS_REPRESENTATIONS]
    toc_length = 8 + 8 * len(chunks)
    data_length = sum(8 + len(data) for _, data in chunks)
    total_length = 8 + toc_length + data_length

    output = bytearray()
    output.extend(b"icns")
    output.extend(struct.pack(">I", total_length))
    output.extend(b"TOC ")
    output.extend(struct.pack(">I", toc_length))
    for chunk_type, data in chunks:
        output.extend(chunk_type)
        output.extend(struct.pack(">I", 8 + len(data)))
    for chunk_type, data in chunks:
        output.extend(chunk_type)
        output.extend(struct.pack(">I", 8 + len(data)))
        output.extend(data)
    return bytes(output)


def validate_source(source_path: Path) -> tuple[bytes, Image.Image]:
    try:
        source_bytes = source_path.read_bytes()
    except OSError as exc:
        raise ValueError(f"source could not be read ({exc.__class__.__name__})") from exc

    source_sha256 = hashlib.sha256(source_bytes).hexdigest()
    if source_sha256 != EXPECTED_SOURCE_SHA256:
        raise ValueError("source SHA-256 does not match the approved concept 2 asset")

    try:
        with Image.open(io.BytesIO(source_bytes)) as image:
            image.load()
            if image.format != "PNG":
                raise ValueError("source must be a PNG")
            if image.mode != "RGBA":
                raise ValueError("source must be RGBA")
            if image.width != image.height or image.width < 1024:
                raise ValueError("source must be square and at least 1024x1024")
            source_image = Image.frombytes("RGBA", image.size, image.tobytes())
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"source PNG could not be decoded ({exc.__class__.__name__})") from exc

    return source_bytes, source_image


def validate_output_root(output_root: Path) -> None:
    if output_root.is_symlink():
        raise ValueError("output root must not be a symlink")
    if output_root.exists() and not output_root.is_dir():
        raise ValueError("output root must be a directory")
    parent = output_root.parent if output_root.parent != Path("") else Path(".")
    if parent.is_symlink():
        raise ValueError("output root parent must not be a symlink")
    if output_root.exists():
        for child_name in ("brand", "icons"):
            child = output_root / child_name
            if child.is_symlink():
                raise ValueError(f"output root {child_name} directory must not be a symlink")
            if child.exists() and not child.is_dir():
                raise ValueError(f"output root {child_name} path must be a directory")


def commit_outputs(output_root: Path, outputs: dict[Path, bytes]) -> None:
    parent = output_root.parent if output_root.parent != Path("") else Path(".")
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".trio-brand-", dir=parent) as staging_name:
        staging_root = Path(staging_name)
        for relative_path, data in outputs.items():
            staged_path = staging_root / relative_path
            staged_path.parent.mkdir(parents=True, exist_ok=True)
            staged_path.write_bytes(data)

        for relative_path in outputs:
            destination = output_root / relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staging_root / relative_path, destination)


def generate(source_path: Path, output_root: Path) -> None:
    if PIL.__version__ != EXPECTED_PILLOW_VERSION:
        raise ValueError(
            f"Pillow=={EXPECTED_PILLOW_VERSION} is required (found {PIL.__version__})"
        )

    validate_output_root(output_root)
    source_bytes, source_image = validate_source(source_path)
    master_image = resized_rgba(source_image, 1024)

    pngs = {size: png_bytes(resized_rgba(master_image, size)) for size in set(LINUX_SIZES) | {1024}}
    outputs: dict[Path, bytes] = {
        Path("brand/trio-concept-2-source.png"): source_bytes,
        Path("brand/trio-master-1024.png"): pngs[1024],
        Path("icon.ico"): build_ico(pngs),
        Path("icon.icns"): build_icns(pngs),
    }
    for size in LINUX_SIZES:
        outputs[Path("icons") / f"{size}x{size}.png"] = pngs[size]

    commit_outputs(output_root, outputs)


def main() -> int:
    args = parse_args()
    try:
        generate(args.source, args.output_root)
    except (OSError, ValueError) as exc:
        print(f"brand generation failed: {exc}", file=sys.stderr)
        return 1
    print(f"generated {len(LINUX_SIZES) + 4} deterministic brand outputs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
