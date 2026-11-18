"""設備的協定核心（sans-IO）：收一則 relay 幀、回要送出的幀（SDK ADR 0049 §9.4；與 `connectIotDevice` 相同行為）。

不碰網路、不碰時鐘（全部注入）——所以可以直接用測試向量的「設備行為」情境逐位元組驗證，
再由 `device.py` 接上 WebSocket。

順序（每一步都照 TypeScript 參考實作）：
1. `hb-ack` → 只是心跳回覆，不輸出。
2. 解析幀（只收 relay 送的 `cmd`／`query`、down 信封）；`kid` 不是這台 → 不理。
3. 門鎖類的 `cmd` 以 `deviceKeyDown` 解，`query` 一律 `deviceKey`；解不開 → 不理、不回任何東西。
4. 明文的 type 要與幀的 t 相同。
5. 同一個 msgId 已處理過 → 不再執行，重送當時的 ack（用新的 ctr）。
6. 時鐘沒同步 → 回 rejected `clock-unsynced`（fail-closed）。
7. 信封 ts 超出 ±maxSkewSec，或內容 exp 已過 → 回 rejected `expired`。
8. 執行 → ack（帶執行後的狀態，ts＝現在毫秒）；處理器丟例外 → rejected `device-error`。
up 計數器嚴格遞增、**先存再送**（重開機不重用 nonce）。
"""

from __future__ import annotations

import math
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Protocol, Union

from . import protocol
from .crypto import EnvelopeError, open_envelope, parse_kid, seal_envelope

SEEN_MAX = 256
DEFAULT_MAX_SKEW_SEC = 60

StateInput = Mapping[str, Union[str, Mapping[str, str]]]


@dataclass(frozen=True)
class Command:
    msg_id: str
    topic: str
    payload: str
    enc: str
    confirmed: Optional[bool] = None

    def to_json_obj(self) -> dict[str, Any]:
        out: dict[str, Any] = {"msgId": self.msg_id, "topic": self.topic, "payload": self.payload, "enc": self.enc}
        if self.confirmed is not None:
            out["confirmed"] = self.confirmed
        return out


@dataclass(frozen=True)
class CommandResult:
    status: str  # ok | rejected | unknown-topic
    reason: Optional[str] = None
    state: Optional[StateInput] = None


class CounterStore(Protocol):
    def load(self) -> int: ...

    def save(self, ctr: int) -> None: ...


def _topics(state: Optional[StateInput], now_ms: int) -> Optional[dict[str, Any]]:
    if not state:
        return None
    topics: dict[str, Any] = {}
    for topic, value in state.items():
        if not protocol.is_valid_topic(topic):
            raise ValueError(f"topic 不合法：{topic}")
        if isinstance(value, str):
            topics[topic] = {"payload": value, "ts": now_ms}
        else:
            entry: dict[str, Any] = {"payload": value["payload"]}
            if "enc" in value:
                entry["enc"] = value["enc"]
            entry["ts"] = now_ms
            topics[topic] = entry
    return topics or None


