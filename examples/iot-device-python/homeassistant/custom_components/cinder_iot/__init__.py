"""Home Assistant 自訂整合（**骨架，未在 Home Assistant 裡實測**；SDK ADR 0140）。

用途：把一台 HA 主機變成 Cinderous C′ 的「設備」——手機經 relay 送來的指令，轉成呼叫 HA 服務；
HA 實體的狀態變化，以 25172 回報給全家。協定全部交給 `cinder_iot_device`（以 SDK 的測試向量驗證過）。

設定（configuration.yaml；秘密放 secrets.yaml）：

    cinder_iot:
      url: wss://relay.example/iot/v1/dev/<homeTag>/<blindId>
      token: !secret cinder_iot_token        # cit1_…
      kid: lamp.0
      device_key: !secret cinder_iot_key     # 64 位 hex
      topics:                                # topic → HA 實體（只有列在這裡的才會被操作）
        home/lamp/power: light.living_room

時鐘：HA OS 由系統做 NTP，所以 `trust_system_clock`；自己跑在沒有 NTP 的主機上請改用 `ClockGuard().sync()`。
門鎖類（`device_key_down`）請勿在沒有實體鑰匙等本地開啟方式的門上使用（ADR 0049 §10.5）。
"""

from __future__ import annotations

import asyncio
import logging

from homeassistant.const import EVENT_HOMEASSISTANT_STOP  # type: ignore[import-not-found]
from homeassistant.core import HomeAssistant  # type: ignore[import-not-found]

from cinder_iot_device import ClockGuard, Command, CommandResult, DeviceCore, FileCounterStore
from cinder_iot_device.device import DeviceRunner

DOMAIN = "cinder_iot"
_LOGGER = logging.getLogger(__name__)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    conf = config.get(DOMAIN)
    if not conf:
        return True
    topics: dict[str, str] = dict(conf.get("topics", {}))
    clock = ClockGuard(trust_system_clock=True)

    def on_command(cmd: Command) -> CommandResult:
        entity_id = topics.get(cmd.topic)
        if entity_id is None:
            return CommandResult("unknown-topic")
        service = "turn_on" if cmd.payload.upper() in ("ON", "1", "TRUE", "開") else "turn_off"
        domain = entity_id.split(".", 1)[0]
        # DeviceCore 是同步的；排進 HA 的事件迴圈執行，ack 先回「已受理」的狀態
        hass.add_job(hass.services.async_call(domain, service, {"entity_id": entity_id}))
        return CommandResult("ok", state={cmd.topic: cmd.payload})

    def on_query() -> dict[str, str]:
        out: dict[str, str] = {}
        for topic, entity_id in topics.items():
            st = hass.states.get(entity_id)
            if st is not None:
                out[topic] = st.state
        return out

    core = DeviceCore(
        kid=conf["kid"],
        device_key=bytes.fromhex(conf["device_key"]),
        device_key_down=bytes.fromhex(conf["device_key_down"]) if conf.get("device_key_down") else None,
        counter_store=FileCounterStore(hass.config.path(".storage", f"cinder_iot_{conf['kid']}.ctr")),
        on_command=on_command,
        on_query=on_query,
        now_ms=clock.now_ms,
        clock_synced=clock.synced,
        max_skew_sec=int(conf.get("max_skew_sec", 60)),
    )
    runner = DeviceRunner(core=core, urls=[conf["url"], *conf.get("standby_urls", [])], token=conf["token"], clock_synced=clock.synced, now_ms=clock.now_ms)
    task = hass.loop.create_task(runner.run())

    async def on_state_changed(event) -> None:
        entity_id = event.data.get("entity_id")
        new = event.data.get("new_state")
        for topic, eid in topics.items():
            if eid == entity_id and new is not None:
                await runner.publish_state({topic: new.state})

    hass.bus.async_listen("state_changed", on_state_changed)

    async def stop(_event) -> None:
        runner.stop()
        await asyncio.wait([task], timeout=5)

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, stop)
    _LOGGER.info("cinder_iot 已啟動（%s，%d 個 topic）", conf["kid"], len(topics))
    return True


__all__ = ["DOMAIN", "async_setup"]
