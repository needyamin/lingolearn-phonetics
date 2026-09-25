"""Generate Microsoft Store tile assets at their exact required pixel sizes.

The Windows Store rejects a package whose tile images are not the dimensions the
manifest declares, so each slot needs its own correctly sized file rather than a
single square PNG copied everywhere.

Usage:
    python scripts/make-store-tiles.py <source-icon.png> <output-assets-dir>

Requires Pillow (`pip install Pillow`).
"""

import os
import struct
import sys

from PIL import Image

# filename -> (width, height), per the Windows app tile requirements
TILES = {
    "StoreLogo.png": (50, 50),
    "Square44x44Logo.png": (44, 44),
    "Square71x71Logo.png": (71, 71),
    "Square150x150Logo.png": (150, 150),
    "Wide310x150Logo.png": (310, 150),
    "SplashScreen.png": (620, 300),
}

# Matches BackgroundColor="#111111" in the generated AppxManifest.
BACKGROUND = (17, 17, 17, 255)

# These three are shown on the Store listing and in the taskbar; keep them
# flattened so they never render with unexpected transparency.
FLATTEN = {"StoreLogo.png", "Square44x44Logo.png", "Square71x71Logo.png"}


def contain_fit(img, width, height, background=BACKGROUND):
    """Scale the logo to fit inside (width, height) and centre it.

    Preserves aspect ratio, so the artwork is never stretched. Padding is filled
    with the tile background colour instead.
    """
    canvas = Image.new("RGBA", (width, height), background)
    scale = min(width / img.width, height / img.height)
    target = (max(1, int(img.width * scale)), max(1, int(img.height * scale)))
    scaled = img.resize(target, Image.LANCZOS)
    canvas.paste(scaled, ((width - target[0]) // 2, (height - target[1]) // 2), scaled)
    return canvas


def png_size(data):
    """Read width/height straight from the PNG IHDR chunk."""
    return struct.unpack(">I", data[16:20])[0], struct.unpack(">I", data[20:24])[0]


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2

    source, out_dir = sys.argv[1], sys.argv[2]
    if not os.path.isfile(source):
        print(f"Source icon not found: {source}", file=sys.stderr)
        return 1

    img = Image.open(source).convert("RGBA")
    os.makedirs(out_dir, exist_ok=True)

    for name, (width, height) in TILES.items():
        tile = contain_fit(img, width, height)
        if name in FLATTEN:
            tile = tile.convert("RGB")
        path = os.path.join(out_dir, name)
        tile.save(path, "PNG", optimize=True)

        actual = png_size(open(path, "rb").read())
        status = "ok" if actual == (width, height) else "MISMATCH"
        print(f"  {name:<24} {actual[0]}x{actual[1]} [{status}]")

    return 0


if __name__ == "__main__":
    sys.exit(main())
