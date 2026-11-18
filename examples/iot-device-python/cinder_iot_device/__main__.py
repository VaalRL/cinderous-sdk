"""`python -m cinder_iot_device`：以環境變數設定的示範設備（一盞「燈」：收到什麼就記成什麼狀態）。

環境變數（名稱與 `cinderous iot realtime device <id>` 的輸出相同）：

  IOT_DEVICE_URL           wss://<relay>/iot/v1/dev/<homeTag>/<IOT_DEVICE_BLIND_ID>
  IOT_DEVICE_STANDBY_URLS  （選用）備援站，逗號分隔（另一個 Cloudflare 帳號或家中 Node relay，§10.4）
  IOT_DEVICE_TOKEN         cit1_…
  IOT_DEVICE_KID           <設備 id>.<epoch>
  IOT_DEVICE_KEY           64 位 hex
  IOT_DEVICE_KEY_DOWN      （門鎖類）64 位 hex
  IOT_DEVICE_COUNTER_FILE  up 計數器存檔（預設 ./cinder-iot-counter）
  IOT_DEVICE_MAX_SKEW_SEC  信封時間窗，預設 60（門類建議 15）
  IOT_NTP_SERVERS          SNTP 伺服器，逗號分隔（預設 pool.ntp.org,time.cloudflare.com）
  IOT_TRUST_SYSTEM_CLOCK   1＝不做 SNTP、信任主機時鐘（主機已由作業系統做 NTP，或開發時）

每個事件以一行 JSON 印到 stdout（`{"event":"link",…}`、`{"event":"command",…}`），方便測試與整合。
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys

from .clock import ClockGuard
from .core import Command, CommandResult, DeviceCore
from .counter import FileCounterStore
from .crypto import parse_kid, token_valid
from .device import DeviceRunner, LinkEvent


def _say(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"缺少環境變數 {name}")
    return value


async def main() -> None:
    url = _require("IOT_DEVICE_URL")
    standby = [u.strip() for u in os.environ.get("IOT_DEVICE_STANDBY_URLS", "").split(",") if u.strip()]
    token = _require("IOT_DEVICE_TOKEN")
    kid = _require("IOT_DEVICE_KID")
    if not token_valid(token):
        sys.exit("IOT_DEVICE_TOKEN 格式不對（應為 cit1_ 開頭）")
    if parse_kid(kid) is None:
        sys.exit("IOT_DEVICE_KID 格式不對（<設備 id>.<epoch>）")
    key = bytes.fromhex(_require("IOT_DEVICE_KEY"))
    key_down_hex = os.environ.get("IOT_DEVICE_KEY_DOWN", "").strip()

    clock = ClockGuard(
        servers=[s.strip() for s in os.environ.get("IOT_NTP_SERVERS", "pool.ntp.org,time.cloudflare.com").split(",") if s.strip()],
        trust_system_clock=os.environ.get("IOT_TRUST_SYSTEM_CLOCK") == "1",
    )
    if not clock.synced() and not clock.sync():
        _say({"event": "clock", "synced": False})  # 照樣連線，但所有指令回 clock-unsynced（fail-closed）

    state: dict[str, str] = {}

    def on_command(cmd: Command) -> CommandResult:
        _say({"event": "command", **cmd.to_json_obj()})
        state[cmd.topic] = cmd.payload
        return CommandResult("ok", state={cmd.topic: cmd.payload})

    core = DeviceCore(
        kid=kid,
        device_key=key,
        device_key_down=bytes.fromhex(key_down_hex) if key_down_hex else None,
        counter_store=FileCounterStore(os.environ.get("IOT_DEVICE_COUNTER_FILE", "cinder-iot-counter")),
        on_command=on_command,
        on_query=lambda: dict(state),
        now_ms=clock.now_ms,
        clock_synced=clock.synced,
        max_skew_sec=int(os.environ.get("IOT_DEVICE_MAX_SKEW_SEC", "60")),
    )

    def on_link(ev: LinkEvent) -> None:
        _say({"event": "link", "state": ev.state, "url": ev.url, **({"retryInMs": ev.retry_in_ms} if ev.retry_in_ms is not None else {}), **({"reset": ev.reset} if ev.reset is not None else {})})

    runner = DeviceRunner(core=core, urls=[url, *standby], token=token, clock_synced=clock.synced, now_ms=clock.now_ms, on_link=on_link)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, runner.stop)
        except (NotImplementedError, RuntimeError):
            pass  # Windows：Ctrl+C 走 KeyboardInterrupt
    await runner.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
