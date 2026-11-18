"""金鑰衍生、設備權杖與設備信封（SDK ADR 0049 §2.1、§2.6、§9.5；SDK ADR 0140）。

與 TypeScript 的 `src/iot/keys.ts`、`envelope.ts`、`device-frame.ts` 逐位元組相同——
以 `tests/fixtures/iot-device-v1.vectors.json` 驗證。只依賴標準函式庫與 `cryptography`（AES-GCM）。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import os
import re
from dataclasses import dataclass
from typing import Any, Literal, Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ENVELOPE_VERSION = 1
ENVELOPE_ALG = "A256GCM"
ENVELOPE_MAX_PLAINTEXT_BYTES = 16 * 1024
NONCE_BYTES = 12
TAG_BYTES = 16
KEY_BYTES = 32
BLIND_LENGTH = 22
AAD_PREFIX = "cinder-iot/v1"

INFO_ENC = "cinder-iot/v1/enc"
INFO_TOPIC = "cinder-iot/v1/topic"
INFO_DEVICE = "cinder-iot/v1/device-key"
INFO_DEVICE_DOWN = "cinder-iot/v1/device-key-down"

TOKEN_PATTERN = re.compile(r"cit1_[A-Za-z0-9_-]{43}")
_KID_PATTERN = re.compile(r"(.+)\.(0|[1-9][0-9]*)", re.DOTALL)
_HEX64 = re.compile(r"[0-9a-fA-F]{64}")
_MAX_SAFE_INTEGER = 2**53 - 1

Direction = Literal["down", "up"]


# ── HKDF／盲化／金鑰 ─────────────────────────────────────────────────────────


def hkdf_sha256(ikm: bytes, info: bytes, length: int = 32, salt: bytes = b"") -> bytes:
    """RFC 5869。空 salt 與 32 個零位元組等價（HMAC 會把金鑰補零）。"""
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    out, block, counter = b"", b"", 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


def secret_bytes(secret: bytes | str) -> bytes:
    """家庭秘密／operatorSecret：32 bytes 或 64 位 hex。"""
    if isinstance(secret, str):
        s = secret.strip()
        if not _HEX64.fullmatch(s):
            raise ValueError("秘密必須是 64 位 hex（32 bytes）")
        return bytes.fromhex(s)
    if len(secret) != 32:
        raise ValueError("秘密必須是 32 bytes")
    return bytes(secret)


def _b64url_nopad(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def topic_key(home_secret: bytes | str) -> bytes:
    return hkdf_sha256(secret_bytes(home_secret), INFO_TOPIC.encode())


def blind_with(topic_key_bytes: bytes, value: str) -> str:
    """`base64url(HMAC-SHA256(topicKey, value))` 取前 22 字元。"""
    return _b64url_nopad(hmac.new(topic_key_bytes, value.encode("utf-8"), hashlib.sha256).digest())[:BLIND_LENGTH]


def home_tag(home_secret: bytes | str) -> str:
    return blind_with(topic_key(home_secret), "home")


def _check_epoch(epoch: int) -> None:
    if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch < 0:
        raise ValueError(f"epoch 必須是非負整數（收到 {epoch!r}）")


def device_key(home_secret: bytes | str, device_id: str, epoch: int = 0) -> bytes:
    """`deviceKey`：up 方向與 query 用（全家都算得出）。"""
    _check_epoch(epoch)
    return hkdf_sha256(secret_bytes(home_secret), f"{INFO_DEVICE}|{device_id}|{epoch}".encode("utf-8"))


def device_key_down(operator_secret: bytes | str, device_id: str, epoch: int = 0) -> bytes:
    """門鎖類 `cmd` 的金鑰：只有 operator／owner 持有的 operatorSecret 導出（§9.5）。"""
    _check_epoch(epoch)
    return hkdf_sha256(secret_bytes(operator_secret), f"{INFO_DEVICE_DOWN}|{device_id}|{epoch}".encode("utf-8"))


# ── 設備權杖 ─────────────────────────────────────────────────────────────────


def token_valid(token: str) -> bool:
    return isinstance(token, str) and TOKEN_PATTERN.fullmatch(token) is not None


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_token(token: Optional[str], expected_hash: str) -> bool:
    if token is None or not token_valid(token) or re.fullmatch(r"[0-9a-f]{64}", expected_hash) is None:
        return False
    return hmac.compare_digest(hash_token(token), expected_hash)


def generate_token() -> str:
    return "cit1_" + _b64url_nopad(os.urandom(32))


# ── 信封 ─────────────────────────────────────────────────────────────────────


class EnvelopeError(Exception):
    """`code`：format（格式不對）、nonce（與方向或計數器不符）、auth（驗證失敗）。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def parse_kid(kid: Any) -> Optional[tuple[str, int]]:
    if not isinstance(kid, str):
        return None
    m = _KID_PATTERN.fullmatch(kid)
    if m is None:
        return None
    epoch = int(m.group(2))
    return (m.group(1), epoch) if epoch <= _MAX_SAFE_INTEGER else None


def make_kid(device_id: str, epoch: int) -> str:
    if not device_id:
        raise ValueError("設備 id 不可為空")
    _check_epoch(epoch)
    return f"{device_id}.{epoch}"


def envelope_aad(direction: str, kid: str, ctr: int, ts: int) -> str:
    return f"{AAD_PREFIX}|{direction}|{kid}|{ctr}|{ts}"


