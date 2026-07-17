# Sailing Race Supporter

Created by Dit-Lab.（Daiki ITO）

セーリングレースのコース設営、マーク・運営ボート位置、風、信号、運営連絡を一つのリアルタイム地図で扱うWebアプリケーションです。

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
```

## Cloudflare

Cloudflare Pagesでフロントエンドだけを確認する場合は、次を設定します。

- Framework preset: React (Vite)
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: 空欄

本番はCloudflare Workers Static Assetsを使用し、Worker API、SQLite-backed Durable Objects、D1、日次Cronを同じプロジェクトへ接続します。`wrangler.jsonc`のD1 IDはローカル開発用の仮値なので、初回デプロイ前に実際のD1データベースIDへ置き換えます。初回手順は[DEPLOYMENT.md](./DEPLOYMENT.md)を参照してください。
