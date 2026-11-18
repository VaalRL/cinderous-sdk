"""up 計數器的持久化（SDK ADR 0049 §2.6）：**先存再送**，重開機後不會重用 nonce、也不會被當成重放。"""

from __future__ import annotations

import os
import tempfile


class MemoryCounterStore:
    """測試用：只在記憶體（重開機會從 0 開始——正式設備不要用）。"""

    def __init__(self, initial: int = 0) -> None:
        self.value = initial

    def load(self) -> int:
        return self.value

    def save(self, ctr: int) -> None:
        self.value = ctr


class FileCounterStore:
    """寫到檔案：先寫暫存檔、fsync、再原子換名（斷電時不會留下半個數字）。

    快閃記憶體壽命：每送一則 up 寫一次。韌體可改成「預留區塊」——一次存 ctr+N、用完再存下一塊，
    重開機時從存下的值往上跳（浪費最多 N 個號碼，但永遠不會倒退）。
    """

    def __init__(self, path: str, reserve: int = 1) -> None:
        self.path = path
        self.reserve = max(1, int(reserve))
        self._saved_ceiling = -1

    def load(self) -> int:
        try:
            with open(self.path, encoding="ascii") as f:
                value = int(f.read().strip() or "0")
        except FileNotFoundError:
            return 0
        if value < 0:
            raise ValueError("計數器檔案損毀（負數）")
        self._saved_ceiling = value
        return value

    def save(self, ctr: int) -> None:
        if ctr <= self._saved_ceiling:
            return  # 已預留的區塊內，不必寫
        ceiling = ctr + self.reserve - 1
        directory = os.path.dirname(os.path.abspath(self.path))
        fd, tmp = tempfile.mkstemp(prefix=".ctr-", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="ascii") as f:
                f.write(str(ceiling))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise
        self._saved_ceiling = ceiling
