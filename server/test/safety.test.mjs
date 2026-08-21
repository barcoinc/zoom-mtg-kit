/**
 * 削除の安全装置の試験。
 *
 * ここが壊れると **打ち合わせの記録が永久に失われる**（Zoomの録画を消すと文字起こしも消える）。
 * 「動くはず」で済ませてよい箇所ではないので、実際にフォルダを作って通しで確かめる。
 *
 *   node --test server/test/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-kit-test-'));
const EMPTY_DOWNLOADS = path.join(ROOT, '__downloads');

// 環境変数はモジュールの読み込み時に読まれるので、import より前に立てる
process.env.ZOOM_KIT_TEST = '1';
process.env.ZOOM_ACCOUNT_ID = 'test';
process.env.ZOOM_CLIENT_ID = 'test';
process.env.ZOOM_CLIENT_SECRET = 'test';
process.env.ZOOM_USER_EMAIL = 'me';
process.env.ZOOM_ARCHIVE_ROOT = ROOT;
process.env.ZOOM_DOWNLOAD_DIR = EMPTY_DOWNLOADS;

const { findLocalTranscript } = await import('../dist/index.js');

/** Zoomが返す start_time はUTC。開催時刻(JST)から9時間引いた形で書く */
const JST = (s) => s;

const write = (rel, body = '本文') => {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

before(() => {
  fs.mkdirSync(EMPTY_DOWNLOADS, { recursive: true });

  // 案件A: 初期値どおりの形（meetings/ ・ YYYY-MM-DD）
  write('みどり商事様/Zoomリンク.md', '# みどり商事様\n\n- ミーティングID: 1234567890\n');
  write('みどり商事様/meetings/2026-08-19_文字起こし.md');

  // 案件B: IDは書いてあるが、文字起こしを保存し忘れている
  write('あおぞら工房様/Zoomリンク.md', '# あおぞら工房様\n\n- ミーティングID: 2345678901\n');

  // 案件C: 利用者が形を変えた場合（context/ ・ YYMMDD）
  write('たなか先生/context/10_zoom-mtg-link.md', '- ミーティングID: 3456789012\n');
  write('たなか先生/context/260810_たなかMTG_文字起こし.md');

  // 案件D: ミーティングIDを書き忘れた人。手がかりはフォルダ名だけ
  write('さくら不動産/meetings/2026-08-12_文字起こし.md');
});

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('ミーティングIDで案件を特定して、その中の文字起こしを見つける', () => {
  const hit = findLocalTranscript('みどり商事様 お打ち合わせ', JST('2026-08-19T06:01:28Z'), 1234567890);
  assert.ok(hit?.endsWith('みどり商事様/meetings/2026-08-19_文字起こし.md'), `見つからない: ${hit}`);
});

test('【最重要】保存し忘れた案件を、同じ日の他案件のファイルで代用しない', () => {
  // ここが緩むと「別の案件の議事録は取れているから消してよい」と誤判定し、記録が消える
  const hit = findLocalTranscript('あおぞら工房様 お打ち合わせ', JST('2026-08-19T07:02:36Z'), 2345678901);
  assert.equal(hit, null);
});

test('案件フォルダの形を変えても働く（context/ ・ YYMMDD）', () => {
  const hit = findLocalTranscript('【たなか先生】ZOOMミーティング', JST('2026-08-10T10:59:48Z'), 3456789012);
  assert.ok(hit?.endsWith('260810_たなかMTG_文字起こし.md'), `見つからない: ${hit}`);
});

test('ミーティングIDを書き忘れても、件名の手がかりで見つける', () => {
  const hit = findLocalTranscript('さくら不動産 定例', JST('2026-08-12T07:42:38Z'), 999999);
  assert.ok(hit?.endsWith('さくら不動産/meetings/2026-08-12_文字起こし.md'), `見つからない: ${hit}`);
});

test('どこにも無ければ「無い」と答える（迷ったら消させない）', () => {
  const hit = findLocalTranscript('ヤマダ工務店 打合せ', JST('2026-08-19T01:00:00Z'), 111111);
  assert.equal(hit, null);
});

test('日付が違うファイルは当てにしない', () => {
  const hit = findLocalTranscript('みどり商事様 お打ち合わせ', JST('2026-08-25T06:01:28Z'), 1234567890);
  assert.equal(hit, null);
});
