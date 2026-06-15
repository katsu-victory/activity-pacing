# 移行・運用ガイド (Activity Pacing App)

別AWSアカウント／別ドメインへ移行するための手順と、設定値の所在をまとめる。
基本方針: **URL・ID・シークレットはコードに直書きせず、設定値（環境変数 / config.js）に集約する。**

---

## 1. 構成概要

| レイヤ | 実体 | 設定の所在 |
|--------|------|-----------|
| フロントエンド | `index.html`, `app.js`, `admin.html` ほか静的ファイル | `config.js`（1ファイル） |
| バックエンド | `lambda_function.py`（API Gateway 経由で呼ばれる） | Lambda 環境変数 |
| DB | DynamoDB: `ActivityPacing_Main`, `ActivityPacing_Logs` | Lambda 環境変数（テーブル名） |
| 外部連携 | LINE (LIFF), Fitbit, Bedrock, SES | config.js + Lambda 環境変数 |

---

## 2. フロントエンド設定（config.js）

`config.js` の値を差し替えるだけでよい。コード本体には直書きしない。

```js
window.AWS_CONFIG = { apiBase: "<API GatewayのベースURL>" };
window.APP_CONFIG = {
    liffId: "<LIFF ID>",
    fitbitClientId: "<Fitbit Client ID（公開情報）>"
};
```

- リダイレクト系は `window.location.origin` から自動導出するため、ホスト名の直書きは不要。
- `index.html` / `admin.html` の両方が `config.js` を読み込む。

---

## 3. Lambda 環境変数

`lambda_function.py` は以下を環境変数から読む（未設定時は現行値をデフォルト）。
**シークレットは必ず環境変数 / Secrets Manager に設定すること。**

| 環境変数 | 用途 | 例 |
|----------|------|----|
| `DYNAMODB_TABLE_MAIN` | メインテーブル名 | `ActivityPacing_Main` |
| `DYNAMODB_TABLE_LOGS` | ログテーブル名 | `ActivityPacing_Logs` |
| `BEDROCK_MODEL_ID` | 生成AIモデル | `anthropic.claude-3-5-sonnet-20240620-v1:0` |
| `SES_SENDER_EMAIL` | 通知メール送信元（SES検証済み） | `noreply@example.com` |
| `API_BASE_URL` | API Gateway 公開ベースURL | `https://xxxx.execute-api.<region>.amazonaws.com/Prod` |
| `FRONTEND_URL` | フロント公開URL（Fitbit連携後の戻り先） | `https://<本番ドメイン>` |
| `FITBIT_CLIENT_ID` | Fitbit Client ID | `23TRN8` |
| `FITBIT_CLIENT_SECRET` | **Fitbit Client Secret（秘密）** | （Secrets Manager 推奨） |
| `GOOGLE_CLIENT_ID` | Google OAuth クライアントID | Google Health 連携用 |
| `GOOGLE_CLIENT_SECRET` | **Google OAuth シークレット（秘密）** | Google Health 連携用 |
| `GOOGLE_HEALTH_SCOPE` | スコープ | `.../auth/googlehealth.activity_and_fitness.readonly` |
| `LINE_CHANNEL_ACCESS_TOKEN` | **LINE Messaging API チャネルアクセストークン（秘密）** | プッシュ通知用 |
| `REMINDER_LEAD_MIN` | 活動リマインドの「何分前」 | 既定 10 |
| `REMINDER_WINDOW_MIN` | リマインド判定の窓（EventBridge実行間隔と揃える） | 既定 10 |

---

## 4. 新AWSアカウントへの移行手順

1. **DynamoDB** 作成: `ActivityPacing_Main`, `ActivityPacing_Logs`
   - Main: パーティションキー `param`（文字列）
   - Logs: パーティションキー `subjectId`、ソートキー `timestamp`
   - 既存データを移行する場合はエクスポート/インポート
2. **IAM ロール**: Lambda に DynamoDB / Bedrock / SES の権限を付与
3. **Lambda** デプロイ: `lambda_function.py`（+ `requirements.txt` の依存をレイヤー化、特に pandas/numpy）
   - 上記「3. Lambda 環境変数」を設定
4. **API Gateway** 作成: 既存ルート（`/proposal`, `/auth/line`, `/subjects/...`, `/fitbit/...` など）を Lambda にプロキシ
5. **フロント** デプロイ: 静的ファイルをホスティングへ。`config.js` の `apiBase` を新 API Gateway URL に更新
6. **外部コンソール更新**:
   - **LINE Developers**: LIFF のエンドポイントURLを新フロントURLに変更
   - **Fitbit dev**: コールバックURLを `<API_BASE_URL>/fitbit/callback` に変更
7. **Bedrock**: 対象リージョンで Claude 3.5 Sonnet のモデルアクセスを有効化
8. **SES**: 送信元アドレスを検証（サンドボックス解除が必要なら申請）

---

## 5. 既知の要対応事項（セキュリティ / 技術的負債）

- [ ] **Fitbit Client Secret** を旧コードから除去済み。環境変数へ設定すること。過去にコードへ直書きされていたため**ローテーション推奨**。
- [ ] **Firebase APIキー** が旧 `firebase-config.js`（削除済み）に含まれていた。Git履歴に残るため**ローテーション推奨**。
- [ ] ホスティングが S3 / CloudFront / Amplify で混在 → **1つに統一**して URL 混在を解消する（未決定）。
- [ ] Service Worker (`sw.js`) は現在 `index.html` 側で毎回登録解除しており PWA は実質無効。方針を決める。