def up_nonce(ctr: int) -> bytes:
    """up：0x01＋3 個零＋8 bytes 大端 ctr。"""
    return b"\x01\x00\x00\x00" + ctr.to_bytes(8, "big")


def _nonce_fits(nonce: bytes, direction: str, ctr: int) -> bool:
    if len(nonce) != NONCE_BYTES:
        return False
    if direction == "down":
        return nonce[0] == 0x00
    return nonce == up_nonce(ctr)


def _is_safe_uint(v: Any) -> bool:
    """JavaScript 的 `Number.isSafeInteger(v) && v >= 0`（JSON 的 15.0 也算整數；布林不算）。"""
    if isinstance(v, bool):
        return False
    if isinstance(v, float):
        if not v.is_integer():
            return False
        v = int(v)
    return isinstance(v, int) and 0 <= v <= _MAX_SAFE_INTEGER


def _b64decode(value: Any) -> Optional[bytes]:
    if not isinstance(value, str):
        return None
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None


@dataclass(frozen=True)
class Envelope:
    kid: str
    dir: str
    ctr: int
    ts: int
    nonce: str
    ct: str

    def to_json_obj(self) -> dict[str, Any]:
        """欄位順序與 TypeScript 的 `sealIotEnvelope` 相同（設備幀要逐位元組相同才比得了向量）。"""
        return {"v": ENVELOPE_VERSION, "alg": ENVELOPE_ALG, "kid": self.kid, "dir": self.dir, "ctr": self.ctr, "ts": self.ts, "nonce": self.nonce, "ct": self.ct}


def parse_envelope(value: Any) -> Optional[Envelope]:
    """只驗形狀，不解密；不合法回 None。"""
    if not isinstance(value, dict):
        return None
    v, alg = value.get("v"), value.get("alg")
    if isinstance(v, bool) or v != ENVELOPE_VERSION or alg != ENVELOPE_ALG:
        return None
    if parse_kid(value.get("kid")) is None:
        return None
    if value.get("dir") not in ("down", "up"):
        return None
    ctr, ts = value.get("ctr"), value.get("ts")
    if not _is_safe_uint(ctr) or not _is_safe_uint(ts):
        return None
    nonce, ct = _b64decode(value.get("nonce")), _b64decode(value.get("ct"))
    if nonce is None or len(nonce) != NONCE_BYTES or ct is None or len(ct) < TAG_BYTES:
        return None
    if len(ct) > ENVELOPE_MAX_PLAINTEXT_BYTES + TAG_BYTES:
        return None
    return Envelope(kid=value["kid"], dir=value["dir"], ctr=int(ctr), ts=int(ts), nonce=value["nonce"], ct=value["ct"])


def seal_envelope(key: bytes, kid: str, direction: Direction, ctr: int, ts: int, plaintext: bytes | str, nonce: Optional[bytes] = None) -> Envelope:
    """封裝信封。up 的 nonce 由 ctr 算出（不可指定）；down 預設 0x00＋11 bytes 隨機。"""
    if len(key) != KEY_BYTES:
        raise ValueError("設備金鑰必須是 32 bytes")
    if parse_kid(kid) is None:
        raise ValueError(f"kid 格式不對：{kid}")
    if not _is_safe_uint(ctr) or not _is_safe_uint(ts):
        raise ValueError("ctr／ts 必須是非負安全整數")
    data = plaintext.encode("utf-8") if isinstance(plaintext, str) else bytes(plaintext)
    if len(data) > ENVELOPE_MAX_PLAINTEXT_BYTES:
        raise ValueError("信封明文超過上限")
    if direction == "up":
        if nonce is not None:
            raise EnvelopeError("nonce", "up 方向的 nonce 由 ctr 算出，不可指定")
        n = up_nonce(ctr)
    elif direction == "down":
        n = nonce if nonce is not None else b"\x00" + os.urandom(11)
        if not _nonce_fits(n, "down", ctr):
            raise EnvelopeError("nonce", "down 方向的 nonce 必須 12 bytes 且以 0x00 開頭")
    else:
        raise ValueError("dir 必須是 down 或 up")
    ct = AESGCM(key).encrypt(n, data, envelope_aad(direction, kid, ctr, ts).encode("utf-8"))
    return Envelope(kid=kid, dir=direction, ctr=ctr, ts=ts, nonce=base64.b64encode(n).decode("ascii"), ct=base64.b64encode(ct).decode("ascii"))


def open_envelope(value: Any, key: bytes) -> bytes:
    """解開信封；失敗丟 EnvelopeError。"""
    env = value if isinstance(value, Envelope) else parse_envelope(value)
    if env is None:
        raise EnvelopeError("format", "信封格式不對")
    if len(key) != KEY_BYTES:
        raise ValueError("設備金鑰必須是 32 bytes")
    nonce = base64.b64decode(env.nonce)
    if not _nonce_fits(nonce, env.dir, env.ctr):
        raise EnvelopeError("nonce", "nonce 與方向或計數器不符")
    try:
        return AESGCM(key).decrypt(nonce, base64.b64decode(env.ct), envelope_aad(env.dir, env.kid, env.ctr, env.ts).encode("utf-8"))
    except InvalidTag as error:
        raise EnvelopeError("auth", "驗證失敗（金鑰不對，或內容、標頭被竄改）") from error
