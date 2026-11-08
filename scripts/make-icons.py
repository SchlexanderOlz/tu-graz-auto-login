#!/usr/bin/env python3
"""Draws the extension icon (a key with a small "2") as PNGs. Stdlib only.

Deliberately unlike the TU Graz logo: no square/dot pattern, no TU Graz red.
Run: python3 scripts/make-icons.py
"""
import math
import struct
import zlib
from pathlib import Path

BG = (35, 87, 168)      # #2357a8
FG = (255, 255, 255)
SS = 4                  # supersampling factor


def inside(x, y):
    """Return 'bg', 'fg' or None for a point in unit coordinates (0..1)."""
    # rounded-square background
    r = 0.2
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
        return None
    # key head: ring
    hx, hy = 0.33, 0.42
    d = math.hypot(x - hx, y - hy)
    if 0.085 <= d <= 0.19:
        return 'fg'
    # shaft
    if 0.47 <= x <= 0.84 and 0.385 <= y <= 0.455:
        return 'fg'
    # teeth
    if 0.66 <= x <= 0.72 and 0.455 <= y <= 0.57:
        return 'fg'
    if 0.77 <= x <= 0.84 and 0.455 <= y <= 0.62:
        return 'fg'
    # small "2" at the bottom left, drawn as strokes
    if two(x, y):
        return 'fg'
    return 'bg'


def two(x, y):
    # box for the digit
    x0, y0, w, h, t = 0.2, 0.62, 0.2, 0.25, 0.045
    u, v = (x - x0) / w, (y - y0) / h
    if not (0 <= u <= 1 and 0 <= v <= 1):
        return False
    tu, tv = t / w, t / h
    # top arc (upper half ring)
    ax, ay, rad = 0.5, 0.3, 0.3
    du, dv = u - ax, (v - ay) * (h / w)
    dist = math.hypot(du, dv)
    if v <= ay + 0.05 and abs(dist - rad) <= tu / 2 + 0.02 and not (u < 0.3 and v > ay):
        return True
    # diagonal from right side of arc to bottom left
    px, py, qx, qy = 0.8, 0.38, 0.05, 0.95
    lx, ly = qx - px, qy - py
    s = max(0, min(1, ((u - px) * lx + (v - py) * ly) / (lx * lx + ly * ly)))
    if math.hypot((u - (px + s * lx)) * w, (v - (py + s * ly)) * h) <= t / 2:
        return True
    # bottom bar
    if v >= 1 - tv and 0.02 <= u <= 0.98:
        return True
    return False


def render(size):
    rows = []
    n = size * SS
    for py in range(size):
        row = bytearray([0])  # filter type 0
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    x = (px * SS + sx + 0.5) / n
                    y = (py * SS + sy + 0.5) / n
                    k = inside(x, y)
                    if k:
                        c = FG if k == 'fg' else BG
                        acc[0] += c[0]
                        acc[1] += c[1]
                        acc[2] += c[2]
                        acc[3] += 255
            cnt = SS * SS
            a = acc[3] // cnt
            if a:
                # un-premultiply: average colour over covered samples
                cov = acc[3] // 255
                row += bytes([acc[0] // cov, acc[1] // cov, acc[2] // cov, a])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    raw = b''.join(rows)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


if __name__ == '__main__':
    out = Path(__file__).resolve().parent.parent / 'icons'
    out.mkdir(exist_ok=True)
    for s in (16, 32, 48, 128):
        (out / f'icon{s}.png').write_bytes(render(s))
        print(f'icons/icon{s}.png')
