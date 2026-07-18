# Sailing Race Supporter

Created by Dit-Lab.（Daiki ITO）

セーリングレースのコース設営、マーク・運営ボート位置、風、信号、運営連絡を一つのリアルタイム地図で扱うWebアプリケーションです。

スタートシーケンスの「通知・画面維持」から端末の運営モードを有効にすると、アプリ／PWAを開いている間、予告20・10・5・1分前と予定時刻に参考通知を表示し、対応端末では画面スリープを抑止します。公式音響とは独立しており、延期中は旧予定の通知を停止します。

大会管理者はパスキーで本人確認し、1個だけの場合は大会URL発行時に一回限りのオーナー復旧キットを暗号化保存します。復旧時は旧パスキー・旧セッション・旧キットを失効し、新しいパスキーとキットへローテーションします。

- [仕様書](./SPECIFICATION.md)
- [Cloudflare本番公開手順](./DEPLOYMENT.md)

## 開発

```bash
npm install
npm run db:migrate:local
npm run dev
```

検証用コマンド:

```bash
npm run lint
npm test
npm run build
npm run preview
```

`npm run build` はWranglerに依存しないPages専用ビルドで、静的クライアントだけを `dist` に生成します。
Worker統合成果物を確認する場合は `npm run build:cloudflare`、Workers
Runtimeで確認する場合は `npm run preview` を使用します。

## Cloudflare

Cloudflare Pagesでフロントエンドだけを確認する場合は、次を設定します。

- Framework preset: React (Vite)
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: 空欄

本番はCloudflare Workers Static Assetsを使用し、Worker API、SQLite-backed Durable Objects、D1、暗号化バックアップ用R2、日次Cronを同じプロジェクトへ接続します。`wrangler.worker.jsonc`のD1 IDはローカル開発用の仮値なので、初回デプロイ前に実際のD1データベースIDへ置き換えます。PagesのGitビルドとWorkers設定は分離済みです。初回手順は[DEPLOYMENT.md](./DEPLOYMENT.md)を参照してください。
