#!/usr/bin/env node
/**
 * Zoom MTG Kit — MCPサーバー
 *
 * Zoomの「定期ミーティング作成 → クラウド録画 → 文字起こし取得」を
 * Claude Code から直接扱えるようにする。
 *
 * 認証はServer-to-Server OAuth（アカウント単位）。
 * 認証情報は必ず利用者自身のZoomアカウントで発行すること。詳細は 導入マニュアル.md。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadDotenv({ path: path.join(__dirname, '..', '.env.local') });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `環境変数 ${name} が未設定です。` +
        `サーバーディレクトリ直下の .env.local に設定してください（導入マニュアル.md 参照）。`
    );
  }
  return value;
}

const ZOOM_ACCOUNT_ID = requireEnv('ZOOM_ACCOUNT_ID');
const ZOOM_CLIENT_ID = requireEnv('ZOOM_CLIENT_ID');
const ZOOM_CLIENT_SECRET = requireEnv('ZOOM_CLIENT_SECRET');
const ZOOM_USER_EMAIL = requireEnv('ZOOM_USER_EMAIL');

/** 保存先。ZOOM_DOWNLOAD_DIR で上書き可 */
const DOWNLOAD_DIR =
  process.env.ZOOM_DOWNLOAD_DIR ||
  path.join(os.homedir(), 'Downloads', 'zoom-recordings');

/**
 * 文字起こしの「本当の保管場所」。削除の安全装置が見に行く。
 *
 * DOWNLOAD_DIR は一時置き場であって保管場所ではない。整形して案件フォルダへ
 * 移した後は空になるので、そこだけ見ていると **正しく保管したほど誤って止まる**。
 * ZOOM_ARCHIVE_ROOT に案件フォルダの親を指定すると、その配下を再帰で探す。
 * **フォルダの形は決め打ちしない**（利用者が自由に作り替えてよい土台にするため）。
 */
const ARCHIVE_ROOT = process.env.ZOOM_ARCHIVE_ROOT || '';

/** Vimeoへの退避を使う場合のみ設定。未設定でも他の機能は動く */
const VIMEO_ACCESS_TOKEN = process.env.VIMEO_ACCESS_TOKEN || '';

const API = 'https://api.zoom.us/v2';
const VIMEO_API = 'https://api.vimeo.com';

// ─────────────────────────────────────────────
// 共通
// ─────────────────────────────────────────────

