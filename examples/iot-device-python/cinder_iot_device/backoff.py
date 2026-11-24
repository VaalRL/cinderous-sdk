"""斷線分類與重連間隔（SDK ADR 0049 §10.2；與 TypeScript `src/iot/device-backoff.ts` 相同）。

重點：「額度用完」睡到重置時間、「設定錯誤」每 60 分鐘探測一次，只有網路斷才快速重連——
用固定 10 秒重連在額度用完時會把隔天的額度也燒掉。
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional

QUOTA_JITTER_MS = 20 * 60_000
PROBE_INTERVAL_MS = 60 * 60_000
REPLACED_RETRY_MS = 60_000
MIN_RETRY_MS = 1_000
# 任何狀態下最多等多久（程式碼審查 2026-11-18）：惡意或有 bug 的 relay 給很遠的 reset 不能讓設備睡好幾天
MAX_RETRY_MS = 25 * 3_600_000
_RELAY_ERROR = (5_000, 600_000)
_NETWORK_DOWN = (1_000, 60_000)
_CONFIG_TOKENS = re.compile(r"\b(iot-token|iot-home|iot-device|iot-disabled|iot-path|iot-upgrade):", re.ASCII)
_DAY = 86_400


@dataclass(frozen=True)
class Disconnect:
    cls: str  # quota-exhausted | config-error | relay-error | network-down | replaced
    reset: Optional[int] = None
    retry_after_sec: Optional[int] = None

    def to_json_obj(self) -> dict[str, Any]:
        out: dict[str, Any] = {"class": self.cls}
        if self.reset is not None:
            out["reset"] = self.reset
        if self.retry_after_sec is not None:
            out["retryAfterSec"] = self.retry_after_sec
        return out


def _header(headers: Optional[Mapping[str, str]], name: str) -> Optional[str]:
    if not headers:
        return None
    for k, v in headers.items():
        if k.lower() == name.lower():
            return v
    return None


def _seconds(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    v = value.strip()
    # re.ASCII：Python 的 \d 預設也認其他文字的數字（例如「٣٠」），TypeScript 不認——跨語言要一致
    return int(v) if re.fullmatch(r"\d{1,10}", v, re.ASCII) else None


def classify_http(status: int, headers: Optional[Mapping[str, str]], body: str, now_sec: int) -> Disconnect:
    """升級（或 HTTP 輪詢）被拒。"""
    from_relay = _header(headers, "Cinder-Relay") == "1"
    retry_after = _seconds(_header(headers, "Retry-After"))
    if not from_relay:
        if status == 429 and "1027" in (body or ""):
            return Disconnect("quota-exhausted", reset=(now_sec // _DAY + 1) * _DAY)
        return Disconnect("relay-error")
    try:
        parsed = json.loads(body) if body else {}
    except ValueError:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    if status == 503 and _header(headers, "Cinder-Quota") is not None:
        r = parsed.get("reset")
        if isinstance(r, int) and not isinstance(r, bool) and 0 < r <= 2**53 - 1:
            reset: Optional[int] = r
        elif retry_after is not None:
            reset = now_sec + retry_after
        else:
            reset = None
        return Disconnect("quota-exhausted", reset=reset, retry_after_sec=retry_after)
    error = parsed.get("error") if isinstance(parsed.get("error"), str) else ""
    if status in (401, 403, 404, 409, 426) and (_CONFIG_TOKENS.search(error) or error == ""):
        return Disconnect("config-error")
    return Disconnect("relay-error", retry_after_sec=retry_after)


def classify_close(code: int, reason: str = "") -> Disconnect:
    if code == 4429:
        m = re.fullmatch(r"iot-quota:(\d{1,12})", reason or "", re.ASCII)
        return Disconnect("quota-exhausted", reset=int(m.group(1)) if m else None)
    if code == 4409:
        return Disconnect("replaced")
    return Disconnect("network-down")


def classify(observation: Mapping[str, Any], now_sec: int) -> Disconnect:
    """以向量的觀察格式分類：{kind: http|close|network|heartbeat-timeout, …}。"""
    kind = observation["kind"]
    if kind in ("network", "heartbeat-timeout"):
        return Disconnect("network-down")
    if kind == "close":
        return classify_close(observation["code"], observation.get("reason") or "")
    return classify_http(observation["status"], observation.get("headers") or {}, observation.get("body") or "", now_sec)


def _exponential(rng: tuple[int, int], attempt: int, random: float) -> int:
    lo, hi = rng
    a = math.floor(attempt) if isinstance(attempt, (int, float)) and math.isfinite(attempt) else 0
    base = min(hi, lo * 2 ** max(0, min(a, 30)))
    return math.floor(base * (0.7 + 0.6 * random))


def retry_delay_ms(d: Disconnect, attempt: int, now_sec: int, clock_synced: bool, random: float) -> int:
    """下一次連線前等多久（毫秒）。`random` ∈ [0, 1)。"""
    r = min(max(random, 0.0), 0.999999) if math.isfinite(random) else 0.0
    if d.cls == "quota-exhausted":
        if clock_synced and d.reset is not None:
            # 先把秒數夾在上限內再換成毫秒（與 TypeScript 相同順序）
            ms = min(d.reset - now_sec, MAX_RETRY_MS // 1000) * 1000 + math.floor(r * QUOTA_JITTER_MS)
        else:
            ms = PROBE_INTERVAL_MS
    elif d.cls == "config-error":
        ms = PROBE_INTERVAL_MS
    elif d.cls == "replaced":
        ms = REPLACED_RETRY_MS
    elif d.cls == "relay-error":
        ms = max(_exponential(_RELAY_ERROR, attempt, r), min(d.retry_after_sec or 0, PROBE_INTERVAL_MS // 1000) * 1000)
    else:
        ms = _exponential(_NETWORK_DOWN, attempt, r)
    return min(MAX_RETRY_MS, max(MIN_RETRY_MS, ms))
