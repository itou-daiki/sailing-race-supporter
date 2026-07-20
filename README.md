# Sailing Race Supporter

Created by Dit-Lab.（Daiki ITO）

セーリングレースのコース設営、マーク・運営ボート位置、風、信号、運営連絡を一つのリアルタイム地図で扱うWebアプリケーションです。

O2/I2/W2等の回航順に沿ったコース線、地図上のマーク番号、担当マークボート別の風向・風速（kt / m/s）、大会管理者の地図タップ配置に対応します。O2/I2は1–4と2–3を平行にした標準トラペゾイド形状で、3ゲートは2マークの風下側へ提案します。再読込時は大会で設定した海面またはレースのマーク範囲へ自動復帰します。運用ボードには、初学者向けの「次にやること」、全レース俯瞰、通信・観測の鮮度警告、5ステップガイドを表示します。

スタートシーケンスの「通知・画面維持」から端末の運営モードを有効にすると、アプリ／PWAを開いている間、予告20・10・5・1分前と予定時刻に参考通知を表示し、対応端末では画面スリープを抑止します。公式音響とは独立しており、延期中は旧予定の通知を停止します。

大会管理者はパスキーで本人確認し、1個だけの場合は大会URL発行時に一回限りのオーナー復旧キットを暗号化保存します。復旧時は旧パスキー・旧セッション・旧キットを失効し、新しいパスキーとキットへローテーションします。

大会URL単位または1R・2R等のレース単位で、運営ログをJSON、CSV、PDF保存用の印刷レポートとして出力できます。PDFレポートには大会名、対象範囲、出力日時、監査連番・イベントハッシュ、アプリ名と作成者表記が含まれます。

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
npm run test:all
npm run build
npm run preview
```

`npm run test:all` はブラウザー／ロジックの単体テストに加え、Cloudflareのworkerd上でD1マイグレーション、Durable Objectsの永続化、Workerエントリーポイントを検証します。

`npm run build` はWranglerに依存しないPages専用ビルドです。`dist` に静的クライアントと、本番Workerへパス・クエリを保ったまま転送するPagesルールを生成します。
Worker統合成果物を確認する場合は `npm run build:cloudflare`、Workers
Runtimeで確認する場合は `npm run preview` を使用します。

## Cloudflare

Cloudflare Pagesを公開入口として使う場合は、次を設定します。

- Framework preset: React (Vite)
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: 空欄

Pages URLへのアクセスは、自動的に本番Workerへ転送されます。これにより、どちらの公開URLを共有してもパスキー登録と大会URL発行が使える入口へ到達します。

本番はCloudflare Workers Static Assetsを使用し、Worker API、SQLite-backed Durable Objects、D1、日次Cronを同じプロジェクトへ接続します。R2とWorkers Paidプランは使用せず、上限超過時に課金されないFreeプラン構成です。長期バックアップは端末でAES-GCM暗号化したファイル、短期復旧はD1 Time Travel（Freeは7日）を使用します。初回手順は[DEPLOYMENT.md](./DEPLOYMENT.md)を参照してください。
