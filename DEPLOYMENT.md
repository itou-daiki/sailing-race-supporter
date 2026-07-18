# Cloudflare本番公開手順

Sailing Race Supporter v0.3は、静的画面だけならCloudflare Pagesで確認できます。本番運用は、静的アセット、API、Durable Objects、D1、日次Cronを一つにしたCloudflare Workerを使用します。

## 1. Pages（画面確認のみ）

- Framework preset: React (Vite)。選択肢にない場合はNone
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: 空欄
- Environment variables: 不要

`npm run build` は `dist` をPages専用に整形し、ブラウザー用の静的資産だけを
残します。ローカル用Secret、Workerバンドル、Worker設定、ソースマップはPagesへ
アップロードしません。Pagesはトップレベルに `404.html` がないSPAを自動的に
`index.html`へフォールバックするため、追加のリダイレクト設定は不要です。

Workers公開時の `npm run build:cloudflare` はブラウザー用資産を `dist/client` に
残し、`wrangler.worker.jsonc` がそのディレクトリをStatic Assetsとして配信します。

Pagesの `/api/*` はバックエンドではありません。パスキー、大会URL発行、招待、リアルタイム同期、D1保存を使うには次のWorker公開が必要です。

## 2. Cloudflareへログイン

トークンをチャットやリポジトリへ保存しないでください。ローカルの対話ターミナルで実行します。

```bash
npx wrangler login
npx wrangler whoami
```

CIから公開する場合だけ、必要最小権限の `CLOUDFLARE_API_TOKEN` をGitHub ActionsのSecretへ登録します。`.env`やソースコードには置きません。

## 3. D1とR2を作成

```bash
npx wrangler d1 create sailing-race-supporter
npx wrangler r2 bucket create sailing-race-supporter-backups
```

出力された `database_id` を [wrangler.worker.jsonc](./wrangler.worker.jsonc) の `database_id` に設定します。初期値のゼロUUIDのままでは、デプロイ前検査が停止します。

R2には端末でAES-GCM暗号化済みの大会バックアップだけを保管します。平文とパスフレーズは送信しません。バケット名を変更する場合は `wrangler.worker.jsonc` の `BACKUP_ARCHIVES` バインディングも同時に変更してください。

## 4. バックアップ署名鍵を登録

大会バックアップはEd25519で署名します。初回だけ、ローカルで鍵ペアを作成します。

```bash
npm run backup-key:generate
```

- 公開鍵と鍵IDは `config/backup-signing-keys.json` に追加され、ブラウザとWorkerが検証に使用します。このファイルはコミットします。
- 秘密鍵はGit管理外の `.dev.vars` だけに保存されます。内容をチャット、Issue、ログへ貼り付けないでください。
- Cloudflareへ秘密鍵を安全に登録するには、ログイン済みの対話ターミナルで次を実行します。スクリプトは秘密値を画面へ表示しません。

```bash
npm run cf:secret:backup-signing
```

鍵をローテーションするときも `npm run backup-key:generate` を使います。過去バックアップを検証できるよう、既存公開鍵は設定から削除しません。新しい公開鍵のコミットと新しい秘密鍵の登録を同じ公開作業で行います。

## 5. マイグレーションとWorker公開

```bash
npm run cf:check
npm run db:migrate:remote
npm run deploy:worker
```

R2バケットは暗号化大会バックアップに使用するため必須です。1大会20世代、1世代25MiB、合計500MiBをアプリ側で上限とし、初期保存期間は大会終了後365日です。

`wrangler.worker.jsonc` は `BACKUP_SIGNING_PRIVATE_KEY` を必須Secretとして宣言しているため、未登録ならWorker公開は停止します。Pagesの画面確認ビルドには秘密鍵を設定しません。Workers設定を専用ファイルへ分離しているため、PagesのGitビルドがD1・R2・Durable Objects設定をPages設定として誤検出することもありません。

## 6. 公開後の確認

Wranglerが表示した `https://sailing-race-supporter.<subdomain>.workers.dev` を使います。

```bash
curl https://sailing-race-supporter.<subdomain>.workers.dev/api/health
```

JSONの `status` が `ok`、`version` が `0.3.0` であることを確認します。そのURLをブラウザーで開き、パスキー登録後に最初の大会URLを発行します。

大会管理画面から暗号化バックアップを一度ローカルとR2へ保存し、R2一覧から端末へ再取得して選択してください。「大会データ全体 SHA-256」「監査ログの連番・ハッシュチェーン」「監査最終ルート」「Ed25519 サーバー署名」がすべて成功し、復元操作が有効になることを確認します。

無料枠向けの日次保持処理は毎日04:17（日本時間）に1回だけ実行します。位置情報はDurable Objectsでライブ配信し、D1には原則60秒間隔で保存します。

## 7. 独自ドメイン（任意）

WorkersのSettings > Domains & Routesから独自ドメインを追加します。運用開始後はWebAuthnのRP IDとオリジンが変わるため、公開URLを途中で変更しない運用を推奨します。
