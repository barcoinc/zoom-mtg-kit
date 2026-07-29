# セットアップ手順

所要 15〜20分。上から順にやれば終わります。

---

## 0. 前提（ここを満たしていないと動きません）

| 必要なもの | 確認方法 |
|---|---|
| **Zoomの有料プラン（Pro以上）** | 無料プランでは**クラウド録画が使えません**。ここが唯一の必須課金です |
| **Zoomアカウントの管理者権限** | アプリを作るのにオーナーまたは管理者である必要があります |
| **Claude Code** | インストール済みであること |
| **Node.js 18以上** | ターミナルで `node -v` |

---

## 1. Zoomで「音声文字起こし」をONにする ★最重要

**ここを飛ばすと文字起こしが作られず、議事録が作れません。**

1. https://zoom.us/profile/setting にアクセス
2. 上のタブから **「記録」**（Recording）を選ぶ
3. **「クラウド記録」** をONにする
4. その下の **「詳細クラウド記録設定」** を開く
5. **「音声文字起こしを作成」**（Create audio transcript）に**チェックを入れて保存**

これで、録画が終わったあとにZoomが自動で文字起こし（VTTファイル）を作ってくれるようになります。

> 会議終了から文字起こしが出来上がるまで、**60分の会議でおおよそ30〜60分**かかります。すぐに出てこなくても壊れていません。

---

## 2. Zoomアプリ（認証情報）を作る

1. https://marketplace.zoom.us/ にZoomアカウントでサインイン
2. 右上 **Develop** → **Build App**
3. **「Server-to-Server OAuth」** を選んで **Create**
4. アプリ名を入力（例: `MTG Kit`）→ **Create**

### 2-1. 認証情報を控える

**App Credentials** の画面に出てくる次の3つをコピーしておきます。

- **Account ID**
- **Client ID**
- **Client Secret**

> **この3つは絶対に他人に渡さないでください。** これを渡すと、相手があなたのZoom録画すべてにアクセスできます。

### 2-2. Information を埋める

**Information** タブで、会社名・開発者名・連絡先メールを入力します（必須項目のみでOK）。

### 2-3. Scopes（権限）を追加する ★ここが肝心

**Scopes** タブ → **Add Scopes** で、以下を追加します。

検索ボックスに `meeting` / `recording` と入れて、以下を探してチェックします。

| 何のため | スコープ名 |
|---|---|
| ミーティングを作る | `meeting:write:meeting:admin` |
| ミーティングを読む（URL・パスコード・日時） | `meeting:read:meeting:admin` |
| ミーティング一覧 | `meeting:read:list_meetings:admin` |
| 設定変更（自動録画のON/OFF） | `meeting:update:meeting:admin` |
| 録画一覧 | `cloud_recording:read:list_user_recordings:admin` |
| 録画ファイルの取得 | `cloud_recording:read:list_recording_files:admin` |
| 共有設定を読む | `cloud_recording:read:recording_settings:admin` |
| 共有設定を変える（パスコード解除など） | `cloud_recording:update:recording_settings:admin` |
| 録画の削除 | `cloud_recording:delete:meeting_recording:admin` |

> スコープ名はZoomの画面のバージョンによって表記が少し違います（`:admin` が付かないものもあります）。
> **`meeting` と `recording` で検索して、read / write / update / delete が付くものを一通りチェック**すれば確実です。
>
> **最初から全部入れておいてください。** あとから足すこともできますが、そのたびにアプリの再アクティベートが必要になります。
> なお不足している場合は、このキットが**足りないスコープ名を名指しで教えてくれる**ので、それを見て追加すれば大丈夫です。

### 2-4. アプリを有効化

**Activation** タブ → **Activate your app** を押します。緑色になれば完了です。

---

## 3. サーバーを設置する

ターミナルで、この`zoom-mtg-kit`フォルダの中に入って実行します。

```bash
cd server
npm install
npm run build
cp .env.local.example .env.local
```

次に `server/.env.local` をテキストエディタで開き、**2-1で控えた3つ**と、**Zoomにログインしているメールアドレス**を入れます。

```
ZOOM_ACCOUNT_ID=（Account ID）
ZOOM_CLIENT_ID=（Client ID）
ZOOM_CLIENT_SECRET=（Client Secret）
ZOOM_USER_EMAIL=（Zoomのログインメールアドレス）
```

---

## 4. Claude Codeに登録する

ターミナルで以下を実行します（パスは実際の設置場所に置き換えてください）。

```bash
claude mcp add zoom-mtg-kit -- node /絶対パス/zoom-mtg-kit/server/dist/index.js
```

Claude Codeを再起動し、`/mcp` と打って `zoom-mtg-kit` が出てくれば成功です。

---

## 5. 動作確認

Claude Codeで、そのまま日本語で話しかけます。

```
Zoomの録画一覧を見せて
```

一覧が返ってくればセットアップ完了です。録画がまだ無い場合は「録画が見つかりませんでした」と出ますが、それも正常です。

続けて、案件用のリンクを1本作ってみてください。

```
〇〇社の打ち合わせ用にZoomリンクを作って
```

---

## つまずいた時

| 症状 | 原因と対処 |
|---|---|
| `環境変数 ZOOM_... が未設定です` | `server/.env.local` が無いか、値が空です。手順3をやり直してください |
| `Zoomアプリのスコープが足りません` | 2-3で入れ忘れています。追加後、**Activationで再アクティベート**が必要です |
| 録画はあるのに文字起こし(TRANSCRIPT)が無い | **手順1をやっていません。** 設定を入れても、**入れる前に録った分には文字起こしは作られません** |
| ファイルサイズが全部0バイト | Zoom側でまだ変換中です。60分の会議で30〜60分かかります |
| 参加URLを配ったら相手が入れない | URLに `/u/4/` のようなアカウント指定が混ざっています。**必ず削ってから配ってください**（ブラウザのアドレスバーからコピーすると混ざります） |