/** トークンと、そのトークンに実際に付与されているスコープ一覧 */
async function getTokenInfo(): Promise<{ token: string; scopes: string[] }> {
  const credentials = Buffer.from(
    `${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`
  ).toString('base64');
  const res = await axios.post('https://zoom.us/oauth/token', null, {
    params: { grant_type: 'account_credentials', account_id: ZOOM_ACCOUNT_ID },
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  return {
    token: res.data.access_token,
    scopes: String(res.data.scope || '').split(/\s+/).filter(Boolean),
  };
}

async function getAccessToken(): Promise<string> {
  return (await getTokenInfo()).token;
}

/** Zoom APIのエラーを、原因と対処が分かる日本語にして投げ直す */
function rethrow(error: unknown, context: string): never {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { code?: number; message?: string }
      | undefined;
    // スコープ不足は原因が分かりにくいので明示する
    if (data?.code === 4711) {
      throw new Error(
        `${context}: Zoomアプリのスコープが足りません。\n` +
          `${data.message}\n` +
          `→ Zoom Marketplace の該当アプリで不足スコープを追加し、再アクティベートしてください（導入マニュアル.md 参照）。`
      );
    }
    throw new Error(
      `${context}: ${error.response?.status ?? ''} ${data?.message || error.message}`
    );
  }
  throw error;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
}

function formatDateForFilename(dateString: string): string {
  const d = new Date(dateString);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_');
}

/** ISO日付 or undefined を、表示できる形にする（できなければフォールバック文字列） */
function displayDateTime(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

const WEEKDAY_LABEL = ['', '日', '月', '火', '水', '木', '金', '土'];

// ─────────────────────────────────────────────
// ミーティング
// ─────────────────────────────────────────────

interface CreateMeetingParams {
  topic?: string;
  weekday?: number;
  startHour?: number;
  startMinute?: number;
  duration?: number;
  recurring?: boolean;
  autoRecording?: 'cloud' | 'local' | 'none';
}

/**
 * 定期（または単発）ミーティングを作成する。
 * 既定はクラウド録画ON・ホスト前入室可。
 */
async function createMeeting(params: CreateMeetingParams) {
  const token = await getAccessToken();

  const topic = params.topic ?? '打ち合わせ';
  const weekday = params.weekday ?? 5; // Zoom曜日番号 1=日 … 5=木
  const startHour = params.startHour ?? 18;
  const startMinute = params.startMinute ?? 0;
  const duration = params.duration ?? 60;
  const recurring = params.recurring ?? true;
  const autoRecording = params.autoRecording ?? 'cloud';

  // 次に来る該当曜日のJST日時を求める
  const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const targetJsDay = weekday - 1; // Zoom 1=日 → JS 0
  let daysUntil = (targetJsDay - nowJst.getUTCDay() + 7) % 7;
  if (daysUntil === 0) daysUntil = 7; // 同日は翌週に送る
  const startUtc = new Date(
    Date.UTC(
      nowJst.getUTCFullYear(),
      nowJst.getUTCMonth(),
      nowJst.getUTCDate() + daysUntil,
      startHour - 9, // JST → UTC
      startMinute,
      0
    )
  );
  const startTimeIso = startUtc.toISOString().replace('.000Z', 'Z');

  const body: Record<string, unknown> = {
    topic,
    type: recurring ? 8 : 2, // 8=固定日時の定期, 2=単発
    start_time: startTimeIso,
    duration,
    timezone: 'Asia/Tokyo',
    settings: {
      join_before_host: true,
      auto_recording: autoRecording,
    },
  };
  if (recurring) {
    body.recurrence = {
      type: 2, // 毎週
      repeat_interval: 1,
      weekly_days: String(weekday),
      end_times: 50, // Zoomの上限。切れたら作り直す
    };
  }

  try {
    const res = await axios.post(
      `${API}/users/${ZOOM_USER_EMAIL}/meetings`,
      body,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    // 定期ミーティングではトップレベルの start_time / duration が
    // 返らないことがあるため、occurrences とリクエスト値でフォールバックする
    const m = res.data;
    const occ = Array.isArray(m.occurrences) ? m.occurrences[0] : undefined;
    return {
      raw: m,
      topic: m.topic ?? topic,
      id: m.id,
      joinUrl: m.join_url,
      startTime: displayDateTime(
        m.start_time ?? occ?.start_time,
        displayDateTime(startTimeIso, '不明')
      ),
      duration: m.duration ?? occ?.duration ?? duration,
      weekdayLabel: WEEKDAY_LABEL[weekday] ?? '?',
      recurring,
      autoRecording,
    };
  } catch (e) {
    rethrow(e, 'ミーティング作成エラー');
  }
}

/** 予定されているミーティングの一覧。meeting:read:list_meetings が必要 */
async function listMeetings(type: string, pageSize: number) {
  const token = await getAccessToken();
  try {
    const res = await axios.get(`${API}/users/${ZOOM_USER_EMAIL}/meetings`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { type, page_size: pageSize },
    });
    return res.data.meetings || [];
  } catch (e) {
    rethrow(e, 'ミーティング一覧の取得エラー');
  }
}

/** 単一ミーティングの詳細（参加URL・パスコード・録画設定を含む）。meeting:read:meeting が必要 */
async function getMeeting(meetingId: string) {
  const token = await getAccessToken();
  try {
    const res = await axios.get(`${API}/meetings/${meetingId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data;
  } catch (e) {
    rethrow(e, 'ミーティング詳細の取得エラー');
  }
}

/** ミーティング設定の更新（自動録画のON/OFFなど）。meeting:update:meeting が必要 */
async function updateMeeting(
  meetingId: string,
  patch: { topic?: string; autoRecording?: 'cloud' | 'local' | 'none' }
) {
  const token = await getAccessToken();
  const body: Record<string, unknown> = {};
  if (patch.topic) body.topic = patch.topic;
  if (patch.autoRecording) body.settings = { auto_recording: patch.autoRecording };
  try {
    await axios.patch(`${API}/meetings/${meetingId}`, body, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return true;
  } catch (e) {
    rethrow(e, 'ミーティング更新エラー');
  }
}

// ─────────────────────────────────────────────
// 録画
// ─────────────────────────────────────────────

interface RecordingFile {
  id?: string;
  file_type: string;
  file_size: number;
  download_url: string;
  recording_start: string;
}
interface Recording {
  uuid: string;
  id: number;
  topic: string;
  start_time: string;
  duration: number;
  recording_files: RecordingFile[];
}

/**
 * 録画一覧。Zoom APIは1回のクエリが最大1ヶ月なので、
 * monthsBack が2以上のときは月ごとに分けて取得して結合する。
 */
async function listRecordings(count: number, monthsBack: number): Promise<Recording[]> {
  const token = await getAccessToken();
  const all: Recording[] = [];
  const now = new Date();
  try {
    for (let i = 0; i < Math.max(1, monthsBack); i++) {
      const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const fmt = (d: Date) => d.toISOString().split('T')[0];
      const res = await axios.get(`${API}/users/${ZOOM_USER_EMAIL}/recordings`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { from: fmt(from), to: fmt(to), page_size: 300 },
      });
      all.push(...(res.data.meetings || []));
    }
  } catch (e) {
    rethrow(e, '録画リスト取得エラー');
  }
  all.sort(
    (a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
  );
  return all.slice(0, count);
}

async function downloadFile(url: string, fileName: string, token: string) {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const filePath = path.join(DOWNLOAD_DIR, fileName);
  // access_token をクエリで渡す方式は非推奨なので Authorization ヘッダを使う
  const res = await axios.get(url, {
    responseType: 'stream',
    headers: { Authorization: `Bearer ${token}` },
  });
  const writer = fs.createWriteStream(filePath);
  res.data.pipe(writer);
  await new Promise<void>((resolve, reject) => {
    writer.on('finish', () => resolve());
    writer.on('error', reject);
  });
  return filePath;
}

/**
 * Zoom APIのパスに使うIDを組み立てる。
 * 数値のミーティングIDはそのまま、uuidは二重URLエンコードする（Zoomの仕様）。
 */
function meetingPathId(idOrUuid: string): string {
  if (/^\d+$/.test(idOrUuid)) return idOrUuid;
  return encodeURIComponent(encodeURIComponent(idOrUuid));
}

interface ShareInfo {
  topic: string;
  shareUrl: string;
  passcode: string;
  startTime: string;
  duration: number;
  totalSize: number;
  playUrl?: string;
}

/**
 * 録画の共有リンク（Loomのように相手に見せるURL）を取得する。
 * recording:read で取得できる。
 */
async function getShareInfo(idOrUuid: string): Promise<ShareInfo> {
  const token = await getAccessToken();

  const toShareInfo = (m: any): ShareInfo => {
    const mp4 = (m.recording_files || []).find((f: any) => f.file_type === 'MP4');
    return {
      topic: m.topic,
      shareUrl: m.share_url,
      passcode: m.recording_play_passcode || m.password || '',
      startTime: m.start_time,
      duration: m.duration,
      totalSize: m.total_size,
      playUrl: mp4?.play_url,
    };
  };

  // まず単一ミーティングのエンドポイントを試す。
  // これは cloud_recording:read:list_recording_files が要るので、
  // 権限が無い場合はユーザーの録画一覧から探すほうにフォールバックする
  // （一覧側にも share_url は含まれており、必要な権限が少なくて済む）。
  try {
    const res = await axios.get(
      `${API}/meetings/${meetingPathId(idOrUuid)}/recordings`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return toShareInfo(res.data);
  } catch (e) {
    const isScopeError =
      axios.isAxiosError(e) && (e.response?.data as any)?.code === 4711;
    if (!isScopeError) rethrow(e, '共有リンクの取得エラー');
  }

  // フォールバック: 直近12ヶ月の録画一覧から ID / uuid が一致するものを探す
  const recordings = await listRecordings(500, 12);
  const hit = recordings.find(
    (r) => String(r.id) === idOrUuid || r.uuid === idOrUuid
  );
  if (!hit) {
    throw new Error(
      `共有リンクの取得エラー: ${idOrUuid} に該当する録画が見つかりませんでした。` +
        `list-recordings で ID または uuid を確認してください。`
    );
  }
  return toShareInfo(hit);
}

/**
 * 録画の共有設定を変更する。
 * cloud_recording:update:recording_settings が必要。
 */
async function updateShareSettings(
  idOrUuid: string,
  patch: {
    share?: 'publicly' | 'internally' | 'none';
    removePasscode?: boolean;
    allowDownload?: boolean;
    requireSignIn?: boolean;
  }
) {
  const token = await getAccessToken();
  const body: Record<string, unknown> = {};
  if (patch.share) body.share_recording = patch.share;
  if (patch.removePasscode) body.password = ''; // 空文字でパスコード解除
  if (patch.allowDownload !== undefined) body.viewer_download = patch.allowDownload;
  if (patch.requireSignIn !== undefined)
    body.recording_authentication = patch.requireSignIn;
  try {
    await axios.patch(
      `${API}/meetings/${meetingPathId(idOrUuid)}/recordings/settings`,
      body,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return true;
  } catch (e) {
    rethrow(e, '共有設定の更新エラー');
  }
}

// ─────────────────────────────────────────────
// Vimeoへの退避
// ─────────────────────────────────────────────

function requireVimeoToken(): string {
  if (!VIMEO_ACCESS_TOKEN) {
    throw new Error(
      'VIMEO_ACCESS_TOKEN が未設定です。\n' +
        'developer.vimeo.com/apps でアプリを作り、upload / edit / private / video_files の\n' +
        'スコープを付けたトークンを発行して、server/.env.local に追記してください。'
    );
  }
  return VIMEO_ACCESS_TOKEN;
}

const VIMEO_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.vimeo.*+json;version=3.4',
});

/**
 * その録画の文字起こしが手元にあるか。削除の安全装置に使う。
 *
 * 2か所を見る。どちらかで見つかれば「ある」とみなす。
 *
 *  ①一時置き場（DOWNLOAD_DIR）… `YYYY-MM-DD_...vtt`
 *    日付＋トピック名の頭で厳しめに判定する。
 *
 *  ②保管場所（ZOOM_ARCHIVE_ROOT 配下）… 再帰で探す。
 *    **フォルダの形は決め打ちしない。** 案件フォルダの作りは利用者が自由に変えてよい土台なので、
 *    `context/` のような特定の階層を前提にすると、形を変えた人ほど誤って止まる。
 *
 *    どの案件の録画かは、まず**ミーティングIDで確定させる**。
 *    案件フォルダの `Zoomリンク.md` にIDが書いてあれば、その案件フォルダの中だけを見る
 *    （＝別案件の同じ日のファイルを自分のものと誤認しない）。
 *    IDで確定できない時だけ、件名の手がかりで絞り込む。
 *
 * 迷ったら「無い」と判定する（消してしまう方向に倒さない）。
 * 見つかった場合はそのパスを返し、呼び出し側で提示できるようにする。
 */
function findLocalTranscript(
  topic: string,
  startTime: string,
  meetingId?: string | number,
): string | null {
  const date = new Date(startTime);
  const p = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const ymd = `${yyyy}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  const yymmdd = `${String(yyyy).slice(2)}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  const strip = (s: string) => s.replace(/\s+/g, '');

  // ①一時置き場
  if (fs.existsSync(DOWNLOAD_DIR)) {
    const key = strip(sanitizeFileName(topic)).slice(0, 8);
    if (key) {
      const hit = fs
        .readdirSync(DOWNLOAD_DIR)
        .find((f) => f.endsWith('.vtt') && f.includes(ymd) && strip(f).includes(key));
      if (hit) return path.join(DOWNLOAD_DIR, hit);
    }
  }

  // ②保管場所
  if (!ARCHIVE_ROOT || !fs.existsSync(ARCHIVE_ROOT)) return null;

  /** その日の文字起こしファイルか。日付の書き方は2通り許す（YYYY-MM-DD / YYMMDD） */
  const isTranscript = (name: string) =>
    (name.includes(ymd) || name.startsWith(yymmdd)) &&
    /文字起こし|transcript/i.test(name);

  // 案件フォルダを、まずミーティングIDで確定させる
  const caseDir = meetingId ? findCaseDirByMeetingId(ARCHIVE_ROOT, String(meetingId)) : null;
  if (caseDir) {
    // どの案件かは分かっている。**その中に無ければ「無い」**（他案件のファイルで代用しない）
    return walkFiles(caseDir).find((f) => isTranscript(path.basename(f))) || null;
  }

  // IDで確定できない場合。全体から候補を集め、件名の手がかりで絞る。
  // 日付だけで判定すると、同じ日に別案件の打ち合わせがあった時に
  // 「対象は保存し忘れているのに素通りする」ので、必ず手がかりと突き合わせる。
  const candidates = walkFiles(ARCHIVE_ROOT).filter((f) => isTranscript(path.basename(f)));
  if (candidates.length === 0) return null;

  const keys = topicKeys(topic);
  if (keys.length === 0) return candidates[0];

  // 手がかりは**ファイル名だけでなくフォルダ名でも照合する**。
  // 案件名がフォルダ側にあり、ファイル名は日付だけ、という作りが普通にあるため。
  const hit = candidates.find((f) => {
    const rel = path.relative(ARCHIVE_ROOT, f);
    return keys.some((k) => rel.includes(k));
  });
  return hit || null;
}

/** 配下のファイルを再帰で集める。深すぎる階層と重いフォルダは見ない */
function walkFiles(root: string, depth = 0): string[] {
  if (depth > 4) return [];
  const skip = new Set(['node_modules', '.git', '.venv', 'dist', '__pycache__']);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || skip.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full, depth + 1));
    else out.push(full);
  }
  return out;
}

/**
 * ミーティングIDが書かれた案件フォルダを探す。
 *
 * 各案件の `Zoomリンク.md` に**ミーティングIDを書く**のが運用ルール。
 * これがあると「この録画はこの案件のもの」と一意に決まるので、
 * 名前が似た案件・改名した案件でも取り違えない。
 */
function findCaseDirByMeetingId(root: string, meetingId: string): string | null {
  const id = meetingId.replace(/\s/g, '');
  if (!id) return null;
  let cases: fs.Dirent[];
  try {
    cases = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const c of cases) {
    if (!c.isDirectory() || c.name.startsWith('.')) continue;
    const dir = path.join(root, c.name);
    const md = walkFiles(dir, 2).filter((f) => f.endsWith('.md'));
    for (const f of md) {
      try {
        if (fs.readFileSync(f, 'utf-8').replace(/\s/g, '').includes(id)) return dir;
      } catch {
        /* 読めないファイルは飛ばす */
      }
    }
  }
  return null;
}

/**
 * トピック名から、ファイル名との照合に使う手がかりを取り出す。
 *
 * 「【たなか先生】ZOOMミーティング」→ ["たなか","なか先","か先生",…]
 * 整形時に件名を付け直す（例: `260810_たなかMTG_文字起こし.md`）ため、
 * 完全一致では当たらない。共通しやすい2〜3文字の断片で照合する。
 */
function topicKeys(topic: string): string[] {
  const core = topic
    .replace(/[【】（）()［］\[\]「」\s_-]/g, '')
    .replace(/(ミーティング|ミィーティング|MTG|mtg|ZOOM|Zoom|zoom|打ち合わせ|打合せ|会議|定例|さん|様|の)/g, '');
  const keys: string[] = [];
  for (let len = 3; len >= 2; len--) {
    for (let i = 0; i + len <= core.length && i < 8; i++) keys.push(core.slice(i, i + len));
  }
  return keys;
}

interface VimeoUploadParams {
  idOrUuid: string;
  name?: string;
  description?: string;
  privacyView?: 'unlisted' | 'password' | 'nobody';
  password?: string;
  allowDownload?: boolean;
  embed?: 'public' | 'private' | 'whitelist';
}

/**
 * ZoomのMP4をVimeoへ退避する。
 *
 * Vimeoの「pull」方式を使い、Zoomの署名付きURLをVimeoに渡して
 * Vimeo側が直接取得する。手元に1GB級のファイルを落とさずに済む。
 */
async function uploadToVimeo(params: VimeoUploadParams) {
  const vt = requireVimeoToken();
  const zt = await getAccessToken();

  // 対象の録画を特定する（単一取得は権限が多く要るので一覧から探す）
  const recordings = await listRecordings(500, 12);
  const rec = recordings.find(
    (r) => String(r.id) === params.idOrUuid || r.uuid === params.idOrUuid
  );
  if (!rec) {
    throw new Error(
      `${params.idOrUuid} に該当する録画が見つかりません。list-recordings で ID または uuid を確認してください。`
    );
  }

  const mp4s = rec.recording_files
    .filter((f) => f.file_type === 'MP4' && f.file_size > 0)
    .sort((a, b) => b.file_size - a.file_size);
  if (!mp4s.length) {
    throw new Error(
      `「${rec.topic}」にアップロードできるMP4がありません。まだZoom側で変換中の可能性があります。`
    );
  }
  const mp4 = mp4s[0];

  const view = params.privacyView ?? 'unlisted';
  const body: Record<string, unknown> = {
    name: params.name ?? `${rec.topic}（${rec.start_time.slice(0, 10)}）`,
    description:
      params.description ??
      `Zoom録画より。${rec.duration}分。${displayDateTime(rec.start_time, '')}`,
    // access_token をクエリに付けた署名付きURLをVimeoが取得する
    upload: { approach: 'pull', link: `${mp4.download_url}?access_token=${zt}` },
    privacy: {
      view,
      // 埋め込みは既定で public。whitelist にすると未登録ドメインで再生できなくなる
      embed: params.embed ?? 'public',
      download: params.allowDownload ?? false,
      add: false,
    },
  };
  if (view === 'password') {
    if (!params.password) {
      throw new Error('privacyView に password を指定した場合は password も必要です。');
    }
    (body.privacy as Record<string, unknown>).password = params.password;
    body.password = params.password;
  }

  try {
    const res = await axios.post(`${VIMEO_API}/me/videos`, body, {
      headers: { ...VIMEO_HEADERS(vt), 'Content-Type': 'application/json' },
    });
    const d = res.data;
    return {
      topic: rec.topic,
      sizeMb: Math.round(mp4.file_size / 1024 / 1024),
      uri: d.uri as string,
      link: d.link as string,
      status: d.upload?.status as string,
      view: d.privacy?.view as string,
    };
  } catch (e) {
    if (axios.isAxiosError(e)) {
      const dm = (e.response?.data as any)?.developer_message;
      throw new Error(
        `Vimeoへの取り込み開始に失敗しました: ${e.response?.status ?? ''} ${dm || e.message}`
      );
    }
    throw e;
  }
}

/**
 * Vimeoの動画IDを取り出す。
 * 限定公開URL（https://vimeo.com/123456/abcdef）はハッシュが数字で始まることがあり、
 * 末尾から探すとハッシュ側を拾ってしまうため、必ずホスト名の直後から取る。
 */
function vimeoVideoId(input: string): string {
  const s = String(input ?? '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/(?:videos?\/|vimeo\.com\/)(\d+)/);
  if (m) return m[1];
  throw new Error(
    `Vimeoの動画IDを読み取れませんでした: ${s}\n` +
      '動画のURL（https://vimeo.com/123456789）か、数字のIDを渡してください。'
  );
}

/** Vimeo側の取り込み・変換の進行状況 */
async function vimeoStatus(uriOrId: string) {
  const vt = requireVimeoToken();
  const uri = `/videos/${vimeoVideoId(uriOrId)}`;
  try {
    const res = await axios.get(`${VIMEO_API}${uri}`, {
      headers: VIMEO_HEADERS(vt),
      params: {
        fields: 'name,link,duration,status,upload.status,transcode.status,privacy',
      },
    });
    const d = res.data;
    return {
      name: d.name as string,
      link: d.link as string,
      duration: d.duration as number,
      status: d.status as string,
      upload: d.upload?.status as string,
      transcode: d.transcode?.status as string,
      view: d.privacy?.view as string,
      embed: d.privacy?.embed as string,
    };
  } catch (e) {
    if (axios.isAxiosError(e)) {
      const dm = (e.response?.data as any)?.developer_message;
      throw new Error(`Vimeoの状態取得に失敗しました: ${dm || e.message}`);
    }
    throw e;
  }
}

/** Vimeoのプランと残りストレージ */
async function vimeoQuota() {
  const vt = requireVimeoToken();
  try {
    const res = await axios.get(`${VIMEO_API}/me`, {
      headers: VIMEO_HEADERS(vt),
      params: { fields: 'name,account,upload_quota' },
    });
    const q = res.data.upload_quota || {};
    return {
      name: res.data.name as string,
      plan: res.data.account as string,
      space: q.space as { free?: number; max?: number; used?: number } | undefined,
      periodic: q.periodic as { free?: number; max?: number; used?: number } | undefined,
    };
  } catch (e) {
    if (axios.isAxiosError(e)) {
      const dm = (e.response?.data as any)?.developer_message;
      throw new Error(`Vimeoの容量取得に失敗しました: ${dm || e.message}`);
    }
    throw e;
  }
}

/** スコープ不足(4711)かどうか */
function isScopeError(e: unknown): boolean {
  return axios.isAxiosError(e) && (e.response?.data as any)?.code === 4711;
}

/**
 * 録画の削除。ゴミ箱に入るので30日以内なら復元可能。
 *
 * Zoomは「まるごと削除」と「ファイル単位の削除」で必要なスコープが別物で、
 * 導入マニュアルが案内しているのは後者(cloud_recording:delete:recording_file)だけ。
 * そのためまるごと削除でスコープ不足になる構成が普通に起きるので、
 * その時はファイル単位の削除に自動で切り替える。
 */
async function deleteRecording(meetingUuid: string) {
  const token = await getAccessToken();
  const encoded = meetingPathId(meetingUuid);
  try {
    await axios.delete(`${API}/meetings/${encoded}/recordings`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { action: 'trash' },
    });
    return true;
  } catch (e) {
    if (!isScopeError(e)) rethrow(e, '録画削除エラー');
  }

  // ここから代替ルート: ファイルを1つずつ消す
  const rec = (await listRecordings(500, 6)).find((r) => r.uuid === meetingUuid);
  if (!rec) {
    throw new Error(
      '録画削除エラー: まるごと削除の権限が無く、代わりに使う録画一覧にも該当の録画が見つかりませんでした（直近6ヶ月外の可能性があります）。'
    );
  }
  const files = rec.recording_files || [];
  const failed: string[] = [];
  for (const f of files) {
    if (!f.id) {
      failed.push(`${f.file_type}(ID無し)`);
      continue;
    }
    try {
      await axios.delete(`${API}/meetings/${encoded}/recordings/${f.id}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { action: 'trash' },
      });
    } catch (e) {
      // 本体を消した時点で連動して消えるファイルがあるため、404は成功扱いにする
      if (axios.isAxiosError(e) && e.response?.status === 404) continue;
      if (isScopeError(e)) rethrow(e, '録画削除エラー');
      failed.push(`${f.file_type}(${axios.isAxiosError(e) ? e.response?.status : e})`);
    }
  }
  if (failed.length) {
    throw new Error(`録画削除エラー: 一部のファイルを削除できませんでした → ${failed.join(' / ')}`);
  }
  return true;
}

