"""執行期：計數器存檔、SNTP 解析與時鐘守門、WebSocket 連線與 §10.2 退讓（以本機的假 relay 測）。"""

from __future__ import annotations

import asyncio
import json
import math
import struct
import time

import pytest
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from cinder_iot_device import crypto, protocol
from cinder_iot_device.clock import NTP_EPOCH_OFFSET, ClockGuard, parse_sntp_response
from cinder_iot_device.core import CommandResult, DeviceCore
from cinder_iot_device.counter import FileCounterStore, MemoryCounterStore
from cinder_iot_device.device import DeviceRunner

KEY = bytes(range(32))
TOKEN = "cit1_" + "A" * 43


# ── 計數器 ──


def test_file_counter_persists_and_never_goes_back(tmp_path):
    path = str(tmp_path / "ctr")
    store = FileCounterStore(path)
    assert store.load() == 0
    store.save(5)
    assert FileCounterStore(path).load() == 5


def test_file_counter_reserve_skips_forward_after_reboot(tmp_path):
    path = str(tmp_path / "ctr")
    store = FileCounterStore(path, reserve=10)
    store.load()
    for n in range(1, 4):
        store.save(n)
    # 只寫了一次（預留到 10）；重開機從 10 往上，絕不倒退
    assert FileCounterStore(path).load() == 10


def test_core_saves_counter_before_sending():
    saved = []

    class Store(MemoryCounterStore):
        def save(self, ctr):
            saved.append(ctr)
            super().save(ctr)

    core = DeviceCore(kid="lamp.0", device_key=KEY, counter_store=Store(7), on_command=lambda c: CommandResult("ok"), now_ms=lambda: 1_800_000_000_000)
    frame = core.state_frame({"home/lamp/state": "ON"})
    env = protocol.parse_frame(frame, "device")[1]
    assert saved == [8] and env.ctr == 8
    assert json.loads(crypto.open_envelope(env, KEY)) == {"type": "state", "topics": {"home/lamp/state": {"payload": "ON", "ts": 1_800_000_000_000}}}


# ── 時鐘 ──


def _sntp_reply(server_time: float, li: int = 0, stratum: int = 2) -> bytes:
    secs = int(server_time) + NTP_EPOCH_OFFSET
    frac = int((server_time % 1) * 2**32)
    head = bytes([(li << 6) | (4 << 3) | 4, stratum]) + b"\x00" * 30
    return head + struct.pack("!IIII", secs, frac, secs, frac)


def test_sntp_offset():
    now = 1_800_000_000.0
    assert parse_sntp_response(_sntp_reply(now + 120), now, now) == pytest.approx(120, abs=1e-6)
    with pytest.raises(ValueError):
        parse_sntp_response(_sntp_reply(now, li=3), now, now)  # 伺服器自己沒同步
    with pytest.raises(ValueError):
        parse_sntp_response(_sntp_reply(now, stratum=0), now, now)
    with pytest.raises(ValueError):
        parse_sntp_response(b"\x00" * 10, now, now)


def test_clock_guard_fail_closed_until_synced_and_expires():
    mono = {"t": 0.0}

    def failing(_server):
        raise OSError("timeout")

    g = ClockGuard(servers=["a"], query=failing, monotonic=lambda: mono["t"], wall=lambda: 1000.0, max_age_sec=60)
    assert not g.synced() and not g.sync() and not g.synced()
    g = ClockGuard(servers=["a", "b"], query=lambda s: 5.0 if s == "b" else failing(s), monotonic=lambda: mono["t"], wall=lambda: 1000.0, max_age_sec=60)
    assert g.sync() and g.synced()
    assert g.now_ms() == 1_005_000  # 用校正後的時間
    mono["t"] = 61
    assert not g.synced()  # 太久沒同步：回到 fail-closed


