"""設備幀與信封內的明文（SDK ADR 0049 §9.2、§9.4；SDK ADR 0120）。

與 TypeScript 的 `src/iot/device-frame.ts`、`device-message.ts`、`topic.ts` 相同規則。
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional, Union

from .crypto import Envelope, parse_envelope

HEARTBEAT = '{"t":"hb"}'
HEARTBEAT_ACK = '{"t":"hb-ack"}'
FRAME_MAX_BYTES = 32 * 1024
PAYLOAD_MAX_BYTES = 8 * 1024
REASON_MAX = 200
MAX_TOPICS = 64
TOPIC_MAX_LENGTH = 256
TOPIC_MAX_LEVELS = 16
ACK_STATUSES = ("ok", "rejected", "unknown-topic")

_MSG_ID = re.compile(r"[0-9A-Za-z_-]{16,64}")
_MAX_SAFE_INTEGER = 2**53 - 1

Json = dict[str, Any]


def dumps(value: Any) -> str:
    """與 JavaScript `JSON.stringify` 相同的緊湊輸出（不跳脫非 ASCII；dict 依插入順序）。"""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _loads(data: Union[str, bytes]) -> Any:
    try:
        return json.loads(data if isinstance(data, str) else data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def _js_length(s: str) -> int:
    """JavaScript 的 `string.length`（UTF-16 碼元數）。"""
    return len(s.encode("utf-16-le")) // 2


def is_valid_topic(topic: Any) -> bool:
    """具體 topic：非空、≤ 256（UTF-16 碼元）、無 NUL、≤ 16 層、沒有 + 或 #。"""
    if not isinstance(topic, str) or topic == "" or _js_length(topic) > TOPIC_MAX_LENGTH or "\x00" in topic:
        return False
    levels = topic.split("/")
    return len(levels) <= TOPIC_MAX_LEVELS and not any("+" in level or "#" in level for level in levels)


def _is_sec(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, float):
        if not v.is_integer():
            return False
        v = int(v)
    return isinstance(v, int) and 0 < v <= _MAX_SAFE_INTEGER


def _is_payload(v: Any) -> bool:
    return isinstance(v, str) and len(v.encode("utf-8")) <= PAYLOAD_MAX_BYTES


def _is_msg_id(v: Any) -> bool:
    return isinstance(v, str) and _MSG_ID.fullmatch(v) is not None


def _is_topics(v: Any) -> bool:
    if not isinstance(v, dict) or len(v) > MAX_TOPICS:
        return False
    for topic, value in v.items():
        if not is_valid_topic(topic) or not isinstance(value, dict):
            return False
        if not _is_payload(value.get("payload")) or ("enc" in value and value["enc"] not in ("utf8", "base64")) or not _is_sec(value.get("ts")):
            return False
    return True


# ── 設備幀 ───────────────────────────────────────────────────────────────────


def encode_frame(t: str, env: Optional[Envelope] = None) -> str:
    if t == "hb":
        return HEARTBEAT
    assert env is not None
    return dumps({"t": t, "env": env.to_json_obj()})


def parse_frame(data: Union[str, bytes], source: str) -> Optional[tuple[str, Optional[Envelope]]]:
    """`source`：relay（relay 送給設備）或 device（設備送給 relay）。回 (t, env)；不合法回 None。"""
    raw = data.encode("utf-8") if isinstance(data, str) else data
    if len(raw) > FRAME_MAX_BYTES:
        return None
    value = _loads(data)
    if not isinstance(value, dict):
        return None
    t = value.get("t")
    if t == "hb":
        return ("hb", None) if source == "device" else None
    allowed = ("cmd", "query") if source == "relay" else ("ack", "state")
    if t not in allowed:
        return None
    env = parse_envelope(value.get("env"))
    if env is None or env.dir != ("down" if source == "relay" else "up"):
        return None
    return (t, env)


# ── 明文 ─────────────────────────────────────────────────────────────────────


def parse_down(data: Union[str, bytes]) -> Optional[Json]:
    """down 明文（手機 → 設備）：cmd 或 query。欄位順序與 TypeScript 的解析結果相同。"""
    raw = _loads(data)
    if not isinstance(raw, dict) or not _is_msg_id(raw.get("msgId")) or not _is_sec(raw.get("exp")):
        return None
    if raw.get("type") == "query":
        return {"type": "query", "msgId": raw["msgId"], "exp": raw["exp"]}
    if raw.get("type") != "cmd" or not is_valid_topic(raw.get("topic")) or not _is_payload(raw.get("payload")) or raw.get("enc") not in ("utf8", "base64"):
        return None
    if "confirmed" in raw and not isinstance(raw["confirmed"], bool):
        return None
    msg: Json = {"type": "cmd", "msgId": raw["msgId"], "topic": raw["topic"], "payload": raw["payload"], "enc": raw["enc"]}
    if "confirmed" in raw:
        msg["confirmed"] = raw["confirmed"]
    msg["exp"] = raw["exp"]
    return msg


def parse_up(data: Union[str, bytes]) -> Optional[Json]:
    """up 明文（設備 → 手機）：ack 或 state。"""
    raw = _loads(data)
    if not isinstance(raw, dict):
        return None
    if raw.get("type") == "state":
        if not _is_topics(raw.get("topics")) or ("will" in raw and not isinstance(raw["will"], bool)):
            return None
        out: Json = {"type": "state", "topics": raw["topics"]}
        if "will" in raw:
            out["will"] = raw["will"]
        return out
    if raw.get("type") != "ack" or not _is_msg_id(raw.get("inReplyTo")) or raw.get("status") not in ACK_STATUSES:
        return None
    if "reason" in raw and (not isinstance(raw["reason"], str) or _js_length(raw["reason"]) > REASON_MAX):
        return None
    if "topics" in raw and not _is_topics(raw["topics"]):
        return None
    out = {"type": "ack", "inReplyTo": raw["inReplyTo"], "status": raw["status"]}
    if "reason" in raw:
        out["reason"] = raw["reason"]
    if "topics" in raw:
        out["topics"] = raw["topics"]
    return out
