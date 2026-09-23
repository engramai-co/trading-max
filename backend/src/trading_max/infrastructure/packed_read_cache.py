"""Bounded, temporary record cache for scans of immutable object packs.

Keep independently compressed records after a complete pack verification. A
random scan can then read a small record without decoding its entire cold pack
again. Nothing is persisted or trusted by the next verification operation.
"""

from __future__ import annotations

import hashlib
from collections import OrderedDict

import zstandard as zstd


class PackedReadCache:
    def __init__(self, max_bytes: int = 128 * 1024 * 1024):
        if max_bytes <= 0:
            raise ValueError("packed read cache budget must be positive")
        self.max_bytes = max_bytes
        self.bytes = 0
        self.blocks: OrderedDict[tuple, tuple[tuple, bytes, int]] = OrderedDict()

    def remember(self, identity: tuple, entries: dict, raw: bytes) -> None:
        compressor = zstd.ZstdCompressor(level=1, write_checksum=True)
        for key, (offset, size, digest) in entries.items():
            cache_key = (*identity, key)
            if cache_key in self.blocks:
                continue
            encoded = compressor.compress(raw[offset : offset + size])
            # Include a conservative allowance for Python keys, tuples and maps.
            cost = len(encoded) + len(key.encode()) + 512
            if cost > self.max_bytes:
                continue
            while self.blocks and self.bytes + cost > self.max_bytes:
                _, (_, _, evicted) = self.blocks.popitem(last=False)
                self.bytes -= evicted
            self.blocks[cache_key] = ((offset, size, digest), encoded, cost)
            self.bytes += cost

    def read(self, identity: tuple, claims: dict) -> dict[str, bytes]:
        result = {}
        for key, location in claims.items():
            cache_key = (*identity, key)
            cached = self.blocks.get(cache_key)
            if cached is None:
                continue
            self.blocks.move_to_end(cache_key)
            original, encoded, _ = cached
            if original != location:
                raise ValueError("object pack locator disagrees with sealed records")
            _, size, digest = original
            raw = zstd.ZstdDecompressor().decompress(
                encoded, max_output_size=max(1, size), allow_extra_data=False
            )
            if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError("cached packed record checksum mismatch")
            result[key] = raw
        return result
