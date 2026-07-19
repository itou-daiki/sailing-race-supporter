# Cloudflare本番公開手順

Sailing Race Supporter v0.3は、Cloudflare Pagesを公開入口、本番運用を静的アセット、API、Durable Objects、D1、日次Cronを一つにしたCloudflare Workerとして使用します。Pages URLは本番Workerへ自動転送されるため、共有する入口を間違えても大会発行画面へ到達できます。

## 1. Pages（公開入口）

- Framework preset: React (Vite)。選択肢にない場合はNone
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: 空欄
- Environment variables: 不要

`npm run build` はPages専用のVite設定で `dist` にブラウザー用の静的資産と
`_redirects` を生成します。Pagesの全パスとクエリを
`https://sailing-race-supporter.dddd-sailing470.workers.dev` へ302転送します。
既にPages版のService Workerを使用していた端末も、移行用Service Workerがキャッシュを削除して
本番Workerへ移動します。ビルド経路自体はWrangler、ローカル用Secret、Workerバンドル、
Worker設定、ソースマップを読み込みません。

Workers公開時の `npm run build:cloudflare` はブラウザー用資産を `dist/client` に
残し、`wrangler.worker.jsonc` がそのディレクトリをStatic Assetsとして配信します。

Pages自体の `/api/*` はバックエンドではありません。パスキー、大会URL発行、招待、リアルタイム同期、D1保存は、転送先のWorkerが処理します。

## 2. Cloudflareへログイン

トークンをチャットやリポジトリへ保存しないでください。ローカルの対話ターミナルで実行します。

```bash
npx wrangler login
npx wrangler whoami
```

CIから公開する場合だけ、必要最小権限の `CLOUDFLARE_API_TOKEN` をGitHub ActionsのSecretへ登録します。`.env`やソースコードには置きません。

## 3. D1を作成

本構成では支払い・決済登録を必要としないCloudflare Freeプランだけを使用します。R2は無料利用量があってもsubscription checkoutが必要なため、設定もバインドもしません。

```bash
npx wrangler d1 create sailing-race-supporter
```

出力された `database_id` を [wrangler.worker.jsonc](./wrangler.worker.jsonc) の `database_id` に設定します。初期値のゼロUUIDのままでは、デプロイ前検査が停止します。

D1 Time TravelはFreeプランでも自動的に有効で、過去7日以内の任意の時点へ復旧できます。長期保管は大会管理画面から端末へダウンロードする暗号化 `.srs-backup` を使用します。

## 4. バックアップ署名鍵を準備

大会バックアップはEd25519で署名します。初回だけ、ローカルで鍵ペアを作成します。

```bash
npm run backup-key:generate
```

- 公開鍵と鍵IDは `config/backup-signing-keys.json` に追加され、ブラウザとWorkerが検証に使用します。このファイルはコミットします。
- 秘密鍵はGit管理外の `.dev.vars` だけに保存されます。内容をチャット、Issue、ログへ貼り付けないでください。
- `npm run deploy:worker` は、Git管理外の秘密鍵だけを権限0600の一時ファイルへ取り出し、`wrangler deploy --secrets-file` でコードと同じWorker版へ登録します。一時ファイルは成功・失敗にかかわらず削除し、秘密値を画面へ表示しません。
- `wrangler secret put` はSecret更新と同時にWorkerを直ちに本番配信するため、本プロジェクトの初回公開と鍵ローテーションには使用しません。

鍵をローテーションするときも `npm run backup-key:generate` を使い、公開鍵をコミットしてから `npm run deploy:worker` を実行します。過去バックアップを検証できるよう、既存公開鍵は設定から削除しません。

## 5. マイグレーションとWorker公開

```bash
npm run cf:check
npm run db:migrate:remote
npm run cf:preflight
npm run deploy:worker
```

`npm run cf:preflight` はCloudflare上のD1を読み取り、D1未適用マイグレーションとローカル署名鍵の欠落を本番公開前に停止します。`npm run deploy:worker` も同じ検査を再実行してからビルド・公開します。R2の有効化状態には依存しません。

`wrangler.worker.jsonc` は `BACKUP_SIGNING_PRIVATE_KEY` を必須Secretとして宣言し、デプロイスクリプトはその値をコードと同じアップロードへ渡します。値が欠けていればWorker公開前に停止します。Pagesの画面確認ビルドには秘密鍵を設定しません。Workers設定を専用ファイルへ分離しているため、PagesのGitビルドがD1・Durable Objects設定をPages設定として誤検出することもありません。

## 6. 公開後の確認

Wranglerが表示した `https://sailing-race-supporter.<subdomain>.workers.dev` を使います。

```bash
curl https://sailing-race-supporter.<subdomain>.workers.dev/api/health
```

JSONの `status` が `ok`、`version` が `0.3.0` であることを確認します。そのURLをブラウザーで開き、パスキー登録後に最初の大会URLを発行します。

大会管理画面から暗号化バックアップを端末へ保存し、別ブラウザーまたは別端末で同じファイルを選択してください。「大会データ全体 SHA-256」「監査ログの連番・ハッシュチェーン」「監査最終ルート」「Ed25519 サーバー署名」がすべて成功し、復元操作が有効になることを確認します。暗号化ファイルは少なくとも2か所へ複製し、パスフレーズは別経路で保管します。

D1を過去時点へ戻す必要がある場合は、まず現在状態をローカルへエクスポートし、対象時刻を確認してから次を実行します。復元はデータベース全体を上書きするため、通常の大会内ロールバックではなく災害復旧に限定します。

```bash
npx wrangler d1 time-travel info sailing-race-supporter --timestamp="2026-07-19T00:00:00+09:00" --config wrangler.worker.jsonc
npx wrangler d1 time-travel restore sailing-race-supporter --timestamp="2026-07-19T00:00:00+09:00" --config wrangler.worker.jsonc
```

Freeプランで指定できる時点は過去7日以内です。復元後に表示される「復元前のbookmark」は、操作を取り消すため必ず保存します。

大会管理者の有効なパスキーが1個だけの場合、最初の大会URL発行直後にオーナー復旧キットが一度だけ表示されます。10文字以上のパスフレーズで暗号化ファイルを保存し、画面のスクリーンショットも別の安全な保管先へ保存してから確認を完了してください。サーバーには復旧コードのハッシュだけが残ります。可能なら本人確認画面から別端末またはセキュリティキーへ2個目のパスキーも追加します。

本番導入前に、検証用大会で次の復旧訓練を1回行います。

1. 別ブラウザーまたは新端末で「大会オーナー復旧キットを使う」を開く。
2. 大会URLと手入力コード、または暗号化ファイルとパスフレーズを入力する。
3. 新しいパスキーを登録し、新しく発行された復旧キットを保存する。
4. 旧端末のセッション、旧パスキー、使用済みコードでアクセスできず、新パスキーだけが有効であることを確認する。

復旧コードを失い、かつ登録済みパスキーをすべて失った場合、URL参加者やPRO/ROから大会オーナー権限を自己申告で取得する経路はありません。署名検証済みのローカルバックアップから新しい大会を作る災害復旧手順を使用します。

無料枠向けの日次保持処理は毎日04:17（日本時間）に1回だけ実行します。位置情報はDurable Objectsでライブ配信し、D1には原則60秒間隔で保存します。

## 7. 独自ドメイン（任意）

WorkersのSettings > Domains & Routesから独自ドメインを追加します。運用開始後はWebAuthnのRP IDとオリジンが変わるため、公開URLを途中で変更しない運用を推奨します。
