"""Generate all app icons from the current Open Xiao official and nightly artwork."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
ICONS = ROOT / "src-tauri" / "icons"
ICONS_BETA = ROOT / "src-tauri" / "icons-beta"

OFFICIAL_SRC = PUBLIC / "logonew_offical.png"
NIGHTLY_SRC = PUBLIC / "logonew_nightly.png"


def load_square(src: Path) -> Image.Image:
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    if w != h:
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        im = im.crop((left, top, left + side, top + side))
    return im


def resize(im: Image.Image, size: int) -> Image.Image:
    return im.resize((size, size), Image.Resampling.LANCZOS)


def save_png(im: Image.Image, path: Path, size: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    out = resize(im, size) if size else im
    out.save(path, format="PNG", optimize=True)
    print(f"  wrote {path.relative_to(ROOT)} ({out.size[0]}x{out.size[1]})")


def png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def image_to_png_bytes(im: Image.Image) -> bytes:
    im = im.convert("RGBA")
    w, h = im.size
    raw = b""
    px = im.tobytes()
    stride = w * 4
    for y in range(h):
        raw += b"\x00" + px[y * stride : (y + 1) * stride]
    return b"".join(
        [
            b"\x89PNG\r\n\x1a\n",
            png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)),
            png_chunk(b"IDAT", zlib.compress(raw, 9)),
            png_chunk(b"IEND", b""),
        ]
    )


def save_ico(im: Image.Image, path: Path, sizes: list[int]) -> None:
    """Write multi-size ICO with embedded PNGs (Vista+)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    images = [resize(im, s) for s in sizes]
    count = len(images)
    offset = 6 + 16 * count
    entries = []
    payloads = []
    for img in images:
        data = image_to_png_bytes(img)
        w, h = img.size
        entries.append(
            struct.pack(
                "<BBBBHHII",
                w if w < 256 else 0,
                h if h < 256 else 0,
                0,
                0,
                1,
                32,
                len(data),
                offset,
            )
        )
        payloads.append(data)
        offset += len(data)
    blob = struct.pack("<HHH", 0, 1, count) + b"".join(entries) + b"".join(payloads)
    path.write_bytes(blob)
    print(f"  wrote {path.relative_to(ROOT)} ico sizes={sizes}")


def save_icns(im: Image.Image, path: Path) -> None:
    """Minimal ICNS covering common macOS icon slots."""
    path.parent.mkdir(parents=True, exist_ok=True)
    # type -> pixel size
    slots = [
        (b"icp4", 16),
        (b"icp5", 32),
        (b"icp6", 64),
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),  # 512@2x
        (b"ic11", 32),  # 16@2x
        (b"ic12", 64),  # 32@2x
        (b"ic13", 256),  # 128@2x
        (b"ic14", 512),  # 256@2x
    ]
    parts = []
    for tag, size in slots:
        data = image_to_png_bytes(resize(im, size))
        parts.append(tag + struct.pack(">I", len(data) + 8) + data)
    body = b"".join(parts)
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)
    print(f"  wrote {path.relative_to(ROOT)} icns")


def generate_public(official: Image.Image, nightly: Image.Image) -> None:
    print("public assets (stage-aware + defaults = official)")
    # Canonical names used by UI / favicon (default = official for static HTML)
    mapping = {
        "grok-logo.png": 512,
        "grok-icon.png": 512,
        "grok-icon-512.png": 512,
        "grok-512.png": 512,
        "grok-192.png": 192,
        "grok-apple.png": 180,
        "grok-favicon.png": 128,
        "grok-g.png": 256,
        "app-icon-official.png": 1024,
        "app-icon-nightly.png": 1024,
        "grok-logo-official.png": 512,
        "grok-logo-nightly.png": 512,
        "grok-favicon-official.png": 128,
        "grok-favicon-nightly.png": 128,
    }
    for name, size in mapping.items():
        src = nightly if "nightly" in name else official
        save_png(src, PUBLIC / name, size)

    # Root app-icon used by some tooling
    save_png(official, ROOT / "app-icon.png", 1024)

    # Favicon ico variants
    save_ico(official, PUBLIC / "grok-favicon.ico", [16, 32, 48, 64, 128, 256])
    save_ico(official, PUBLIC / "xai-favicon.ico", [16, 32, 48, 64, 128, 256])
    save_ico(nightly, PUBLIC / "grok-favicon-nightly.ico", [16, 32, 48, 64, 128, 256])


def generate_tauri_set(im: Image.Image, out_dir: Path) -> None:
    print(f"tauri icons -> {out_dir.relative_to(ROOT)}")
    sizes = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
        "StoreLogo.png": 50,
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
    }
    for name, size in sizes.items():
        save_png(im, out_dir / name, size)

    save_ico(im, out_dir / "icon.ico", [16, 24, 32, 48, 64, 128, 256])
    save_icns(im, out_dir / "icon.icns")

    # Android mipmaps
    android = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, size in android.items():
        base = out_dir / "android" / folder
        for name in (
            "ic_launcher.png",
            "ic_launcher_round.png",
            "ic_launcher_foreground.png",
        ):
            save_png(im, base / name, size)

    # iOS
    ios = {
        "AppIcon-20x20@1x.png": 20,
        "AppIcon-20x20@2x.png": 40,
        "AppIcon-20x20@2x-1.png": 40,
        "AppIcon-20x20@3x.png": 60,
        "AppIcon-29x29@1x.png": 29,
        "AppIcon-29x29@2x.png": 58,
        "AppIcon-29x29@2x-1.png": 58,
        "AppIcon-29x29@3x.png": 87,
        "AppIcon-40x40@1x.png": 40,
        "AppIcon-40x40@2x.png": 80,
        "AppIcon-40x40@2x-1.png": 80,
        "AppIcon-40x40@3x.png": 120,
        "AppIcon-60x60@2x.png": 120,
        "AppIcon-60x60@3x.png": 180,
        "AppIcon-76x76@1x.png": 76,
        "AppIcon-76x76@2x.png": 152,
        "AppIcon-83.5x83.5@2x.png": 167,
        "AppIcon-512@2x.png": 1024,
    }
    for name, size in ios.items():
        save_png(im, out_dir / "ios" / name, size)


def main() -> None:
    if not OFFICIAL_SRC.exists():
        raise SystemExit(f"missing {OFFICIAL_SRC}")
    if not NIGHTLY_SRC.exists():
        raise SystemExit(f"missing {NIGHTLY_SRC}")

    official = load_square(OFFICIAL_SRC)
    nightly = load_square(NIGHTLY_SRC)
    print("sources", official.size, nightly.size)

    generate_public(official, nightly)
    generate_tauri_set(official, ICONS)
    generate_tauri_set(nightly, ICONS_BETA)

    # Remove obsolete monochrome SVG logos so nothing keeps serving old mark.
    for obsolete in (
        PUBLIC / "grok-logo.svg",
        PUBLIC / "grok-mark.svg",
        PUBLIC / "tauri.svg",
        PUBLIC / "vite.svg",
    ):
        if obsolete.exists():
            obsolete.unlink()
            print(f"  removed {obsolete.relative_to(ROOT)}")

    print("done")


if __name__ == "__main__":
    main()
