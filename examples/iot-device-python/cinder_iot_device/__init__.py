"""Cinderous IoT C′ 即時通道的 Python 參考設備（SDK ADR 0140）。

協定與 `@cinderous/client/iot/device` 相同，以 `tests/fixtures/iot-device-v1.vectors.json` 驗證。
"""

from .backoff import Disconnect, classify, classify_close, classify_http, retry_delay_ms
from .clock import ClockGuard
from .core import Command, CommandResult, DeviceCore
from .counter import FileCounterStore, MemoryCounterStore
from .crypto import (
    EnvelopeError,
    device_key,
    device_key_down,
    hash_token,
    open_envelope,
    seal_envelope,
    verify_token,
)

__all__ = [
    "ClockGuard",
    "Command",
    "CommandResult",
    "DeviceCore",
    "Disconnect",
    "EnvelopeError",
    "FileCounterStore",
    "MemoryCounterStore",
    "classify",
    "classify_close",
    "classify_http",
    "device_key",
    "device_key_down",
    "hash_token",
    "open_envelope",
    "retry_delay_ms",
    "seal_envelope",
    "verify_token",
]
