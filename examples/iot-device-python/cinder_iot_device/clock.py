"""時鐘同步（SDK ADR 0049 §9.4）：設備開機到 SNTP 同步前**拒絕所有指令**（fail-closed）。

信封的 `ts` 時間窗（一般 ±60 秒、門類 ±15 秒）是「relay 惡意延遲轉送」的最後一道防線——
時鐘錯了，這道防線就沒了，所以「不確定時間」一律當作不同步。
"""

from __future__ import annotations

import asyncio
import socket
import struct
import time
from typing import Awaitable, Callable, Optional, Sequence

NTP_EPOCH_OFFSET = 2_208_988_800  # 1900-01-01 → 1970-01-01


def build_sntp_request() -> bytes:
    """SNTP v4 客戶端請求（LI=0、VN=4、Mode=3）。"""
    return b"\x23" + b"\x00" * 47


def parse_sntp_response(data: bytes, t_send: float, t_recv: float) -> float:
    """回時鐘偏移（秒；伺服器時間 − 本機時間）。格式不對或伺服器未同步（stratum 0／LI=3）丟 ValueError。"""
    if len(data) < 48:
        raise ValueError("SNTP 回應太短")
    li_vn_mode, stratum = data[0], data[1]
    if li_vn_mode & 0x07 not in (4, 5):
        raise ValueError("不是伺服器回應")
    if (li_vn_mode >> 6) == 3 or stratum == 0:
        raise ValueError("伺服器時鐘未同步")
    rx_s, rx_f, tx_s, tx_f = struct.unpack("!IIII", data[32:48])
    if tx_s == 0:
        raise ValueError("傳送時間為 0")
    t2 = rx_s - NTP_EPOCH_OFFSET + rx_f / 2**32
    t3 = tx_s - NTP_EPOCH_OFFSET + tx_f / 2**32
    return ((t2 - t_send) + (t3 - t_recv)) / 2


def sntp_offset(server: str, timeout: float = 3.0, port: int = 123) -> float:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        t_send = time.time()
        sock.sendto(build_sntp_request(), (server, port))
        data, _ = sock.recvfrom(512)
        t_recv = time.time()
    return parse_sntp_response(data, t_send, t_recv)


class ClockGuard:
    """記住最近一次 SNTP 結果；`now_ms()` 以偏移校正後的時間；超過 `max_age_sec` 沒同步就回到「不同步」。

    `trust_system_clock=True`：主機已由作業系統做 NTP（例如 Home Assistant OS、systemd-timesyncd）——
    只在開發或確定主機時鐘可信時用。
    """

    def __init__(
        self,
        servers: Sequence[str] = ("pool.ntp.org", "time.cloudflare.com"),
        max_age_sec: float = 24 * 3600,
        trust_system_clock: bool = False,
        query: Callable[[str], float] = sntp_offset,
        monotonic: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
    ) -> None:
        self._servers = list(servers)
        self._max_age = max_age_sec
        self._trust = trust_system_clock
        self._query = query
        self._monotonic = monotonic
        self._wall = wall
        self._offset = 0.0
        self._synced_at: Optional[float] = None

    def sync(self) -> bool:
        for server in self._servers:
            try:
                self._offset = self._query(server)
            except (OSError, ValueError):
                continue
            self._synced_at = self._monotonic()
            return True
        return False

    def due(self, refresh_sec: float) -> bool:
        """該重新同步了嗎（從沒同步過、或上次同步已超過 `refresh_sec`）。信任主機時鐘時永遠不用。"""
        if self._trust:
            return False
        return self._synced_at is None or self._monotonic() - self._synced_at >= refresh_sec

    async def keep_synced(
        self,
        refresh_sec: float = 6 * 3600,
        check_sec: float = 300.0,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        """背景工作：每 `check_sec` 檢查一次，該同步就同步（失敗下一輪再試）。永遠不會自己結束，取消它即可。

        🔴 程式碼審查 2026-11-18：原本只在開機同步一次，`max_age_sec`（24 小時）後變成「不同步」、
        之後所有指令都回 clock-unsynced——設備等於壞掉。`refresh_sec` 要比 `max_age_sec` 短，留時間重試。
        """
        while True:
            if self.due(refresh_sec):
                await asyncio.to_thread(self.sync)  # SNTP 是阻塞的 UDP：不要卡住事件迴圈（心跳、指令）
            await sleep(check_sec)

    def synced(self) -> bool:
        if self._trust:
            return True
        return self._synced_at is not None and self._monotonic() - self._synced_at <= self._max_age

    def now_ms(self) -> int:
        return int((self._wall() + (0.0 if self._trust else self._offset)) * 1000)
