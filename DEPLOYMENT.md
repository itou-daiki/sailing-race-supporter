# Cloudflare本番公開手順

Sailing Race Supporter v0.3は、静的画面だけならCloudflare Pagesで確認できます。本番運用は、静的アセット、API、Durable Objects、D1、日次Cronを一つにしたCloudflare Workerを使用します。

## 1. Pages（画面確認のみ）

- Framework preset: React (Vite)。選択肢にない場合はNone
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: 空欄
- Environment variables: 不要

Pagesの `/api/*` はバックエンドではありません。パスキー、大会URL発行、招待、リアルタイム同期、D1保存を使うには次のWorker公開が必要です。

## 2. Cloudflareへログイン

トークンをチャットやリポジトリへ保存しないでください。ローカルの対話ターミナルで実行します。

```bash
npx wrangler login
npx wrangler whoami
```

CIから公開する場合だけ、必要最小権限の `CLOUDFLARE_API_TOKEN` をGitHub ActionsのSecretへ登録します。`.env`やソースコードには置きません。

## 3. D1を作成

```bash
npx wrangler d1 create sailing-race-supporter
```

出力された `database_id` を [wrangler.jsonc](./wrangler.jsonc) の `database_id` に設定します。初期値のゼロUUIDのままでは、デプロイ前検査が停止します。

## 4. マイグレーションとWorker公開

```bash
npm run cf:check
npm run db:migrate:remote
npm run deploy:worker
```

初期リリースでは添付ファイル機能を公開していないため、R2バケットは必須にしていません。写真・音声を有効化する段階でR2を追加します。

## 5. 公開後の確認

Wranglerが表示した `https://sailing-race-supporter.<subdomain>.workers.dev` を使います。

```bash
curl https://sailing-race-supporter.<subdomain>.workers.dev/api/health
```

JSONの `status` が `ok`、`version` が `0.3.0` であることを確認します。そのURLをブラウザーで開き、パスキー登録後に最初の大会URLを発行します。

無料枠向けの日次保持処理は毎日04:17（日本時間）に1回だけ実行します。位置情報はDurable Objectsでライブ配信し、D1には原則60秒間隔で保存します。

## 6. 独自ドメイン（任意）

WorkersのSettings > Domains & Routesから独自ドメインを追加します。運用開始後はWebAuthnのRP IDとオリジンが変わるため、公開URLを途中で変更しない運用を推奨します。
