"""C′ 即時通道的 Python 設備（SDK ADR 0049 §9；SDK ADR 0140）：一條常駐 `wss`，協定交給 `DeviceCore`。

- 連 `/iot/v1/dev/<homeTag>/<blindId>`，標頭 `Authorization: Bearer <權杖>`；**驗證伺服器憑證**
  （系統的 CA 憑證包；不釘單一 CA——Cloudflare 的邊緣憑證可能換 CA）。
- 應用層心跳 `{"t":"hb"}` 每 30 秒；10 秒內沒收到 `{"t":"hb-ack"}` 就判定死線、重連
  （Cloudflare 可能不送 close frame）。不用 websockets 的協定 ping（relay 那邊是設定自動回覆的字串）。
- 斷線依 §10.2 分類退讓（`backoff.py`）：額度用完睡到重置、設定錯誤每 60 分鐘探測、網路斷才快速重連；
  有備援站時，額度用完或升級失敗就換下一站。
"""

from __future__ import annotations

import asyncio
import logging
import random
import ssl
from dataclasses import dataclass, field
from typing import Callable, Optional, Sequence

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from . import protocol
from .backoff import Disconnect, classify_close, classify_http, retry_delay_ms
from .core import DeviceCore, StateInput

log = logging.getLogger("cinder_iot_device")

HEARTBEAT_SEC = 30.0
HEARTBEAT_TIMEOUT_SEC = 10.0


@dataclass
class LinkEvent:
    state: str  # connecting | connected | quota-exhausted | config-error | relay-error | network-down | replaced | closed
    url: str
    retry_in_ms: Optional[int] = None
    reset: Optional[int] = None


@dataclass
class DeviceRunner:
    core: DeviceCore
    urls: Sequence[str]
    token: str
    clock_synced: Callable[[], bool] = lambda: True
    now_ms: Callable[[], int] = field(default=lambda: 0)
    heartbeat_sec: float = HEARTBEAT_SEC
    heartbeat_timeout_sec: float = HEARTBEAT_TIMEOUT_SEC
    on_link: Optional[Callable[[LinkEvent], None]] = None
    ssl_context: Optional[ssl.SSLContext] = None
    rng: random.Random = field(default_factory=random.SystemRandom)

    def __post_init__(self) -> None:
        self._ws: Optional[ClientConnection] = None
        self._stop = asyncio.Event()
        self._hb_ack = asyncio.Event()
        self._connected = False

    # ── 對外 ──
    async def publish_state(self, state: StateInput, will: Optional[bool] = None) -> bool:
        """回報狀態；沒有連線時回 False（即時通道不排隊）。"""
        ws = self._ws
        if ws is None:
            return False
        frame = self.core.state_frame(state, will)
        if frame is None:
            return False
        await ws.send(frame)
        return True

    def stop(self) -> None:
        self._stop.set()
        ws = self._ws
        if ws is not None:
            asyncio.get_running_loop().create_task(ws.close(1000, "closed"))

    async def run(self) -> None:
        index, attempt, last_class = 0, 0, ""
        while not self._stop.is_set():
            url = self.urls[index]
            self._emit(LinkEvent("connecting", url))
            self._connected = False
            outcome = await self._session(url)
            if self._stop.is_set():
                break
            # 這次有連上過 ⇒ 從頭退避（連上之後才斷，不算「連續失敗」）
            attempt = attempt + 1 if outcome.cls == last_class and not self._connected else 0
            last_class = outcome.cls
            if outcome.cls in ("quota-exhausted", "relay-error", "config-error") and len(self.urls) > 1:
                index = (index + 1) % len(self.urls)
                delay = 1_000 if outcome.cls == "quota-exhausted" else retry_delay_ms(outcome, attempt, self.now_ms() // 1000, self.clock_synced(), self.rng.random())
            else:
                delay = retry_delay_ms(outcome, attempt, self.now_ms() // 1000, self.clock_synced(), self.rng.random())
            self._emit(LinkEvent(outcome.cls, url, retry_in_ms=delay, reset=outcome.reset))
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay / 1000)
            except asyncio.TimeoutError:
                pass
        self._emit(LinkEvent("closed", self.urls[index]))

    # ── 內部 ──
    def _emit(self, ev: LinkEvent) -> None:
        if self.on_link:
            try:
                self.on_link(ev)
            except Exception:  # noqa: BLE001
                log.exception("on_link 失敗")

    def _ssl_for(self, url: str) -> Optional[ssl.SSLContext]:
        if not url.startswith("wss://"):
            return None
        return self.ssl_context or ssl.create_default_context()  # 驗證憑證與主機名稱

    async def _session(self, url: str) -> Disconnect:
        now_sec = self.now_ms() // 1000
        try:
            ws = await connect(
                url,
                additional_headers={"Authorization": f"Bearer {self.token}"},
                ssl=self._ssl_for(url),
                ping_interval=None,  # 用應用層心跳（relay 的自動回覆字串），不用協定 ping
                open_timeout=15,
                max_size=protocol.FRAME_MAX_BYTES,
                compression=None,
            )
        except InvalidStatus as error:
            r = error.response
            body = bytes(r.body or b"").decode("utf-8", "replace")
            return classify_http(r.status_code, dict(r.headers.raw_items()), body, now_sec)
        except (OSError, asyncio.TimeoutError, InvalidHandshake):
            return Disconnect("network-down")
        self._ws = ws
        self._connected = True
        self._emit(LinkEvent("connected", url))
        heartbeat = asyncio.create_task(self._heartbeat(ws))
        try:
            async for message in ws:
                if self._stop.is_set():
                    break
                if message == protocol.HEARTBEAT_ACK:
                    self._hb_ack.set()
                    continue
                for frame in self.core.handle(message):
                    await ws.send(frame)
        except ConnectionClosed:
            pass
        finally:
            heartbeat.cancel()
            self._ws = None
        if self._stop.is_set():
            await ws.close(1000, "closed")
            return Disconnect("network-down")
        rcvd = ws.protocol.close_rcvd
        if rcvd is not None:
            return classify_close(rcvd.code, rcvd.reason)
        return Disconnect("network-down")

    async def _heartbeat(self, ws: ClientConnection) -> None:
        try:
            while True:
                await asyncio.sleep(self.heartbeat_sec)
                self._hb_ack.clear()
                await ws.send(protocol.HEARTBEAT)
                try:
                    await asyncio.wait_for(self._hb_ack.wait(), timeout=self.heartbeat_timeout_sec)
                except asyncio.TimeoutError:
                    log.warning("心跳逾時，重連")
                    await ws.close(4000, "heartbeat timeout")
                    return
        except (asyncio.CancelledError, ConnectionClosed):
            return