// ─────────────────────────────────────────────
// 自己診断
// ─────────────────────────────────────────────

/** 機能ごとに必要なスコープ。Zoomは末尾の :admin が付いたり付かなかったりする */
const FEATURE_SCOPES: { feature: string; tools: string; scopes: string[] }[] = [
  { feature: 'ミーティングを作る', tools: 'create-meeting', scopes: ['meeting:write:meeting'] },
  { feature: 'ミーティングを読む', tools: 'get-meeting', scopes: ['meeting:read:meeting'] },
  { feature: 'ミーティング一覧', tools: 'list-meetings', scopes: ['meeting:read:list_meetings'] },
  { feature: '設定変更（自動録画）', tools: 'update-meeting', scopes: ['meeting:update:meeting'] },
  { feature: '録画一覧', tools: 'list-recordings / download-recordings / get-share-link', scopes: ['cloud_recording:read:list_user_recordings'] },
  { feature: '文字起こしの取得', tools: 'download-recordings', scopes: ['cloud_recording:read:meeting_transcript', 'cloud_recording:read:list_user_recordings'] },
  { feature: '共有設定の変更', tools: 'set-share-settings', scopes: ['cloud_recording:update:recording_settings'] },
  // まるごと削除(delete:meeting_recording)が無くても、ファイル単位(delete:recording_file)＋
  // 録画一覧があれば delete-recording は動く。必須はこの2つだけにする。
  { feature: '録画の削除', tools: 'delete-recording', scopes: ['cloud_recording:delete:recording_file', 'cloud_recording:read:list_user_recordings'] },
];