class DeviceCore:
    def __init__(
        self,
        *,
        kid: str,
        device_key: bytes,
        counter_store: CounterStore,
        on_command: Callable[[Command], CommandResult],
        now_ms: Callable[[], int],
        device_key_down: Optional[bytes] = None,
        on_query: Optional[Callable[[], StateInput]] = None,
        clock_synced: Optional[Callable[[], bool]] = None,
        max_skew_sec: int = DEFAULT_MAX_SKEW_SEC,
        on_error: Optional[Callable[[BaseException], None]] = None,
    ) -> None:
        if parse_kid(kid) is None:
            raise ValueError(f"kid 格式不對：{kid}")
        if len(device_key) != 32 or (device_key_down is not None and len(device_key_down) != 32):
            raise ValueError("設備金鑰必須是 32 bytes")
        self.kid = kid
        self._key = device_key
        self._key_down = device_key_down
        self._store = counter_store
        self._on_command = on_command
        self._on_query = on_query
        self._now_ms = now_ms
        self._clock_synced = clock_synced
        self._skew = max(1, int(max_skew_sec))
        self._on_error = on_error
        loaded = counter_store.load()
        self._ctr = loaded if isinstance(loaded, int) and not isinstance(loaded, bool) and loaded >= 0 else 0
        # msgId → (exp, 當時回的 ack；None＝還在執行)
        self._seen: OrderedDict[str, tuple[int, Optional[dict[str, Any]]]] = OrderedDict()

    @property
    def counter(self) -> int:
        return self._ctr

    def _send(self, message: dict[str, Any]) -> str:
        nxt = self._ctr + 1
        self._store.save(nxt)  # 先存再送
        self._ctr = nxt
        env = seal_envelope(self._key, self.kid, "up", nxt, math.floor(self._now_ms() / 1000), protocol.dumps(message))
        return protocol.encode_frame(message["type"], env)

    def state_frame(self, state: StateInput, will: Optional[bool] = None) -> Optional[str]:
        """主動回報狀態（25172）。沒有任何 topic 時回 None。"""
        topics = _topics(state, self._now_ms())
        if topics is None:
            return None
        msg: dict[str, Any] = {"type": "state", "topics": topics}
        if will is not None:
            msg["will"] = will
        return self._send(msg)

    def handle(self, text: Union[str, bytes]) -> list[str]:
        """處理一則 relay 送來的幀；回要送出的幀（可能是空的）。"""
        if text == protocol.HEARTBEAT_ACK or text == protocol.HEARTBEAT_ACK.encode():
            return []
        parsed = protocol.parse_frame(text, "relay")
        if parsed is None or parsed[0] not in ("cmd", "query"):
            return []
        t, env = parsed
        assert env is not None
        if env.kid != self.kid:
            return []
        key = (self._key_down or self._key) if t == "cmd" else self._key
        try:
            plaintext = open_envelope(env, key)
        except EnvelopeError:
            return []  # 解不開＝不是持有金鑰的人做的：不回任何東西
        msg = protocol.parse_down(plaintext)
        if msg is None or msg["type"] != t:
            return []
        now_ms = self._now_ms()
        now_sec = math.floor(now_ms / 1000)
        for msg_id in [m for m, (exp, _) in self._seen.items() if exp < now_sec - self._skew]:
            del self._seen[msg_id]
        prior = self._seen.get(msg["msgId"])
        if prior is not None:
            return [self._send(prior[1])] if prior[1] is not None else []

        def reject(reason: str) -> list[str]:
            return [self._send({"type": "ack", "inReplyTo": msg["msgId"], "status": "rejected", "reason": reason})]

        if self._clock_synced is not None and not self._clock_synced():
            return reject("clock-unsynced")
        if abs(env.ts - now_sec) > self._skew or msg["exp"] < now_sec:
            return reject("expired")
        self._seen[msg["msgId"]] = (msg["exp"], None)
        while len(self._seen) > SEEN_MAX:
            self._seen.popitem(last=False)
        ack: dict[str, Any]
        try:
            if t == "cmd":
                result = self._on_command(Command(msg["msgId"], msg["topic"], msg["payload"], msg["enc"], msg.get("confirmed")))
                ack = {"type": "ack", "inReplyTo": msg["msgId"], "status": result.status}
                if result.reason is not None:
                    ack["reason"] = result.reason[:200]
                topics = _topics(result.state, self._now_ms())
            else:
                ack = {"type": "ack", "inReplyTo": msg["msgId"], "status": "ok"}
                topics = _topics(self._on_query() if self._on_query else None, self._now_ms())
            if topics is not None:
                ack["topics"] = topics
        except Exception as error:  # noqa: BLE001 — 處理器的任何錯誤都回 device-error，不讓連線掉
            if self._on_error:
                self._on_error(error)
            ack = {"type": "ack", "inReplyTo": msg["msgId"], "status": "rejected", "reason": "device-error"}
        self._seen[msg["msgId"]] = (msg["exp"], ack)
        return [self._send(ack)]
