#!/usr/bin/env node
/**
 * Zoomクラウド録画の使用量を調べ、上限に近ければ警告文を標準出力に出す。
 * 余裕がある時は何も出さない（黙る）。
 *
 * Claude Code の SessionStart フックから呼ばれる想定。
 * 毎回Zoomを叩くと遅いので、判定結果を CACHE_FILE に24時間キャッシュする。
 *
 * 上限は Zoom Pro の 5GB を既定とし、ZOOM_STORAGE_LIMIT_GB で上書きできる。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// キットの置き場所は人によって違うので、このファイルからの相対で解決する
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = path.join(HERE, '..', 'server', '.env.local')
const CACHE_FILE = path.join(os.tmpdir(), 'zoom-capacity-check.json')
const CACHE_HOURS = 24
const WARN_RATIO = 0.7 // 上限の何割で警告を出すか

// 失敗しても起動を邪魔しない。黙って終わる
const bail = () => process.exit(0)

// `| head` などで出力先が閉じられた時にトレースバックを出さない（vtt2md.py と同じ扱い）
process.stdout.on('error', () => {})

// SessionStart フックの形式で、モデルのコンテキストに入る文章として出す
const emit = (text) =>
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    })
  )

function readEnv() {
  if (!fs.existsSync(ENV_FILE)) bail()
  return Object.fromEntries(
    fs.readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
}

// 前回の判定から24時間経っていなければ、その結果をそのまま使う
if (fs.existsSync(CACHE_FILE)) {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (Date.now() - c.at < CACHE_HOURS * 3600_000) {
      if (c.message) emit(c.message)
      bail()
    }
  } catch { /* 壊れていたら取り直す */ }
}

const env = readEnv()
const limitGb = Number(env.ZOOM_STORAGE_LIMIT_GB || process.env.ZOOM_STORAGE_LIMIT_GB || 5)

let token
try {
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${env.ZOOM_ACCOUNT_ID}`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`).toString('base64'),
      },
      signal: AbortSignal.timeout(10_000),
    }
  )
  token = (await res.json()).access_token
} catch { bail() }
if (!token) bail()

// Zoom APIは1回のクエリが最大1ヶ月なので、月ごとに分けて取る
const meetings = []
const now = new Date()
try {
  for (let i = 0; i < 6; i++) {
    const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 0)
    const from = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const d = (x) => x.toISOString().slice(0, 10)
    const res = await fetch(
      `https://api.zoom.us/v2/users/${encodeURIComponent(env.ZOOM_USER_EMAIL)}/recordings` +
        `?page_size=300&from=${d(from)}&to=${d(to)}`,
      { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15_000) }
    )
    if (!res.ok) bail()
    meetings.push(...((await res.json()).meetings || []))
  }
} catch { bail() }

const gb = (b) => b / 1e9
const usedGb = gb(meetings.reduce(
  (s, m) => s + (m.recording_files || []).reduce((t, f) => t + (f.file_size || 0), 0), 0
))
const pct = Math.round((usedGb / limitGb) * 100)

let message = ''
if (usedGb >= limitGb * WARN_RATIO) {
  // 大きい順に3件。文字起こしが手元にあるかは判断材料になるので件数だけ添える
  const top = meetings
    .map((m) => ({
      topic: m.topic,
      date: new Date(m.start_time).toLocaleDateString('ja-JP'),
      gb: gb((m.recording_files || []).reduce((t, f) => t + (f.file_size || 0), 0)),
      hasTranscript: (m.recording_files || []).some((f) => f.file_type === 'TRANSCRIPT'),
    }))
    .filter((m) => m.gb > 0.01)
    .sort((a, b) => b.gb - a.gb)
    .slice(0, 3)

  message =
    `[Zoom容量] 使用 ${usedGb.toFixed(2)}GB / 上限 ${limitGb}GB（${pct}%）。上限が近いので、` +
    `ユーザーに「録画を整理するか」を聞いてください。大きい順: ` +
    top.map((t) => `${t.topic}(${t.date}) ${t.gb.toFixed(2)}GB${t.hasTranscript ? '・文字起こし有' : '・文字起こし無'}`).join(' / ') +
    `。削除は必ず確認を取り、文字起こしを該当クライアントの meetings/ に保存してから消すこと。\n`
}

try {
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ at: Date.now(), usedGb, message }))
} catch { /* キャッシュできなくても動作に影響しない */ }

if (message) emit(message)
