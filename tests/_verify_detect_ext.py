# -*- coding: utf-8 -*-
import sys
sys.path.insert(0, r".")
from ai_generator.base import detect_image_ext

cases = [
    (b"\x89PNG\r\n\x1a\n" + b"\x00" * 8, ".png"),
    (b"\xff\xd8\xff\xe0" + b"\x00" * 8, ".jpg"),
    (b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 8, ".webp"),
    (b"GIF89a\x00\x00\x00\x00", ".gif"),
    (b"BM\x00\x00\x00\x00\x00\x00", ".bmp"),
    (b"not an image at all", ".png"),
]
ok = True
for raw, want in cases:
    got = detect_image_ext(raw)
    status = "OK" if got == want else "FAIL"
    if got != want:
        ok = False
    print(f"{status} {raw[:10]!r} -> {got} (want {want})")
print("ALL PASS" if ok else "HAS FAILURES")