def test_unsynced_clock_rejects_commands():
    now_ms = 1_800_000_000_000
    core = DeviceCore(kid="lamp.0", device_key=KEY, counter_store=MemoryCounterStore(), on_command=lambda c: pytest.fail("不該執行"), now_ms=lambda: now_ms, clock_synced=lambda: False)
    msg = protocol.dumps({"type": "cmd", "msgId": "m" * 16, "topic": "a", "payload": "ON", "enc": "utf8", "exp": now_ms // 1000 + 10})
    frame = protocol.encode_frame("cmd", crypto.seal_envelope(KEY, "lamp.0", "down", 1, now_ms // 1000, msg))
    [out] = core.handle(frame)
    assert json.loads(crypto.open_envelope(protocol.parse_frame(out, "device")[1], KEY))["reason"] == "clock-unsynced"


# ── WebSocket：本機假 relay ──


def _core(commands):
    def on_command(cmd):
        commands.append(cmd)
        return CommandResult("ok", state={cmd.topic: cmd.payload})

    return DeviceCore(kid="lamp.0", device_key=KEY, counter_store=MemoryCounterStore(), on_command=on_command, now_ms=lambda: int(time.time() * 1000))


async def test_runner_roundtrip_with_auth_header_and_heartbeat():
    commands, got = [], {}
    done = asyncio.Event()

    async def relay(ws):
        got["auth"] = ws.request.headers.get("Authorization")
        now = math.floor(time.time())
        msg = protocol.dumps({"type": "cmd", "msgId": "x" * 16, "topic": "home/lamp/power", "payload": "ON", "enc": "utf8", "exp": now + 15})
        await ws.send(protocol.encode_frame("cmd", crypto.seal_envelope(KEY, "lamp.0", "down", 1, now, msg)))
        async for frame in ws:
            if frame == protocol.HEARTBEAT:
                got["hb"] = True
                await ws.send(protocol.HEARTBEAT_ACK)
                if "ack" in got:
                    done.set()
                continue
            t, env = protocol.parse_frame(frame, "device")
            got["ack"] = json.loads(crypto.open_envelope(env, KEY))
            if got.get("hb"):
                done.set()

    async with serve(relay, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        runner = DeviceRunner(core=_core(commands), urls=[f"ws://127.0.0.1:{port}/iot/v1/dev/h/b"], token=TOKEN, heartbeat_sec=0.05, now_ms=lambda: int(time.time() * 1000))
        task = asyncio.create_task(runner.run())
        await asyncio.wait_for(done.wait(), 5)
        runner.stop()
        await asyncio.wait_for(task, 5)
    assert got["auth"] == f"Bearer {TOKEN}"
    assert [c.payload for c in commands] == ["ON"]
    assert got["ack"]["status"] == "ok" and got["ack"]["topics"]["home/lamp/power"]["payload"] == "ON"


async def _first_outcome(process_request=None, handler=None):
    events = []
    seen = asyncio.Event()

    def on_link(ev):
        events.append(ev)
        if ev.state not in ("connecting", "connected"):
            seen.set()

    async def default_handler(ws):
        await ws.wait_closed()

    async with serve(handler or default_handler, "127.0.0.1", 0, process_request=process_request) as server:
        port = server.sockets[0].getsockname()[1]
        runner = DeviceRunner(core=_core([]), urls=[f"ws://127.0.0.1:{port}/x"], token=TOKEN, on_link=on_link, now_ms=lambda: 1_800_000_000_000)
        task = asyncio.create_task(runner.run())
        await asyncio.wait_for(seen.wait(), 5)
        runner.stop()
        await asyncio.wait_for(task, 5)
    return next(e for e in events if e.state not in ("connecting", "connected"))


def _reject(status, body, **headers):
    def process_request(connection, request):
        h = Headers({"Content-Type": "application/json", **headers})
        return Response(status, "Error", h, json.dumps(body).encode())

    return process_request


async def test_upgrade_rejected_token_is_config_error_probe_hourly():
    ev = await _first_outcome(_reject(401, {"error": "restricted: iot-token: device token missing or wrong"}, **{"Cinder-Relay": "1"}))
    assert ev.state == "config-error" and ev.retry_in_ms == 3_600_000


async def test_upgrade_503_quota_sleeps_until_reset_plus_jitter():
    reset = 1_800_000_000 + 3600
    ev = await _first_outcome(_reject(503, {"error": "rate-limited: iot-quota: x", "reset": reset}, **{"Cinder-Relay": "1", "Cinder-Quota": "home-budget", "Retry-After": "3600"}))
    assert ev.state == "quota-exhausted" and ev.reset == reset
    assert 3_600_000 <= ev.retry_in_ms < 3_600_000 + 20 * 60_000


async def test_close_4429_is_quota_and_4409_is_replaced():
    async def quota(ws):
        await ws.close(4429, "iot-quota:1800003600")

    async def replaced(ws):
        await ws.close(4409, "replaced")

    ev = await _first_outcome(handler=quota)
    assert ev.state == "quota-exhausted" and ev.reset == 1_800_003_600
    ev = await _first_outcome(handler=replaced)
    assert ev.state == "replaced" and ev.retry_in_ms == 60_000


async def test_unreachable_is_network_down_fast_retry():
    events, seen = [], asyncio.Event()

    def on_link(ev):
        events.append(ev)
        if ev.state == "network-down":
            seen.set()

    runner = DeviceRunner(core=_core([]), urls=["ws://127.0.0.1:9/x"], token=TOKEN, on_link=on_link, now_ms=lambda: 0)
    task = asyncio.create_task(runner.run())
    await asyncio.wait_for(seen.wait(), 15)
    runner.stop()
    await asyncio.wait_for(task, 5)
    ev = next(e for e in events if e.state == "network-down")
    assert 1_000 <= ev.retry_in_ms <= 1_300