/** :admin の有無を無視してスコープを保持しているか判定する */
function hasScope(granted: string[], want: string): boolean {
  const norm = (s: string) => s.replace(/:admin$/, '');
  return granted.some((g) => norm(g) === norm(want));
}

async function runDoctor(): Promise<string> {
  const lines: string[] = ['Zoom MTG Kit 自己診断', ''];
  let fatal = false;

  // 1. 認証情報
  lines.push('【1】認証情報');
  const envs = {
    ZOOM_ACCOUNT_ID,
    ZOOM_CLIENT_ID,
    ZOOM_CLIENT_SECRET,
    ZOOM_USER_EMAIL,
  };
  for (const [k, v] of Object.entries(envs)) {
    lines.push(`  ${v ? 'OK ' : 'NG '} ${k}${v ? '' : ' … .env.local に未設定'}`);
  }
  lines.push('');

  // 2. 認証が通るか
  lines.push('【2】Zoomへの接続');
  let scopes: string[] = [];
  let token = '';
  try {
    const info = await getTokenInfo();
    token = info.token;
    scopes = info.scopes;
    lines.push('  OK  アクセストークンを取得できました');
    lines.push(`      付与スコープ ${scopes.length}件`);
  } catch (e) {
    fatal = true;
    lines.push('  NG  トークンを取得できません');
    lines.push('      → Account ID / Client ID / Client Secret が正しいか確認してください');
    lines.push('      → Zoom Marketplace でアプリが Activate 済みか確認してください');
    lines.push(`      （${e instanceof Error ? e.message : String(e)}）`);
    return lines.join('\n');
  }
  lines.push('');

  // 3. スコープ
  lines.push('【3】権限（スコープ）');
  const missing: string[] = [];
  for (const f of FEATURE_SCOPES) {
    const lack = f.scopes.filter((s) => !hasScope(scopes, s));
    if (lack.length === 0) {
      lines.push(`  OK  ${f.feature}`);
    } else {
      lines.push(`  NG  ${f.feature}（${f.tools} が使えません）`);
      lack.forEach((s) => {
        lines.push(`      不足: ${s}`);
        missing.push(s);
      });
    }
  }
  if (
    hasScope(scopes, 'cloud_recording:delete:recording_file') &&
    !hasScope(scopes, 'cloud_recording:delete:meeting_recording')
  ) {
    lines.push('      ※ まるごと削除の権限（cloud_recording:delete:meeting_recording）は');
    lines.push('        無いので、ファイルを1つずつ消す方式で動きます（結果は同じです）。');
  }
  if (missing.length) {
    lines.push('');
    lines.push('  → Zoom Marketplace → 該当アプリ → Scopes で上記を追加し、');
    lines.push('    Activation タブで再アクティベートしてください。');
  }
  lines.push('');

  // 4. 音声文字起こしがONか（過去の録画から判定）
  lines.push('【4】音声文字起こしの設定');
  if (!hasScope(scopes, 'cloud_recording:read:list_user_recordings')) {
    lines.push('  ?   録画一覧の権限が無いため判定できません（【3】を先に解決してください）');
  } else {
    try {
      const recs = await listRecordings(10, 3);
      if (recs.length === 0) {
        lines.push('  ?   直近3ヶ月に録画が無いため判定できません');
        lines.push('      → 3分ほどテスト録画をしてから、もう一度この診断を実行してください');
      } else {
        const withTranscript = recs.filter((r) =>
          r.recording_files.some((f) => f.file_type === 'TRANSCRIPT')
        );
        const done = recs.filter((r) => r.recording_files.some((f) => f.file_size > 0));
        if (withTranscript.length > 0) {
          lines.push(`  OK  文字起こしが作られています（直近${recs.length}件中 ${withTranscript.length}件）`);
        } else if (done.length === 0) {
          lines.push('  ?   録画がまだZoom側で変換中です（60分の会議で30〜60分かかります）');
        } else {
          lines.push('  NG  録画はあるのに文字起こしがありません');
          lines.push('      → https://zoom.us/profile/setting の「記録」タブで');
          lines.push('        「詳細クラウド記録設定」→「音声文字起こしを作成」にチェックを入れてください');
          lines.push('      ※ 設定を入れる前に録った分には、後から文字起こしは作られません');
        }
        lines.push(`      （クラウド録画が存在するので、有料プランの条件は満たしています）`);
      }
    } catch (e) {
      lines.push(`  ?   判定できませんでした（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  lines.push('');

  // 5. 保存先
  lines.push('【5】ダウンロード保存先');
  try {
    if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    fs.accessSync(DOWNLOAD_DIR, fs.constants.W_OK);
    lines.push(`  OK  ${DOWNLOAD_DIR}`);
  } catch {
    fatal = true;
    lines.push(`  NG  ${DOWNLOAD_DIR} に書き込めません`);
    lines.push('      → ZOOM_DOWNLOAD_DIR で別の場所を指定できます');
  }
  lines.push('');

  // まとめ
  lines.push('─'.repeat(40));
  if (!missing.length && !fatal) {
    lines.push('すべて問題ありません。使い始められます。');
  } else {
    lines.push('上の NG を解消してから、もう一度この診断を実行してください。');
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// MCPサーバー
// ─────────────────────────────────────────────

const server = new Server(
  { name: 'zoom-mtg-kit', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: 'doctor',
    description:
      'セットアップの自己診断。認証情報・接続・権限（スコープ）・音声文字起こしの設定・保存先を順にチェックし、足りないものを名指しで返す。うまく動かない時は最初にこれを実行する。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create-meeting',
    description:
      '定期Zoomミーティングを作成する。既定はクラウド録画ON・ホスト前入室可・毎週木曜18:00 JST・60分。参加URLは毎回同じなので案件ごとの常設リンクとして使える。要スコープ: meeting:write',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'ミーティング名（例: 〇〇社 打ち合わせ）', default: '打ち合わせ' },
        weekday: { type: 'number', description: '曜日（1=日,2=月,3=火,4=水,5=木,6=金,7=土）', default: 5 },
        startHour: { type: 'number', description: '開始時（JST）', default: 18 },
        startMinute: { type: 'number', description: '開始分', default: 0 },
        duration: { type: 'number', description: '想定時間（分）。この時間で強制終了はされない', default: 60 },
        recurring: { type: 'boolean', description: 'true=毎週の定期, false=単発', default: true },
        autoRecording: { type: 'string', enum: ['cloud', 'local', 'none'], description: '自動録画', default: 'cloud' },
      },
    },
  },
  {
    name: 'list-meetings',
    description: '予定されているミーティングの一覧を取得する。要スコープ: meeting:read',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['scheduled', 'upcoming', 'live'], default: 'scheduled' },
        pageSize: { type: 'number', default: 100 },
      },
    },
  },
  {
    name: 'get-meeting',
    description: 'ミーティングの詳細（参加URL・パスコード・録画設定・定期設定）を取得する。要スコープ: meeting:read',
    inputSchema: {
      type: 'object',
      properties: { meetingId: { type: 'string', description: 'ミーティングID' } },
      required: ['meetingId'],
    },
  },
  {
    name: 'update-meeting',
    description: 'ミーティング設定を更新する（自動録画のON/OFF、名称変更）。要スコープ: meeting:update',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string' },
        topic: { type: 'string' },
        autoRecording: { type: 'string', enum: ['cloud', 'local', 'none'] },
      },
      required: ['meetingId'],
    },
  },
  {
    name: 'list-recordings',
    description: 'クラウド録画の一覧を取得する。monthsBack で遡る月数を指定（既定1ヶ月）。要スコープ: recording:read',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '取得件数', default: 10 },
        monthsBack: { type: 'number', description: '遡る月数（1で当月のみ）', default: 1 },
      },
    },
  },
  {
    name: 'download-recordings',
    description:
      '録画をダウンロードする。transcriptOnly=true で文字起こし(VTT)のみを高速取得（議事録化はこれで足りる）。要スコープ: recording:read',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', default: 2 },
        transcriptOnly: { type: 'boolean', description: 'VTTのみ取得しMP4/M4Aをスキップ', default: false },
      },
    },
  },
  {
    name: 'get-share-link',
    description:
      '録画の共有リンクを取得する（Loomのように相手にURLで見せる用）。視聴用パスコードも一緒に返し、そのまま貼れる文面を作る。要スコープ: recording:read',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: {
          type: 'string',
          description: 'ミーティングID、または list-recordings が返す uuid',
        },
      },
      required: ['meetingId'],
    },
  },
  {
    name: 'set-share-settings',
    description:
      '録画の共有設定を変える。パスコード無しで誰でも見られる状態にしたい時に使う。要スコープ: cloud_recording:update:recording_settings',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'ミーティングID または uuid' },
        share: {
          type: 'string',
          enum: ['publicly', 'internally', 'none'],
          description: 'publicly=リンクを知っていれば誰でも / internally=同一組織のみ / none=共有停止',
        },
        removePasscode: { type: 'boolean', description: 'true で視聴パスコードを解除する' },
        allowDownload: { type: 'boolean', description: '視聴者にダウンロードを許可するか' },
        requireSignIn: { type: 'boolean', description: '視聴にZoomログインを必須にするか' },
      },
      required: ['meetingId'],
    },
  },
  {
    name: 'upload-to-vimeo',
    description:
      'Zoomの録画をVimeoへ退避する（Vimeoが直接Zoomから取得するため手元の回線を使わない）。既定はURL限定公開・DL禁止・埋め込み可。Zoomの容量を空ける前段として使う。要: VIMEO_ACCESS_TOKEN',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'ミーティングID または list-recordings が返す uuid' },
        name: { type: 'string', description: 'Vimeo上のタイトル。省略時は「トピック（日付）」' },
        description: { type: 'string' },
        privacyView: {
          type: 'string',
          enum: ['unlisted', 'password', 'nobody'],
          description: 'unlisted=URLを知っている人だけ（既定） / password=パスワード必須 / nobody=自分だけ',
          default: 'unlisted',
        },
        password: { type: 'string', description: 'privacyView=password のときに必須' },
        allowDownload: { type: 'boolean', description: '視聴者のダウンロードを許可するか', default: false },
        embed: {
          type: 'string',
          enum: ['public', 'private', 'whitelist'],
          description:
            'public=どこにでも埋め込める（既定）。whitelistは登録し忘れたドメインで再生できなくなるので注意',
          default: 'public',
        },
      },
      required: ['meetingId'],
    },
  },
  {
    name: 'vimeo-status',
    description:
      'Vimeoの取り込み・変換の進行状況を確認する。upload-to-vimeo の直後はまだ視聴できないため、これで完了を待つ。',
    inputSchema: {
      type: 'object',
      properties: {
        video: {
          type: 'string',
          description:
            'VimeoのURL、動画ID、または /videos/123 形式のURI。限定公開URL（https://vimeo.com/123/abcdef）もそのまま渡せる',
        },
      },
      required: ['video'],
    },
  },
  {
    name: 'vimeo-quota',
    description: 'Vimeoのプランと残りストレージを確認する。退避を続けられるか判断するのに使う。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete-recording',
    description:
      '録画をゴミ箱へ移す（30日以内は復元可能）。**文字起こしが手元に無い場合は中止する安全装置つき**。実行には confirm: true が必要。要スコープ: recording:write',
    inputSchema: {
      type: 'object',
      properties: {
        meetingUuid: { type: 'string', description: 'list-recordings が返す uuid' },
        confirm: {
          type: 'boolean',
          description: '本人に確認を取ってから true にする。false や未指定なら何もしない',
          default: false,
        },
        skipTranscriptCheck: {
          type: 'boolean',
          description: '文字起こしが手元に無くても消す場合のみ true。既定は false（安全側）',
          default: false,
        },
      },
      required: ['meetingUuid'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params as {
    name: string;
    arguments?: Record<string, any>;
  };

  try {
    switch (name) {
      case 'doctor': {
        return { content: [{ type: 'text', text: await runDoctor() }] };
      }

      case 'create-meeting': {
        const m = await createMeeting(args ?? {});
        const kind = m.recurring ? `毎週${m.weekdayLabel}曜の定期` : '単発';
        return {
          content: [
            {
              type: 'text',
              text:
                `${kind}ミーティングを作成しました\n` +
                `トピック: ${m.topic}\n` +
                `ID: ${m.id}\n` +
                `初回: ${m.startTime}\n` +
                `想定時間: ${m.duration}分\n` +
                `自動録画: ${m.autoRecording}\n` +
                `参加URL: ${m.joinUrl}\n\n` +
                `※参加URLは毎回同じです。配布時に /u/N/ が混ざっていたら削ってください。`,
            },
          ],
        };
      }

      case 'list-meetings': {
        const list = await listMeetings(args?.type ?? 'scheduled', args?.pageSize ?? 100);
        if (!list.length) {
          return { content: [{ type: 'text', text: '予定されているミーティングはありません。' }] };
        }
        const text = list
          .map(
            (m: any, i: number) =>
              `${i + 1}. ${m.topic}\n   ID: ${m.id}\n   開始: ${displayDateTime(m.start_time, '未設定（定期）')}\n   URL: ${m.join_url}`
          )
          .join('\n\n');
        return { content: [{ type: 'text', text: `ミーティング一覧（${list.length}件）\n\n${text}` }] };
      }

      case 'get-meeting': {
        const m = await getMeeting(String(args?.meetingId));
        return {
          content: [
            {
              type: 'text',
              text:
                `トピック: ${m.topic}\n` +
                `ID: ${m.id}\n` +
                `開始: ${displayDateTime(m.start_time, '未設定（定期）')}\n` +
                `時間: ${m.duration ?? '—'}分\n` +
                `自動録画: ${m.settings?.auto_recording ?? '不明'}\n` +
                `ホスト前入室: ${m.settings?.join_before_host ? '許可' : '不可'}\n` +
                `参加URL: ${m.join_url}\n` +
                `パスコード: ${m.password ?? '（なし）'}`,
            },
          ],
        };
      }

      case 'update-meeting': {
        await updateMeeting(String(args?.meetingId), {
          topic: args?.topic,
          autoRecording: args?.autoRecording,
        });
        const changed = [
          args?.topic ? `名称→${args.topic}` : null,
          args?.autoRecording ? `自動録画→${args.autoRecording}` : null,
        ]
          .filter(Boolean)
          .join(' / ');
        return {
          content: [{ type: 'text', text: `ミーティング ${args?.meetingId} を更新しました（${changed || '変更なし'}）` }],
        };
      }

      case 'list-recordings': {
        const recordings = await listRecordings(args?.count ?? 10, args?.monthsBack ?? 1);
        if (!recordings.length) {
          return { content: [{ type: 'text', text: '録画が見つかりませんでした。' }] };
        }
        const text = recordings
          .map((r, i) => {
            const files = r.recording_files
              .map((f) => `      - ${f.file_type || '(処理中)'}: ${formatBytes(f.file_size)}`)
              .join('\n');
            const processing = r.recording_files.every((f) => !f.file_size)
              ? '   ※まだZoom側で変換中です\n'
              : '';
            return (
              `${i + 1}. ${r.topic}\n` +
              `   日時: ${displayDateTime(r.start_time, '不明')}\n` +
              `   時間: ${r.duration}分\n` +
              `   ID: ${r.id}\n` +
              `   uuid: ${r.uuid}\n` +
              processing +
              `   ファイル:\n${files}`
            );
          })
          .join('\n\n');
        return { content: [{ type: 'text', text: `Zoom録画リスト（${recordings.length}件）\n\n${text}` }] };
      }

      case 'download-recordings': {
        const count = args?.count ?? 2;
        const transcriptOnly = args?.transcriptOnly ?? false;
        const recordings = await listRecordings(count, 1);
        if (!recordings.length) {
          return { content: [{ type: 'text', text: 'ダウンロードする録画が見つかりませんでした。' }] };
        }
        const token = await getAccessToken();
        let out = transcriptOnly
          ? 'Zoom文字起こしダウンロード（TRANSCRIPTのみ）\n'
          : 'Zoom録画ダウンロード\n';
        out += `保存先: ${DOWNLOAD_DIR}\n\n`;
        let ok = 0;
        let ng = 0;

        for (const r of recordings) {
          const targets = r.recording_files.filter((f) =>
            transcriptOnly
              ? f.file_type === 'TRANSCRIPT'
              : ['TRANSCRIPT', 'MP4', 'M4A'].includes(f.file_type)
          );
          if (!targets.length) {
            out += `スキップ: ${r.topic}（対象ファイルなし。変換中の可能性あり）\n`;
            continue;
          }
          for (const f of targets) {
            const ext = f.file_type === 'TRANSCRIPT' ? 'vtt' : f.file_type.toLowerCase();
            const fileName = `${formatDateForFilename(f.recording_start)}_${sanitizeFileName(r.topic)}.${ext}`;
            try {
              out += `ダウンロード中: ${fileName}（${formatBytes(f.file_size)}）\n`;
              await downloadFile(f.download_url, fileName, token);
              out += `   完了\n`;
              ok++;
            } catch (e) {
              out += `   エラー: ${e instanceof Error ? e.message : String(e)}\n`;
              ng++;
            }
          }
        }
        out += `\n結果: 成功 ${ok}件、失敗 ${ng}件`;
        return { content: [{ type: 'text', text: out }] };
      }

      case 'get-share-link': {
        const s = await getShareInfo(String(args?.meetingId));
        const sizeMb = Math.round(s.totalSize / 1024 / 1024);
        const paste =
          `${s.topic}（${displayDateTime(s.startTime, '')}・${s.duration}分）の録画です。\n` +
          `${s.shareUrl}` +
          (s.passcode ? `\nパスコード: ${s.passcode}` : '');
        return {
          content: [
            {
              type: 'text',
              text:
                `共有リンク\n${s.shareUrl}\n\n` +
                (s.passcode
                  ? `視聴パスコード: ${s.passcode}\n※パスコードが必要です。無しで配りたい場合は set-share-settings で removePasscode を使ってください。\n\n`
                  : `視聴パスコード: なし（リンクだけで見られます）\n\n`) +
                `録画時間: ${s.duration}分 / 容量: ${sizeMb}MB\n\n` +
                `--- そのまま貼れる文面 ---\n${paste}`,
            },
          ],
        };
      }

      case 'set-share-settings': {
        await updateShareSettings(String(args?.meetingId), {
          share: args?.share,
          removePasscode: args?.removePasscode,
          allowDownload: args?.allowDownload,
          requireSignIn: args?.requireSignIn,
        });
        const changed = [
          args?.share ? `公開範囲→${args.share}` : null,
          args?.removePasscode ? 'パスコード解除' : null,
          args?.allowDownload !== undefined
            ? `DL許可→${args.allowDownload ? 'する' : 'しない'}`
            : null,
          args?.requireSignIn !== undefined
            ? `ログイン必須→${args.requireSignIn ? 'する' : 'しない'}`
            : null,
        ]
          .filter(Boolean)
          .join(' / ');
        return {
          content: [
            { type: 'text', text: `共有設定を更新しました（${changed || '変更なし'}）` },
          ],
        };
      }

      case 'upload-to-vimeo': {
        const r = await uploadToVimeo({
          idOrUuid: String(args?.meetingId),
          name: args?.name,
          description: args?.description,
          privacyView: args?.privacyView,
          password: args?.password,
          allowDownload: args?.allowDownload,
          embed: args?.embed,
        });
        return {
          content: [
            {
              type: 'text',
              text:
                `Vimeoへの取り込みを開始しました\n` +
                `対象: ${r.topic}（${r.sizeMb}MB）\n` +
                `リンク: ${r.link}\n` +
                `公開範囲: ${r.view}\n` +
                `状態: ${r.status}\n\n` +
                `※VimeoがZoomから直接取得するため、手元の回線は使いません。\n` +
                `※変換が終わるまで視聴できません。\`vimeo-status\` で「${r.uri}」を確認してください。\n` +
                `　目安は500MBで10〜30分です。`,
            },
          ],
        };
      }

      case 'vimeo-status': {
        const s = await vimeoStatus(String(args?.video));
        const done = s.status === 'available';
        return {
          content: [
            {
              type: 'text',
              text:
                `${s.name}\n` +
                `状態: ${s.status}（取り込み: ${s.upload} / 変換: ${s.transcode}）\n` +
                `尺: ${Math.floor((s.duration || 0) / 60)}分\n` +
                `公開範囲: ${s.view} / 埋め込み: ${s.embed}\n` +
                `リンク: ${s.link}\n\n` +
                (done
                  ? '視聴できる状態です。このURLをそのまま渡せます。'
                  : 'まだ処理中です。しばらく待ってから再度確認してください。'),
            },
          ],
        };
      }

      case 'vimeo-quota': {
        const q = await vimeoQuota();
        const gb = (x?: number) =>
          typeof x === 'number' ? `${(x / 1024 / 1024 / 1024).toFixed(2)} GB` : '—';
        const lines = [`${q.name}（プラン: ${q.plan}）`];
        if (q.space) {
          lines.push(
            `ストレージ: 空き ${gb(q.space.free)} / 上限 ${gb(q.space.max)} / 使用 ${gb(q.space.used)}`
          );
        }
        if (q.periodic?.max) {
          lines.push(
            `期間あたり: 空き ${gb(q.periodic.free)} / 上限 ${gb(q.periodic.max)}`
          );
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'delete-recording': {
        const uuid = String(args?.meetingUuid);

        // 安全装置1: 明示的な確認なしには消さない
        if (args?.confirm !== true) {
          return {
            content: [
              {
                type: 'text',
                text:
                  '削除は実行していません。\n' +
                  '本人に「この録画を消してよいか」を確認し、了承を得てから confirm: true で再実行してください。',
              },
            ],
          };
        }

        // 安全装置2: 文字起こしが手元に無いなら止める
        // （Zoomの録画を消すと文字起こしも一緒に消えるため、順番を守らせる）
        if (args?.skipTranscriptCheck !== true) {
          const recordings = await listRecordings(500, 12);
          const rec = recordings.find((r) => r.uuid === uuid || String(r.id) === uuid);
          if (rec && !findLocalTranscript(rec.topic, rec.start_time, rec.id)) {
            const where = ARCHIVE_ROOT
              ? `・一時置き場: ${DOWNLOAD_DIR}\n・保管場所: ${ARCHIVE_ROOT} の配下（ファイル名に日付と「文字起こし」が要ります）`
              : `・一時置き場: ${DOWNLOAD_DIR}\n※ ZOOM_ARCHIVE_ROOT が未設定のため、案件フォルダ側は探していません。\n  整形して案件フォルダへ移す運用なら、環境変数に案件フォルダの親のパスを設定してください。`;
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `削除を中止しました。\n\n` +
                    `「${rec.topic}」の文字起こしが見つかりません。\n` +
                    `**Zoomの録画を消すと文字起こしも一緒に消えます。** 議事録を作れなくなります。\n\n` +
                    `探した場所:\n${where}\n\n` +
                    `先に download-recordings を transcriptOnly: true で実行して、\n` +
                    `議事録まで作ってから削除してください。\n\n` +
                    `文字起こしが不要だと判断済みなら skipTranscriptCheck: true を付けて再実行できます。`,
                },
              ],
              isError: true,
            };
          }
        }

        await deleteRecording(uuid);
        return {
          content: [
            { type: 'text', text: '録画をゴミ箱へ移しました（30日以内はZoomの画面から復元できます）。' },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        { type: 'text', text: `エラー: ${error instanceof Error ? error.message : String(error)}` },
      ],
      isError: true,
    };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
  console.error('zoom-mtg-kit MCP server started');
}

// 試験からは import して関数だけ確かめたいので、その時はサーバーを起動しない
if (process.env.ZOOM_KIT_TEST !== '1') {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

// 削除の安全装置は「消したら戻らない」箇所なので、試験から直接確かめられるようにしておく
export { findLocalTranscript };
