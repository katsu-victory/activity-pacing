/*
 * 集約設定ファイル (Centralized runtime config)
 * ------------------------------------------------------------
 * 別AWSアカウント / 別ドメインへ移行する際は、このファイルの値を
 * 差し替えるだけで済むようにすること。コード本体にURLやIDを直書きしない。
 *
 * - apiBase        : API Gateway の公開ベースURL
 * - liffId         : LINE Developers の LIFF ID
 * - fitbitClientId : Fitbit アプリの Client ID (公開情報。Secretはバックエンド側のみ)
 */
window.AWS_CONFIG = {
    apiBase: "https://i3ar4264ka.execute-api.ap-northeast-1.amazonaws.com/Prod"
};
window.APP_CONFIG = {
    liffId: "2008978598-Ipe0zQRV",
    fitbitClientId: "23TRN8"
};
