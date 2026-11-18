"""以 SDK 的跨語言測試向量（tests/fixtures/iot-device-v1.vectors.json，由 TypeScript 實作產生）驗證 Python 參考設備。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cinder_iot_device import backoff, crypto, protocol
from cinder_iot_device.core import Command, CommandResult, DeviceCore
from cinder_iot_device.counter import MemoryCounterStore

VECTORS_PATH = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "iot-device-v1.vectors.json"
V = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


def ids(cases, key="name"):
    return [str(c[key]) for c in cases]


# ── 金鑰 ──


def test_home_tag_and_topic_key():
    k = V["keys"]
    assert crypto.topic_key(k["homeSecret"]).hex() == k["topicKey"]
    assert crypto.home_tag(k["homeSecret"]) == k["homeTag"]


@pytest.mark.parametrize("case", V["keys"]["blind"], ids=ids(V["keys"]["blind"], "value"))
def test_blind(case):
    assert crypto.blind_with(crypto.topic_key(V["keys"]["homeSecret"]), case["value"]) == case["blinded"]


@pytest.mark.parametrize("case", V["keys"]["deviceKey"], ids=ids(V["keys"]["deviceKey"], "id"))
def test_device_key(case):
    assert crypto.device_key(V["keys"]["homeSecret"], case["id"], case["epoch"]).hex() == case["key"]


@pytest.mark.parametrize("case", V["keys"]["deviceKeyDown"], ids=ids(V["keys"]["deviceKeyDown"], "epoch"))
def test_device_key_down(case):
    assert crypto.device_key_down(V["keys"]["operatorSecret"], case["id"], case["epoch"]).hex() == case["key"]


# ── 權杖 ──


@pytest.mark.parametrize("case", V["token"]["hash"], ids=ids(V["token"]["hash"], "token"))
def test_token_hash(case):
    assert crypto.hash_token(case["token"]) == case["sha256"]


@pytest.mark.parametrize("case", V["token"]["pattern"], ids=ids(V["token"]["pattern"], "token"))
def test_token_pattern(case):
    assert crypto.token_valid(case["token"]) is case["valid"]


@pytest.mark.parametrize("case", V["token"]["verify"], ids=ids(V["token"]["verify"], "token"))
def test_token_verify(case):
    assert crypto.verify_token(case["token"], case["hash"]) is case["ok"]


# ── 信封 ──


@pytest.mark.parametrize("case", V["envelope"]["seal"], ids=ids(V["envelope"]["seal"]))
def test_seal(case):
    assert crypto.envelope_aad(case["dir"], case["kid"], case["ctr"], case["ts"]) == case["aad"]
    env = crypto.seal_envelope(
        bytes.fromhex(case["key"]),
        case["kid"],
        case["dir"],
        case["ctr"],
        case["ts"],
        case["plaintext"],
        nonce=bytes.fromhex(case["nonce"]) if "nonce" in case else None,
    )
    assert env.to_json_obj() == case["envelope"]
    assert crypto.open_envelope(case["envelope"], bytes.fromhex(case["key"])).decode("utf-8") == case["plaintext"]


@pytest.mark.parametrize("case", V["envelope"]["open"], ids=ids(V["envelope"]["open"]))
def test_open(case):
    key = bytes.fromhex(case["key"])
    if "error" in case:
        with pytest.raises(crypto.EnvelopeError) as err:
            crypto.open_envelope(case["envelope"], key)
        assert err.value.code == case["error"]
    else:
        assert crypto.open_envelope(case["envelope"], key).decode("utf-8") == case["plaintext"]


def test_up_nonce_cannot_be_chosen():
    with pytest.raises(crypto.EnvelopeError):
        crypto.seal_envelope(b"\x07" * 32, "lamp.0", "up", 1, 1, "x", nonce=b"\x01" + b"\x00" * 11)


# ── 幀與明文 ──


def test_heartbeat_strings_are_byte_exact():
    assert protocol.HEARTBEAT == V["frames"]["heartbeat"]
    assert protocol.HEARTBEAT_ACK == V["frames"]["heartbeatAck"]
    assert protocol.FRAME_MAX_BYTES == V["frames"]["maxBytes"]


@pytest.mark.parametrize("case", V["frames"]["cases"], ids=ids(V["frames"]["cases"]))
def test_frames(case):
    got = protocol.parse_frame(case["text"], case["source"])
    if case["expect"] is None:
        assert got is None
    else:
        t, env = got
        assert t == case["expect"]["t"]
        if t != "hb":
            assert (env.kid, env.dir) == (case["expect"]["kid"], case["expect"]["dir"])


@pytest.mark.parametrize("case", V["messages"]["down"], ids=ids(V["messages"]["down"]))
def test_down_messages(case):
    assert protocol.parse_down(case["text"]) == case["expect"]


@pytest.mark.parametrize("case", V["messages"]["up"], ids=ids(V["messages"]["up"]))
def test_up_messages(case):
    assert protocol.parse_up(case["text"]) == case["expect"]


# ── §10.2 退讓 ──


@pytest.mark.parametrize("case", V["backoff"]["classify"], ids=ids(V["backoff"]["classify"]))
def test_classify(case):
    assert backoff.classify(case["observation"], case["nowSec"]).to_json_obj() == case["expect"]


@pytest.mark.parametrize("case", V["backoff"]["delay"], ids=ids(V["backoff"]["delay"]))
def test_delay(case):
    d = case["disconnect"]
    ctx = case["ctx"]
    got = backoff.retry_delay_ms(
        backoff.Disconnect(d["class"], d.get("reset"), d.get("retryAfterSec")),
        ctx["attempt"],
        ctx["nowSec"],
        ctx["clockSynced"],
        ctx["random"],
    )
    assert got == case["expectMs"]


# ── 設備行為（§9.4）：逐位元組相同的輸出幀 ──

REF = V["device"]["reference"]


def run_scenario(s):
    dev = REF["devices"][s["device"]]
    now = {"ms": REF["nowMs"]}
    commands = []

    def on_command(cmd: Command) -> CommandResult:
        commands.append(cmd.to_json_obj())
        return CommandResult("ok", state={cmd.topic: cmd.payload})

    store = MemoryCounterStore(s.get("counterStart", REF["defaults"]["counterStart"]))
    core = DeviceCore(
        kid=dev["kid"],
        device_key=bytes.fromhex(dev["deviceKey"]),
        device_key_down=bytes.fromhex(dev["deviceKeyDown"]) if "deviceKeyDown" in dev else None,
        counter_store=store,
        on_command=on_command,
        on_query=lambda: {"home/lamp/state": "QUERIED"},
        now_ms=lambda: now["ms"],
        clock_synced=lambda: s.get("clockSynced", REF["defaults"]["clockSynced"]),
        max_skew_sec=s.get("maxSkewSec", REF["defaults"]["maxSkewSec"]),
    )
    out = []
    for i, step in enumerate(s["steps"]):
        now["ms"] = step.get("nowMs", REF["nowMs"])
        for frame in core.handle(step["frame"]):
            out.append({"afterStep": i, "frame": frame})
    return {"commands": commands, "out": out, "counterEnd": store.value}


@pytest.mark.parametrize("scenario", V["device"]["scenarios"], ids=ids(V["device"]["scenarios"]))
def test_device_behaviour(scenario):
    assert run_scenario(scenario) == scenario["expect"]
