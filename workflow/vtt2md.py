#!/usr/bin/env python3
"""
Zoomの文字起こし(VTT)を、読める形のMarkdownに整形する。

使い方:
    python3 vtt2md.py 入力.vtt > 出力.md

話者ラベルが機能しているかを自動で判定して、出し分ける。

- 複数話者が識別できている場合 → 話者ごとにまとめて出力
- 全部が同じ話者名になっている場合（＝Zoomを録音機として使った回）
  → 話者ラベルを外し、タイムスタンプ順の発話ログとして出力

後者は「壊れている」のではなく、音声入力が1系統しかない時に起きる正常な挙動。
その場合は誰の発言かを文脈から判断して議事録を書くこと。
"""
import io
import re
import sys

# `| head` などで出力先が閉じられた時にトレースバックを出さない
try:
    import signal

    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
except (ImportError, AttributeError, ValueError):
    pass  # Windows には SIGPIPE が無い


def parse(path):
    """VTTを (時刻, 話者, 本文) のリストにする"""
    with io.open(path, encoding="utf-8-sig") as f:
        lines = [l.rstrip("\n") for l in f]

    blocks = []
    i = 0
    while i < len(lines):
        if "-->" in lines[i]:
            timestamp = lines[i].split("-->")[0].strip().split(".")[0]
            i += 1
            parts = []
            while i < len(lines) and lines[i].strip():
                parts.append(lines[i].strip())
                i += 1
            text = " ".join(parts)
            m = re.match(r"^([^:]{1,30}):\s*(.*)$", text)
            if m:
                speaker, body = m.group(1), m.group(2)
            else:
                speaker, body = "", text
            if body:
                blocks.append((timestamp, speaker, body))
        i += 1
    return blocks


def merge_by_speaker(blocks):
    """連続する同一話者の発話をひとまとめにする"""
    merged = []
    for t, sp, body in blocks:
        if merged and merged[-1][1] == sp:
            merged[-1][2] += body
        else:
            merged.append([t, sp, body])
    return merged


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    blocks = parse(sys.argv[1])
    if not blocks:
        print("発話が見つかりませんでした。VTTの中身を確認してください。", file=sys.stderr)
        sys.exit(1)

    speakers = {sp for _, sp, _ in blocks if sp}

    if len(speakers) >= 2:
        # 話者分離が効いている
        for t, sp, body in merge_by_speaker(blocks):
            print(f"**[{t}] {sp or '不明'}**")
            print(body)
            print()
    else:
        # 全部同じ話者 = 録音機として使った回。ラベルを外してログ形式に
        only = next(iter(speakers), None)
        print(
            "<!-- Zoomの話者判定が働いていません（全発話が"
            f"{only or '同一話者'}名義）。録音機として使った回に起きます。"
            "話者は文脈から判断してください。 -->\n"
        )
        for t, _, body in blocks:
            print(f"[{t}] {body}")
            print()


if __name__ == "__main__":
    main()
