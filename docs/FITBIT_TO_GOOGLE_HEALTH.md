# Fitbit Web API → Google Health API 移行設計書

## 背景・期限

Fitbit Web API は廃止され、Google Health API へ移行する。

| 時期 | 内容 |
|------|------|
| 2026年5月末 | Google Health API 利用可能（移行受付開始） |
| **2026年9月** | **旧 Fitbit Web API 停止 → データ同期が止まる** |

→ 2026年9月までに移行完了が必須。

参考:
- Fitbit公式: https://community.fitbit.com/t5/Web-API-Development/Introducing-the-next-phase-of-the-Fitbit-Web-API/td-p/5821061
- API仕様: https://developers.google.com/health/migration/api-specifications
- データアクセス/認可: https://developers.google.com/health/migration/data-access
- Google Cloud/OAuth設定: https://developers.google.com/health/setup
- スコープ: https://developers.google.com/health/scopes
- エンドポイント: https://developers.google.com/health/endpoints

---

## 新旧API対応表

| 項目 | 旧 Fitbit Web API | 新 Google Health API |
|------|-------------------|----------------------|
| 認可URL | `https://www.fitbit.com/oauth2/authorize` | `https://accounts.google.com/o/oauth2/v2/auth` |
| トークンURL | `https://api.fitbit.com/oauth2/token` | `https://oauth2.googleapis.com/token` |
| ベースURL | `https://api.fitbit.com/1` | `https://health.googleapis.com/v4` |
| 歩数取得 | `GET /user/-/activities/date/{date}.json` | `GET /v4/users/me/dataTypes/steps/dataPoints` |
| プロフィール | `GET /user/-/profile.json` | `GET /v4/users/me/profile` |
| スコープ | `activity profile heartrate sleep` | `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly` 他 |
| アクセストークン有効期限 | 8時間 | **1時間** |
| リフレッシュトークン取得 | 既定で発行 | 認可リクエストに **`access_type=offline`** が必須 |
| 認証ヘッダ | `Authorization: Bearer <token>` | 同左（`Accept: application/json` 推奨） |

### 重要な制約
- **既存のアクセス/リフレッシュトークンは引き継げない。** 全ユーザーが新統合へ**再同意（再連携）**が必要。
- アクセストークンが1時間で切れるため、**リフレッシュ処理は必須**（現行の `fetch_with_refresh` 相当をGoogle用に実装する）。

---

## 事前準備（Google Cloud 側 / コード変更前に必要）

1. **Google Cloud プロジェクト**作成
2. **Google Health API を有効化**
3. **OAuth 同意画面**を設定（スコープ `googlehealth.activity_and_fitness.readonly` を追加）
4. **OAuth クライアント（ウェブアプリ）**を作成し **Client ID / Client Secret** を取得
   - 承認済みリダイレクトURI: `<API_BASE_URL>/health/callback`
5. 取得した値を **Lambda 環境変数**に設定（下記）

### 追加する Lambda 環境変数
| キー | 用途 |
|------|------|
| `GOOGLE_CLIENT_ID` | Google OAuth クライアントID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth クライアントシークレット（秘密） |
| `GOOGLE_HEALTH_SCOPE` | `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly` |

---

## コード変更マップ（lambda_function.py）

現行の Fitbit ロジックは以下に隔離済み。Google Health 版を**並行して追加**し、切り替える方針が安全。

| 現行関数 | 変更内容 |
|----------|----------|
| `handle_fitbit_auth` | Google 認可URL（`accounts.google.com/o/oauth2/v2/auth`）を生成。`access_type=offline`・`scope=googlehealth...`・`response_type=code` を付与 |
| `handle_fitbit_callback` | トークン交換先を `oauth2.googleapis.com/token` に。`client_id`/`client_secret`/`code`/`grant_type=authorization_code`/`redirect_uri` を POST |
| `handle_fitbit_steps` | 取得先を `https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints` に。レスポンス形式が変わるため歩数の取り出しロジックを修正。401時リフレッシュ（1時間で失効するため重要） |

### フロントエンド（app.js / index.html）
- `connectFitbit()` の認可URL組み立てを Google 用に変更（または `/health/auth` へ寄せる）
- ボタン文言を「健康データと連携する」等に変更検討
- 全ユーザー再連携が必要なため、連携状態フラグ（`hasFitbit`）の扱いを見直し

### 移行期の方針（推奨）
- 旧 `fitbit_token` と新 `google_health_token` を**別キーで保存**し、当面は両対応にしておくと安全。
- 2026年9月以降、旧 Fitbit 経路を削除。

---

## チェックリスト

- [ ] Google Cloud プロジェクト作成・Health API 有効化
- [ ] OAuth 同意画面・スコープ設定
- [ ] OAuth クライアント作成 → Client ID/Secret 取得
- [ ] Lambda 環境変数追加（`GOOGLE_CLIENT_ID` 等）
- [ ] Lambda の auth/callback/steps を Google Health 用に実装
- [ ] フロントの連携ボタンを Google 用に変更
- [ ] 既存ユーザーへ「再連携のお願い」を周知
- [ ] 2026年9月までに本番切替、旧 Fitbit 経路を撤去
