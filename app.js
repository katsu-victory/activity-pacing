console.log("TEST V149");
/* oncology_app/app.js - AWS (API Gateway + Lambda + DynamoDB) backend */

/* ===== 共通状態 / State ===== */
const STORAGE_KEY_VO2 = "eo_vo2_records_v1";

const AppState = {
    // Data Models (Firestore)
    subject: null,
    project: null,
    exercises: [],
    projects: [],
    categories: [],

    // OpenAPI Synced State (V141)
    dailyState: {
        energy_budget_0_100: 75,
        fatigue_0_10: 5,
        pain_0_10: 0,
        sleep_quality: 1 // 0=poor, 1=ok, 2=good
    },
    settings: {
        week_goal_value: 1380, // MET-min (23 MET-h * 60)
        intensity_cap: "MODERATE",
        visibility: {
            "nav-home": true,
            "nav-plan": true,
            "nav-program": true,
            "nav-measure": true,
            "nav-tools": true,
            "nav-cloud": true
        }
    },

    // UI State
    vo2Records: [],
    vo2Chart: null,
    currentVo2max: null,
    weight: 60,
    isCelebrated: false,
    dailyPlan: [], // [{ title, startMinute, planned_duration_min, planned_mets, isAI, isDone }, ...]
    config: {
        startHour: 7,
        endHour: 22
    },
    version: "20260210_V177",
    homeMode: "input", // or "result"
    dailyConditionSubmitted: false,
    weeklyMets: 0,
    achieved_met_min_total: 0, // V141: Added for MET-min tracking
    isQuickPlanning: false,
    stepsToday: 0,
    stepsYesterday: 0
};

// 1分あたりの高さ(px)
const PX_PER_MIN = 2;

/* Globals for New Plan Screen */
window.openScheduleSettings = function () {
    const modal = document.getElementById('modal-config');
    if (modal) {
        document.getElementById('config-start-hour').value = AppState.config.startHour;
        document.getElementById('config-end-hour').value = AppState.config.endHour;
        modal.classList.remove('hidden');
    }
};


/* Util for Safe URL Generation */
function getApiUrl(path) {
    // Validates window.AWS_CONFIG presence
    const config = window.AWS_CONFIG || {};
    const base = config.apiBase || "";
    // Robust join (removes trailing slash from base, leading slash from path)
    const cleanBase = base.replace(/\/+$/, '');
    const cleanPath = path.replace(/^\/+/, '');
    return `${cleanBase}/${cleanPath}`;
}

/* Util for JST Time String */
function getJSTTimeStr(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* ===== METs 活動データベース (Backup / Static) ===== */
const ACTIVITY_DATABASE = [
    // Lifestyle
    { name: "座って読書・テレビ鑑賞", planned_mets: 1.3, category: "SELFCARE" },
    { name: "座って事務作業・PC作業", planned_mets: 1.5, category: "WORK" },
    { name: "立って会話・電話", planned_mets: 1.8, category: "OTHER" },
    { name: "皿洗い・立位での軽い家事", planned_mets: 1.8, category: "HOUSEWORK" },
    { name: "料理・食材の準備", planned_mets: 2.0, category: "HOUSEWORK" },
    { name: "洗濯物を干す・取り込む", planned_mets: 2.3, category: "HOUSEWORK" },
    { name: "植物への水やり", planned_mets: 2.5, category: "HOUSEWORK" },
    { name: "子どもと遊ぶ (立位・軽度)", planned_mets: 2.5, category: "OTHER" },
    { name: "掃除機をかける", planned_mets: 3.3, category: "HOUSEWORK" },
    { name: "床磨き・風呂掃除", planned_mets: 3.5, category: "HOUSEWORK" },
    { name: "子どもと遊ぶ (歩く/走る)", planned_mets: 4.0, category: "OTHER" },
    { name: "自転車での移動 (通勤・買い物)", planned_mets: 4.0, category: "OUTING" },
    { name: "階段を降りる", planned_mets: 3.5, category: "OTHER" },
    { name: "草むしり・庭仕事", planned_mets: 5.0, category: "HOUSEWORK" },
    { name: "家具の移動・運搬", planned_mets: 6.0, category: "HOUSEWORK" },
    { name: "雪かき", planned_mets: 6.0, category: "HOUSEWORK" },
    { name: "階段を上る (ゆっくり)", planned_mets: 4.0, category: "OTHER" },
    { name: "階段を上る (速く)", planned_mets: 8.8, category: "OTHER" },
    // Exercise
    { name: "ストレッチ・ヨガ(ハタ)", planned_mets: 2.5, category: "EXERCISE" },
    { name: "ゆっくりとした歩行 (散歩)", planned_mets: 3.0, category: "EXERCISE" },
    { name: "太極拳", planned_mets: 3.0, category: "EXERCISE" },
    { name: "ボウリング", planned_mets: 3.0, category: "EXERCISE" },
    { name: "卓球", planned_mets: 4.0, category: "EXERCISE" },
    { name: "ラジオ体操", planned_mets: 4.0, category: "EXERCISE" },
    { name: "速歩き (通勤・通学程度)", planned_mets: 4.3, category: "EXERCISE" },
    { name: "アクアビクス", planned_mets: 5.5, category: "EXERCISE" },
    { name: "かなり速歩き (運動目的)", planned_mets: 5.0, category: "EXERCISE" },
    { name: "ウェイトトレーニング（高強度）", planned_mets: 6.0, category: "EXERCISE" },
    { name: "ジョギング (ゆっくり)", planned_mets: 7.0, category: "EXERCISE" },
    { name: "テニス (シングルス)", planned_mets: 7.3, category: "EXERCISE" },
    { name: "登山", planned_mets: 7.3, category: "EXERCISE" },
    { name: "水泳（ゆっくり）", planned_mets: 8.0, category: "EXERCISE" },
    { name: "ランニング (9.7km/h)", planned_mets: 9.8, category: "EXERCISE" },
    { name: "縄跳び（速い）", planned_mets: 12.3, category: "EXERCISE" },
    // Proposal Specific
    { name: "スクワット", planned_mets: 5.0, category: "EXERCISE" },
    { name: "椅子からの立ち座り", planned_mets: 3.5, category: "EXERCISE" },
    { name: "深呼吸・リラックス", planned_mets: 1.2, category: "SELFCARE" }
];

const APP_MENUS = [
    { id: 'nav-home', label: 'ホーム', icon: '🏠', screen: 'screen-home' },
    { id: 'nav-plan', label: 'プラン', icon: '📝', screen: 'screen-plan' },
    { id: 'nav-program', label: '運動', icon: '🎬', screen: 'screen-program' },
    { id: 'nav-measure', label: '測定', icon: '🎮', screen: 'screen-measure' },
    { id: 'nav-tools', label: 'ツール', icon: '🧮', screen: 'screen-tools' },
    { id: 'nav-cloud', label: 'クラウド', icon: '☁️', screen: 'screen-cloud' }
];

/* ===== MOVE-CARE コアエンジン ===== */
const MoveCare = {
    // V141: Sync condition to AppState.dailyState
    get state() { return AppState.dailyState; },

    ui: {
        updateFatigue(v) {
            AppState.dailyState.fatigue_0_10 = parseInt(v, 10);
            document.getElementById("mc-val-fatigue").textContent = v;
        },
        setPain(v, btn) {
            AppState.dailyState.pain_0_10 = v;
            btn.parentNode.querySelectorAll(".mc-chip").forEach(c => c.classList.remove("selected"));
            btn.classList.add("selected");
        },
        setMood(v, btn) {
            // Mapping mood UI to energy_budget
            if (v === 'low') AppState.dailyState.energy_budget_0_100 = 30;
            else if (v === 'mid') AppState.dailyState.energy_budget_0_100 = 60;
            else if (v === 'high') AppState.dailyState.energy_budget_0_100 = 90;

            btn.parentNode.querySelectorAll(".mc-chip").forEach(c => c.classList.remove("selected"));
            btn.classList.add("selected");
        },
        setPriorityName(v, fromChip = false) {
            const val = v ? v.trim() : null;
            AppState.dailyState.priorityActivityName = val;

            // 入力欄も更新 (もし関数呼び出し側が入力イベント以外なら)
            const input = document.getElementById('priority-activity-name');
            if (input && input.value !== val) {
                input.value = val || "";
            }

            // チップの選択状態更新
            if (fromChip && val) {
                document.querySelectorAll('#priority-activity-chips button').forEach(b => {
                    if (b.textContent === val) b.classList.add('bg-emerald-100', 'text-emerald-700', 'border-emerald-200');
                    else b.classList.remove('bg-emerald-100', 'text-emerald-700', 'border-emerald-200');
                });
            } else if (!val) {
                // Clear validation
                document.querySelectorAll('#priority-activity-chips button').forEach(b => b.classList.remove('bg-emerald-100', 'text-emerald-700', 'border-emerald-200'));
            }
        },
        setPriorityCategory(v) {
            AppState.dailyState.priorityActivityCategory = v;
        },
    },

    /* --- Utilities --- */
    calculateMets(activityName, duration_min) {
        if (!activityName || !duration_min) return 0;
        const activity = ACTIVITY_DATABASE.find(a => a.name === activityName);
        const metsVal = activity ? activity.planned_mets : 3.0; // Default to 3.0
        const metsHours = (metsVal * duration_min) / 60;
        return parseFloat(metsHours.toFixed(2));
    },

    debug: {
        // Seeding moved to backend script (setup_aws.py)
        async seed() {
            alert("データベース初期化は管理者用スクリプト(python)から実行してください。");
        },
        async clear() {
            alert("データ削除機能は無効化されました。");
        }
    },

    /* --- Auth & Data Loading --- */
    /* --- Auth & Data Loading (LIFF) --- */
    async initLIFF() {
        console.log("Initializing LIFF (app.js)...");
        try {
            const liffId = (window.APP_CONFIG && window.APP_CONFIG.liffId) || "2008978598-Ipe0zQRV";
            await liff.init({ liffId });

            // URLクリーンアップ & パラメータ有無の検知
            const url = new URL(window.location.href);
            // Ensure boolean cast to avoid 'null' string in logs
            const hasOAuthParams = !!(url.searchParams.has("code") || url.searchParams.has("state") || url.searchParams.get("liff.state"));

            if (hasOAuthParams) {
                console.log("Cleaning up OAuth params from URL...");
                url.search = "";
                window.history.replaceState({}, document.title, url.toString());
            }

            const authMode = localStorage.getItem("mc-auth-mode");
            const hasSession = !!(AppState.subject && AppState.subject.id);
            console.log(`[AuthCheck] Mode: ${authMode}, HasSession: ${hasSession}, LIFF_Login: ${liff.isLoggedIn()}, InitialLogin: ${hasOAuthParams}`);

            // 1. セッション成立済みなら停止 (DOMContentLoadedで既に表示済みのため再描画しない)
            if (hasSession) {
                console.log(">>> [SAFE] Session active. Skipping redundant start. <<<");
                return;
            }

            // 1.5 Manual Mode
            if (authMode === "manual") {
                console.log(">>> [SAFE] Manual mode. Continuing to refresh UI. <<<");
                MoveCare.showAppScreen();
                refreshUI();
                return;
            }

            // 1.5 [意図的なログアウト後] -> 自動ログイン阻止
            if (sessionStorage.getItem("intentional_logout")) {
                console.log(">>> [STOP] Intentional logout detected. Blocking auto-login. <<<");
                MoveCare.showLoginScreen();
                return;
            }

            // 2. 状態の不整合チェック (パラメータ無しのリロード時に mode:line なのにセッションが無い場合のみリセット)
            if (authMode === "line" && !hasSession && !hasOAuthParams) {
                console.log(">>> [RESET] Stale LINE mode detected. Clearing... <<<");
                localStorage.removeItem("mc-auth-mode");
                MoveCare.showLoginScreen();
                return;
            }

            // 3. モード未設定の初回ロード
            if (!authMode) {
                console.log(">>> [WAIT] No auth mode. Choice required. <<<");
                MoveCare.showLoginScreen();
                return;
            }

            // 4. LINE モードでの自動ログイン (Sessionがない場合のみ実行)
            if (authMode === "line" && liff.isLoggedIn() && !hasSession) {
                const profile = await liff.getProfile();
                console.log(">>> [NOTICE] LINE Mode: Auto-login... <<<");
                await MoveCare.loginAndFetchProfile(profile.userId, profile.displayName, "line");
            } else {
                MoveCare.showLoginScreen();
            }

        } catch (e) {
            console.error("LIFF Init Error:", e);
            if (!AppState.subject) MoveCare.showLoginScreen();
        }
    },

    async handleLogin() {
        const inputId = document.getElementById("login-input-id").value.trim();
        if (!inputId) {
            alert("被験者IDを入力してください。");
            return;
        }

        // 手動ログインを試みる前に、念のためLINE系のモードとログアウトフラグを即時クリア
        localStorage.removeItem("mc-auth-mode");
        sessionStorage.removeItem("intentional_logout");

        const loginBtn = document.getElementById("login-btn");
        const originalText = loginBtn.textContent;
        loginBtn.disabled = true;
        loginBtn.textContent = "読み込み中...";

        try {
            // 手動ログインを試行。成功した場合のみモードを切り替える
            await MoveCare.loginAndFetchProfile(inputId, "被験者 " + inputId, "manual");
            sessionStorage.removeItem("intentional_logout");
        } catch (e) {
            console.error("Manual Login Error:", e);
            document.getElementById("login-error").classList.remove("hidden");
        } finally {
            loginBtn.disabled = false;
            loginBtn.textContent = originalText;
        }
    },

    async retryLineLogin() {
        if (AppState.subject && !confirm("LINEログインに切り替えますか？ 現在のセッションは終了します。")) return;

        sessionStorage.removeItem("intentional_logout");
        // 明示的な切り替えなので、既存セッションを破棄してモードを固定する
        localStorage.removeItem("currentUser");
        localStorage.setItem("mc-auth-mode", "line");

        if (liff.isLoggedIn()) {
            const profile = await liff.getProfile();
            await MoveCare.loginAndFetchProfile(profile.userId, profile.displayName, "line");
        } else {
            liff.login();
        }
    },

    async loginAndFetchProfile(uid, displayName, mode) {
        console.log(`Fetching profile for: ${uid} (AWS) Mode: ${mode}`);
        try {
            let res;
            if (mode === 'line') {
                // /auth/line は LINE_ALIAS#{uid} を解決して本物の被験者データを返す
                res = await fetch(getApiUrl("auth/line"), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: uid })
                });
            } else {
                res = await fetch(getApiUrl(`subjects/${uid}`));
            }

            let userData;
            if (res.ok) {
                userData = await res.json();
                console.log("AWS Profile Loaded:", userData);
            } else if (res.status === 404) {
                if (mode === 'line') {
                    console.log(">>> [UNLINKED] This LINE account has no subject linked. <<<");
                    // 自動作成をせず、ログイン画面を表示し、ユーザーにID入力を促す
                    MoveCare.showLoginScreen();
                    const errorEl = document.getElementById("login-error");
                    if (errorEl) {
                        errorEl.textContent = "LINE連携されていません。被験者IDでログインしてください。";
                        errorEl.classList.remove("hidden");
                    }
                    return;
                }

                console.log("User not found on AWS. Creating new...");
                userData = {
                    id: uid,
                    name: displayName || "利用者",
                    createdAt: new Date().toISOString(),
                    projectId: "default",
                    feedforward: "はじめまして！よろしくお願いします。",
                    logs: []
                };

                // Create on AWS (Manual mode only)
                const createRes = await fetch(getApiUrl(`subjects/${uid}`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(userData)
                });
                if (!createRes.ok) throw new Error(`AWSユーザー作成に失敗しました (${createRes.status})`);
            } else {
                throw new Error(`API接続エラー: ${res.status}`);
            }

            // ログイン成功後、もしLINEがログイン中ならエイリアスを作成（連携）
            if (mode === 'manual' && typeof liff !== 'undefined' && liff.isLoggedIn()) {
                try {
                    const profile = await liff.getProfile();
                    console.log("Auto-linking Subject to current LINE account:", profile.userId);
                    await fetch(getApiUrl(`subjects/${uid}/link`), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: profile.userId })
                    });
                } catch (linkErr) {
                    console.warn("Silent link failed", linkErr);
                }
            }

            // Session Setup
            // line モードはサーバ(/auth/line)がエイリアス解決した研究IDを使う。
            // manual モードは入力された研究ID(uid)をそのまま使う。
            const effectiveId = (mode === 'line')
                ? String(userData.id || uid)
                : uid;

            const sessionData = {
                ...userData,
                id: effectiveId,
                loginDate: Date.now()
            };

            // 成功したタイミングで永続化
            AppState.subject = sessionData;
            AppState.fitbitConnected = !!userData.hasFitbit; // Add this line
            localStorage.setItem("currentUser", JSON.stringify(sessionData));
            if (mode) localStorage.setItem("mc-auth-mode", mode);

            // 被験者データに予定があれば反映
            if (userData.daily_schedule && Array.isArray(userData.daily_schedule) && userData.daily_schedule.length > 0) {
                console.log("Syncing daily_schedule from profile...");
                AppState.dailyPlan = userData.daily_schedule;
                localStorage.setItem("eo_daily_plan_v1", JSON.stringify(AppState.dailyPlan));
            }

            // Success Transition
            console.log(">>> UI Rendering Start <<<");
            try {
                // 非同期でマスタ取得 (ブロックしない)
                MoveCare.fetchGlobalData().catch(e => console.warn("Background master fetch failed", e));
            } catch (ex) {
                console.warn("Global data fetch failed during login, continuing...", ex);
            }

            // 画面切り替えと描画
            MoveCare.showAppScreen();
            switchScreen('screen-home');
            refreshUI();

        } catch (e) {
            console.error("AWS Auth Error:", e);
            if (e.message.includes("404")) {
                alert("ユーザーが見つかりません。被験者IDを確認してください。");
            } else {
                alert("ログイン処理中にエラーが発生しました。\nネットワーク環境を確認してください。");
            }
            // 失敗しても念のため画面リセット
            const loginBtn = document.getElementById("login-btn");
            if (loginBtn) {
                loginBtn.disabled = false;
                loginBtn.textContent = "ログイン";
            }
            throw e;
        }
    },

    async fetchGlobalData() {
        try {
            // Fetch Exercises
            const exRes = await fetch(getApiUrl('exercises'));
            if (exRes.ok) {
                AppState.exercises = await exRes.json();
            }

            // Fetch Projects & Find User's Project
            const projRes = await fetch(getApiUrl('projects'));
            if (projRes.ok) {
                AppState.projects = await projRes.json();
                console.log("[Sync] Projects fetched:", AppState.projects.length);
                if (AppState.subject && AppState.subject.projectId) {
                    const pid = String(AppState.subject.projectId);
                    AppState.project = AppState.projects.find(p => String(p.id) === pid);
                    console.log("[Sync] User Project ID:", pid, "Found:", !!AppState.project);

                    // Sync project menu config to AppState.settings.visibility (V144 Requirement)
                    if (AppState.project && AppState.project.menuConfig) {
                        console.log("[Sync] Syncing Project MenuConfig:", AppState.project.menuConfig);
                        AppState.settings.visibility = {};
                        APP_MENUS.forEach(m => {
                            AppState.settings.visibility[m.id] = AppState.project.menuConfig.includes(m.id);
                        });
                        console.log("[Sync] Resulting Visibility:", JSON.stringify(AppState.settings.visibility));
                    } else {
                        console.warn("[Sync] Project found but menuConfig is missing for PID:", pid);
                    }
                } else {
                    console.warn("[Sync] No ProjectId assigned to current user. Checking AppState.subject:", AppState.subject);
                }
            }
        } catch (e) { console.error("Master data fetch failed", e); }
    },

    async fetchFitbitData() {
        if (!AppState.subject || !AppState.subject.id) return;

        console.log("Fetching Fitbit step data...");
        try {
            const res = await fetch(getApiUrl(`fitbit/steps?subjectId=${AppState.subject.id}`));
            if (res.ok) {
                const data = await res.json();
                console.log("Fitbit data received:", data);

                // AppStateに格納
                AppState.stepsToday = data.steps || 0;
                AppState.stepsYesterday = data.steps_yesterday || 0;

                if (data.status === 'no_token') {
                    console.warn("Fitbit token missing on backend. Resetting status.");
                    AppState.fitbitConnected = false;
                    if (AppState.subject) AppState.subject.hasFitbit = false;
                    refreshSubjectUI(); // Update UI to show connect button
                }

                if (typeof renderFitbitSteps === 'function') {
                    renderFitbitSteps();
                }
            }
        } catch (e) {
            console.warn("Fitbit data fetch failed", e);
        }
    },

    showAppScreen() {
        document.getElementById("login-modal").classList.add("hidden");

        // Update Header ID
        const headerId = document.getElementById('header-subject-id');
        if (headerId) headerId.textContent = AppState.subject.id;

        // Update Profile Screen Info
        const profileInfo = document.querySelector('#screen-cloud .font-bold');
        if (profileInfo && AppState.subject) {
            profileInfo.textContent = `${AppState.subject.name || '利用者'} (ID: ${AppState.subject.id || '---'})`;
        }

        renderProgramList();
        renderBottomNav(); // Restore Nav
        // Render Plan
        refreshUI();
        refreshSubjectUI();
        MoveCare.renderPriorityChips(); // V175: Init chips
        MoveCare.refreshLineLinkUI(); // LINE連携ボタンの状態反映

        // Fitbitデータ取得 (hasFitbit 判定)
        if (AppState.subject && AppState.subject.hasFitbit) {
            console.log("Fitbit linked user detected. Fetching steps...");
            MoveCare.fetchFitbitData();
        }

        // Google Health データ取得 (hasGoogleHealth 判定) — Fitbit後継
        if (AppState.subject && AppState.subject.hasGoogleHealth) {
            console.log("Google Health linked user detected. Fetching steps...");
            MoveCare.fetchHealthData();
        }

        // Reveal App
        const main = document.getElementById("app-main");
        if (main) main.classList.remove("opacity-0");

        // Hide Splash
        const splash = document.getElementById("splash-screen");
        if (splash) {
            splash.classList.add("opacity-0", "pointer-events-none");
            setTimeout(() => splash.style.display = 'none', 500);
        }
    },

    async logout() {
        if (!confirm("ログアウトしますか？")) return;

        // 次回リロード時に自動ログインさせないためのフラグ
        sessionStorage.setItem("intentional_logout", "true");

        // 1. LIFF セッションの解除
        try {
            if (typeof liff !== 'undefined' && liff.isLoggedIn()) {
                liff.logout();
            }
        } catch (e) { console.warn("LIFF logout failed", e); }

        // 2. localStorage / sessionStorage の完全消去
        localStorage.removeItem("currentUser");
        localStorage.removeItem("mc-auth-mode");
        sessionStorage.removeItem("currentUser");
        localStorage.removeItem("app_version");

        // 3. Service Worker の登録解除 (ゾンビ化防止)
        if ('serviceWorker' in navigator) {
            try {
                const registrations = await navigator.serviceWorker.getRegistrations();
                for (let registration of registrations) {
                    await registration.unregister();
                }
            } catch (e) {
                console.warn("SW Unregister failed", e);
            }
        }

        // 4. Cache Storage の物理削除
        if ('caches' in window) {
            try {
                const names = await caches.keys();
                for (let name of names) await caches.delete(name);
            } catch (e) { console.warn("Caches delete failed", e); }
        }

        // 5. リロードではなく、クリーンなURLへ遷移 (パラメータ除去)
        window.location.href = window.location.origin + window.location.pathname;
    },

    showLoginScreen() {
        document.getElementById("login-modal").classList.remove("hidden");
        const splash = document.getElementById("splash-screen");
        if (splash) {
            splash.classList.add("opacity-0", "pointer-events-none");
            setTimeout(() => splash.style.display = 'none', 500);
        }
    },

    saveConfigFromModal() {
        const s = parseInt(document.getElementById('config-start-hour').value);
        const e = parseInt(document.getElementById('config-end-hour').value);

        if (s < e && s >= 0 && e <= 24) {
            AppState.config.startHour = s;
            AppState.config.endHour = e;
            localStorage.setItem("eo_config_v1", JSON.stringify(AppState.config));
            document.getElementById('modal-config').classList.add('hidden');
            renderPlanTimeline();
        } else {
            alert("有効な時間範囲を入力してください (開始 < 終了, 0-24)");
        }
    },



    /* --- Proposal Logic (Schedule Based) --- */
    calcVo2BasedSuggestion() {
        if (!AppState.currentVo2max) return null;
        const vo2 = AppState.currentVo2max;
        const metsMax = vo2ToMETs(vo2);

        let targetPercent = 45;
        const { fatigue_0_10, energy_budget_0_100, pain_0_10 } = AppState.dailyState;

        if (fatigue_0_10 >= 7 || pain_0_10 === 1) targetPercent = 35;
        else if (fatigue_0_10 <= 3 && energy_budget_0_100 >= 90) targetPercent = 55;

        const targetVo2 = vo2 * targetPercent / 100;
        const targetMets = vo2ToMETs(targetVo2);
        let planned_duration_min = 20;
        if (fatigue_0_10 >= 7 || pain_0_10 === 1) planned_duration_min = 10;
        else if (fatigue_0_10 <= 3 && energy_budget_0_100 >= 90) planned_duration_min = 30;

        const tri = getTriAxisPrescription(targetPercent);
        return { vo2, metsMax, targetPercent, targetMets, planned_duration_min, tri };
    },

    classifyActivitiesByVO2(vo2Mets) {
        const lightMax = vo2Mets * 0.4;
        const moderateMax = vo2Mets * 0.6;
        const light = ACTIVITY_DATABASE.filter(a => a.planned_mets <= lightMax);
        const moderate = ACTIVITY_DATABASE.filter(a => a.planned_mets > lightMax && a.planned_mets <= moderateMax);
        const vigorous = ACTIVITY_DATABASE.filter(a => a.planned_mets > moderateMax && a.planned_mets <= vo2Mets);
        return { light, moderate, vigorous, lightMax, moderateMax };
    },

    /* --- Fitbit Auth Logic --- */
    async connectFitbit() {
        if (!AppState.subject || !AppState.subject.id) {
            alert("ログインが必要です");
            return;
        }

        // バックエンド経由ではなくフロントエンドで直接URLを組み立てる (より確実)
        const clientId = (window.APP_CONFIG && window.APP_CONFIG.fitbitClientId) || "23TRN8";
        const scope = encodeURIComponent("activity profile heartrate sleep");
        const redirectUri = encodeURIComponent(`${window.AWS_CONFIG.apiBase}/fitbit/callback`);
        const state = AppState.subject.id; // subjectIdをstateとして渡す

        const authUrl = `https://www.fitbit.com/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}&expires_in=604800&state=${state}`;

        console.log(">>> [Fitbit] Starting Auth flow (Direct)");
        console.log(">>> [Fitbit] Target URL:", authUrl);

        try {
            if (window.liff && liff.isInClient()) {
                console.log(">>> [Fitbit] Using liff.openWindow");
                liff.openWindow({
                    url: authUrl,
                    external: false
                });
            } else {
                console.log(">>> [Fitbit] Using location.href");
                window.location.href = authUrl;
            }
        } catch (err) {
            console.error(">>> [Fitbit] Redirect failed:", err);
            window.location.assign(authUrl);
        }
    },

    /* --- Google Health 連携 (Fitbit後継) --- */
    async connectGoogleHealth() {
        if (!AppState.subject || !AppState.subject.id) {
            alert("ログインが必要です");
            return;
        }
        // バックエンドの /health/auth が Google の認可画面へ302リダイレクトする
        const url = getApiUrl(`health/auth?subjectId=${encodeURIComponent(AppState.subject.id)}`);
        console.log(">>> [GoogleHealth] Auth start:", url);
        try {
            // GoogleのOAuthはLINE内蔵ブラウザを拒否するため、必ず外部ブラウザで開く
            if (window.liff && liff.isInClient()) {
                liff.openWindow({ url, external: true });
            } else {
                window.location.href = url;
            }
        } catch (err) {
            console.error(">>> [GoogleHealth] Redirect failed:", err);
            window.location.assign(url);
        }
    },

    async fetchHealthData() {
        if (!AppState.subject || !AppState.subject.id) return;
        console.log("Fetching Google Health step data...");
        try {
            const res = await fetch(getApiUrl(`health/steps?subjectId=${AppState.subject.id}`));
            if (res.ok) {
                const data = await res.json();
                console.log("Google Health data received:", data);
                AppState.stepsToday = data.steps || 0;
                AppState.stepsYesterday = data.steps_yesterday || 0;
                if (typeof renderFitbitSteps === 'function') renderFitbitSteps();
            }
        } catch (e) {
            console.warn("Google Health data fetch failed", e);
        }
    },

    /* --- LINE Account Linking --- */
    // 研究IDでログイン中のユーザーが、自分のLINEアカウントを明示的に連携する。
    // 連携後は /auth/line 経由でLINEだけでログインできるようになる。
    async linkLineAccount() {
        if (!AppState.subject || !AppState.subject.id) {
            alert("先に研究IDでログインしてください。");
            return;
        }
        if (typeof liff === 'undefined') {
            alert("LINEアプリ内、またはLINEログイン環境で開いてください。");
            return;
        }

        try {
            // LIFF未ログインならまずLINEログインへ（戻ってきたら再度ボタンを押してもらう）
            if (!liff.isLoggedIn()) {
                localStorage.setItem("mc-auth-mode", "manual"); // セッションは研究IDのまま維持
                liff.login();
                return;
            }

            const profile = await liff.getProfile();
            console.log("[LINE Link] Linking subject", AppState.subject.id, "to LINE", profile.userId);

            const res = await fetch(getApiUrl(`subjects/${AppState.subject.id}/link`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: profile.userId })
            });
            if (!res.ok) throw new Error(`連携APIエラー (${res.status})`);

            // セッションに反映して永続化
            AppState.subject.linkedLineUserId = profile.userId;
            localStorage.setItem("currentUser", JSON.stringify(AppState.subject));

            if (typeof showToast === 'function') showToast("LINE連携が完了しました ✅");
            else alert("LINE連携が完了しました。次回からLINEでログインできます。");

            MoveCare.refreshLineLinkUI();
        } catch (e) {
            console.error("[LINE Link] failed:", e);
            alert("LINE連携に失敗しました: " + e.message);
        }
    },

    // アカウント画面のLINE連携ボタンの表示を、連携状態に応じて更新する
    refreshLineLinkUI() {
        const btn = document.getElementById("btn-line-link");
        if (!btn) return;
        const linked = !!(AppState.subject && AppState.subject.linkedLineUserId);
        if (linked) {
            btn.innerHTML = "✅ LINE連携済み";
            btn.disabled = true;
            btn.classList.add("opacity-60");
        } else {
            btn.innerHTML = "LINEアカウントと連携する";
            btn.disabled = false;
            btn.classList.remove("opacity-60");
        }
    },



    /* --- Notification Logic --- */
    async scheduleNotification(timeStr, title) {
        if (!("Notification" in window)) {
            alert("このブラウザは通知機能に対応していません。");
            return;
        }

        // Request Permission
        if (Notification.permission !== "granted") {
            try {
                const permission = await Notification.requestPermission();
                if (permission !== "granted") {
                    alert("通知許可が得られませんでした。\n・ブラウザの設定で通知をブロックしていないか確認してください。\n・ローカルファイル(file://)で開いている場合、セキュリティ制限により通知が動かないことがあります。");
                    return;
                }
            } catch (e) {
                console.error(e);
                alert("通知設定エラー: " + e.message + "\n※ローカルファイル(file://)では通知機能が制限される場合があります。");
                return;
            }
        }

        // Parse Time
        const [h, m] = timeStr.split(":").map(Number);
        const now = new Date();
        const target = new Date();
        target.setHours(h, m, 0, 0);

        // If time is past, assume tomorrow
        if (target < now) {
            target.setDate(target.getDate() + 1);
        }

        const delay = target.getTime() - now.getTime();
        const delayMin = Math.round(delay / 60000);

        // Schedule
        setTimeout(() => {
            new Notification("Activity Pacing: 時間です！", {
                body: `${title}\n活動の時間になりました。無理せず始めましょう。`,
                icon: "/icon.png"
            });
        }, delay);

        // Test Notification (Immediate confirm)
        if (confirm(`${timeStr} (約${delayMin}分後) に通知をセットしました。\n\n※テスト用に「5秒後」に通知を送信しますか？`)) {
            setTimeout(() => {
                new Notification("Activity Pacing (Test)", {
                    body: "これはテスト通知です。本番通知もこのように表示されます。",
                });
            }, 5000);
        } else {
            alert(`通知をセットしました: ${timeStr}`);
        }
    },
    async createProposal() {
        if (!AppState.subject) return;

        // UI Loading State
        const btn = document.querySelector("#mc-view-input .btn-primary");
        const originalText = btn ? btn.textContent : "今日の提案をつくる ✨";
        if (btn) {
            btn.textContent = "AI分析中... 🤖";
            btn.disabled = true;
        }

        try {
            // 1. Calculate Day & Collect State
            const { fatigue_0_10, pain_0_10, energy_budget_0_100, sleep_quality } = AppState.dailyState;

            // Check Fitbit Connection (Mock)
            // Fitbit Check (Mock for now, or fetch from Subject profile if available)
            let fitbitConnected = false;
            // AWS Migration: If fitbit status is needed, it should be in AppState.subject
            if (AppState.subject.hasFitbit) fitbitConnected = true;

            // Build Context for API (Synced with DailyState schema)
            const context = {
                energy_budget_0_100: energy_budget_0_100,
                fatigue_0_10: fatigue_0_10,
                pain_0_10: pain_0_10,
                sleep_quality: sleep_quality
            };

            // UI Elements
            const header = document.getElementById("condition-header-area");
            const inputView = document.getElementById("mc-view-input");
            const resultView = document.getElementById("mc-view-result");
            const msgEl = document.getElementById("mc-proposal-message");
            const actionsEl = document.getElementById("mc-proposal-actions");

            if (msgEl) msgEl.textContent = "AIが分析しています... 🤖";
            if (actionsEl) actionsEl.innerHTML = "";

            // Switch to result view early
            if (header) header.classList.add("hidden");
            if (inputView) inputView.classList.add("hidden");
            if (resultView) resultView.classList.remove("hidden");

            // Call API Gateway
            let result = null;
            try {
                const res = await fetch(getApiUrl('proposal'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        subjectId: String(AppState.subject.id),
                        currentCondition: context
                    })
                });
                if (res.ok) {
                    result = await res.json();
                } else {
                    throw new Error("AI Server error.");
                }
            } catch (e) {
                console.warn("API Error", e);
                alert("AIサーバーへの接続に失敗しました。もう一度お試しください。");
                // Reset UI
                if (header) header.classList.remove("hidden");
                if (inputView) inputView.classList.remove("hidden");
                if (resultView) resultView.classList.add("hidden");
                return;
            }


            // --- 優先活動の統合とペーシング調整 (V167) ---
            if (result && AppState.dailyState.priorityActivityName) {
                const pName = AppState.dailyState.priorityActivityName;
                const pCat = AppState.dailyState.priorityActivityCategory || 'HOBBY';

                // METs計算: VO2maxから中強度(50%)を算出
                // VO2max [ml/kg/min] / 3.5 = MaxMETs
                // Target = MaxMETs * 0.5
                const currentVo2 = AppState.currentVo2max || 20.0; // Fallback
                const maxMets = currentVo2 / 3.5;
                const priorityMets = parseFloat((maxMets * 0.5).toFixed(1));

                console.log(`[V167] Priority Activity: ${pName} (${priorityMets} METs)`);

                // 優先タスク作成
                const priorityDuration = 30;
                const priorityStart = 600; // 10:00

                const priorityTask = {
                    title: `★ ${pName}`, // 目立つように
                    planned_mets: priorityMets,
                    planned_duration_min: priorityDuration,
                    category: pCat,
                    isAI: false, // ユーザー由来
                    isPriority: true, // フラグ
                    startMinute: priorityStart,
                    isDone: false
                };

                // V176: 自動休憩 (Pacing) - 今は活動「後」のみ挿入 (活動前は朝なので省略)
                const restTask = {
                    title: "休憩・リラックス",
                    planned_mets: 1.0,
                    planned_duration_min: 20,
                    category: "SELFCARE",
                    isAI: true, // システム挿入だがAI扱い
                    isPriority: false,
                    startMinute: priorityStart + priorityDuration, // 活動直後
                    isDone: false
                };

                if (!result.daily_schedule) result.daily_schedule = [];

                // 他の活動の調整 (Pacing)
                // 総負荷を抑えるため、AI提案活動の時間を短縮する
                let adjustedCount = 0;
                result.daily_schedule.forEach(task => {
                    if (task && task.isAI) {
                        const oldDur = task.planned_duration_min || 20;
                        const newDur = Math.max(10, Math.floor(oldDur * 0.7 / 5) * 5); // 30%カット, Min 10分
                        if (newDur < oldDur) {
                            task.planned_duration_min = newDur;
                            task.title = task.title + " (調整)";
                            adjustedCount++;
                        }
                    }
                });

                // 配列の先頭に追加 (休憩 -> 優先活動 の順序だと時間が被るので、優先活動 -> 休憩 の順で追加)
                // unshift は逆順に入れる
                result.daily_schedule.unshift(restTask);
                result.daily_schedule.unshift(priorityTask);

                // メッセージ調整
                result.message = `「${pName}」を優先したプランです。活動後にはしっかり休憩をとるように調整しました。`;
            }

            // --- 統一UIへの反映 (V106) ---
            if (result) {
                MoveCare.renderDailyAdvice(result);
                // Save Cache
                const cacheData = {
                    message: result.message || "",
                    daily_schedule: result.daily_schedule || [],
                    timestamp: Date.now()
                };
                localStorage.setItem("mc_proposal_cache_v1", JSON.stringify(cacheData));
                AppState.homeMode = "result";
                AppState.dailyConditionSubmitted = true;

                // ムチコ連動ロジック復旧 (V108)
                MoveCare.triggerMuchikoCondition();
            }

        } catch (e) {
            console.error("Proposal Error", e);
        } finally {
            if (btn) {
                btn.textContent = originalText;
                btn.disabled = false;
            }
        }
    },

    renderDailyAdvice(data) {
        const msgEl = document.getElementById("mc-proposal-message");
        const actionsEl = document.getElementById("mc-proposal-actions");
        const approveBtn = document.getElementById("mc-proposal-approve-btn");

        if (msgEl) {
            msgEl.textContent = data.message || "今日の体調に合わせた運動プランを作成しました。";
        }

        if (actionsEl) {
            actionsEl.innerHTML = "";
            const schedule = data.daily_schedule || [];

            schedule.forEach((item, idx) => {
                if (!item || !(item.isAI || item.title || item.name)) return;

                let startMin = item.startMinute;
                if (startMin === undefined && schedule.length === 19) {
                    startMin = (idx + 5) * 60;
                }

                const title = "おすすめ活動時間";

                let timeStr = "00:00";
                if (item.time) {
                    timeStr = item.time;
                } else if (startMin !== undefined) {
                    const h = Math.floor(startMin / 60);
                    const m = startMin % 60;
                    timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                }

                const chip = document.createElement("div");
                chip.className = "bg-white px-2 py-1 rounded-full border border-emerald-200 text-[9px] font-bold text-emerald-700 shadow-sm";
                chip.textContent = `${timeStr} 〜 ${title}`;
                actionsEl.appendChild(chip);
            });
        }

        if (approveBtn) {
            approveBtn.onclick = () => {
                const dailyCard = document.getElementById("mc-view-result");
                const addonCard = document.getElementById("ai-addon-card");

                approveBtn.classList.add("hidden");
                AppState.tempPlan = data.daily_schedule || [];

                if (typeof window.applyAIPosition === 'function') {
                    window.applyAIPosition();
                    // applyAIPosition will handle hiding card
                } else {
                    console.error("applyAIPosition not found");
                }
            };
        }
    },

    retryProposal() {
        console.log("Resetting to input mode...");
        AppState.homeMode = 'input';
        AppState.dailyConditionSubmitted = false;
        localStorage.removeItem("mc_proposal_cache_v1");
        if (typeof window.switchScreen === 'function') {
            window.switchScreen('screen-home');
        }
        const main = document.getElementById("app-main");
        if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
    },

    triggerMuchikoCondition() {
        const { fatigue_0_10, pain_0_10, energy_budget_0_100 } = AppState.dailyState;
        const modal = document.getElementById("modal-muchiko");
        const msgEl = document.getElementById("muchiko-message");
        const targetEl = document.getElementById("muchiko-target");

        if (!modal || !msgEl || !targetEl) return;

        // Active Strategy Condition (疲労感3以下、痛みなし、気分が良い)
        if (fatigue_0_10 <= 3 && pain_0_10 === 0 && energy_budget_0_100 >= 90) {
            msgEl.innerHTML = "今日は絶好調だね！ムチコも本気出しちゃうよ！<br>いつもより少しレベルの高い運動に挑戦してみよう。ムチムチ頑張るよ！";
            targetEl.textContent = "高強度インターバル(HIIT) or スクワット（本日推奨）";
            modal.classList.remove("hidden");
        }
    },
    analyzeScheduleGaps() {
        if (!AppState.dailyPlan) return [];

        const startDayLimit = (AppState.config?.startHour || 7) * 60;
        const endDayLimit = (AppState.config?.endHour || 22) * 60;

        // Sort tasks by startMinute
        const now = new Date();
        const currentMin = now.getHours() * 60 + now.getMinutes();
        const upcoming = Array.isArray(AppState.dailyPlan) && AppState.dailyPlan
            .filter(t => t && t.startMinute !== undefined && !t.isDone)
            .sort((a, b) => a.startMinute - b.startMinute)
            .filter(t => (t.startMinute + (t.planned_duration_min || 30)) > currentMin)
            .find(t => t.startMinute >= currentMin - 5);
        const nowJstMinutes = now.getHours() * 60 + now.getMinutes();

        // Start looking from max(startLimit, now)
        let cursor = Math.max(startDayLimit, nowJstMinutes);

        const tasks = [...AppState.dailyPlan]
            .filter(t => t.startMinute !== undefined)
            .sort((a, b) => a.startMinute - b.startMinute);

        const gaps = [];

        for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            const tStart = t.startMinute;
            const tEnd = t.startMinute + (t.planned_duration_min || 0);

            // If there's a gap of 15+ minutes between cursor and next task
            if (tStart > cursor + 15) {
                gaps.push({
                    startMinute: cursor,
                    endMinute: tStart,
                    duration: tStart - cursor,
                    prevActivity: i > 0 ? tasks[i - 1].title : "（開始）",
                    nextActivity: t.title
                });
            }
            cursor = Math.max(cursor, tEnd);
        }

        // Final gap until end of day
        if (endDayLimit > cursor + 15) {
            gaps.push({
                startMinute: cursor,
                endMinute: endDayLimit,
                duration: endDayLimit - cursor,
                prevActivity: tasks.length > 0 ? tasks[tasks.length - 1].title : "（開始）",
                nextActivity: "（終了）"
            });
        }

        return gaps;
    },

    async requestAIAddonProposal() {
        if (!AppState.subject || !AppState.subject.id) return;

        // V127: その日の基本プランが既に作成・反映済みであることのチェック
        // (dailyConditionSubmitted が true かつ dailyPlan にデータがある場合のみ実行)
        const hasPlan = Array.isArray(AppState.dailyPlan) && AppState.dailyPlan.length > 0;
        if (!AppState.dailyConditionSubmitted || !hasPlan) {
            console.log("[AI Addon] Skipped. Main plan not yet finalized.");
            return;
        }

        // Gap Analysis
        const gaps = MoveCare.analyzeScheduleGaps();
        if (!gaps || gaps.length === 0) {
            console.log("[AI Addon] No significant gaps found.");
            return;
        }

        console.log("[AI Addon] Analyzing Gaps:", gaps);

        try {
            const res = await fetch(getApiUrl('proposal'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    subjectId: String(AppState.subject.id),
                    currentCondition: {
                        energy_budget_0_100: AppState.dailyState.energy_budget_0_100,
                        fatigue_0_10: AppState.dailyState.fatigue_0_10,
                        pain_0_10: AppState.dailyState.pain_0_10,
                        sleep_quality: AppState.dailyState.sleep_quality
                    },
                    gapList: gaps
                })
            });

            if (res.ok) {
                const data = await res.json();
                // data.suggestion は既存、data.comment / data.daily_schedule があればそれ優先
                const comment = data.comment || data.message || data.suggestion || "";

                // フォールバック停止ロジック: V101
                // 失敗メッセージが含まれていても、他の有益なデータ（daily_schedule等）があれば書き換える
                let safeComment = comment;
                const isFail = comment.includes("自動判定に失敗") || comment.includes("通常モードを推奨");
                if (isFail && data.daily_schedule && data.daily_schedule.length > 0) {
                    safeComment = "空き時間に合わせてAIが最適な活動をプランニングしました。";
                }

                if (data.daily_schedule || data.suggestion) {
                    MoveCare.renderAIAddonProposal(safeComment, data.daily_schedule);
                }
            }
        } catch (e) {
            console.warn("[AI Addon] Request failed", e);
        }
    },

    renderAIAddonProposal(comment, schedule, customTitle) {
        const card = document.getElementById("ai-addon-card");
        const titleArea = document.getElementById("ai-addon-title");
        const textArea = document.getElementById("ai-addon-text");
        const actionsArea = document.getElementById("ai-addon-actions");
        const approveBtn = document.getElementById("ai-addon-approve-btn");

        if (!card || !textArea || !actionsArea) return;

        // 0. タイトルの設定 (追加提案かデイリーか)
        if (titleArea) {
            titleArea.textContent = customTitle || "AIコンシェルジュの追加提案";
        }

        // 1. 文章の反映
        textArea.textContent = comment || "前後の活動を考慮した、今のあなたに最適な運動です";

        // 2. 予定リストの反映 (daily_scheduleがある場合)
        if (actionsArea) actionsArea.innerHTML = ""; // Clear previous chips
        // スケジュールの中身を表示
        schedule.forEach((item, idx) => {
            if (!item || !(item.isAI || item.title || item.name)) return;

            console.log(`Rendering advice item (addon) [idx:${idx}]:`, item);

            let startMin = item.startMinute;
            if (startMin === undefined && schedule.length === 19) {
                startMin = (idx + 5) * 60;
            }

            const title = "おすすめ活動時間";

            let timeStr = "00:00";
            if (item.time) {
                timeStr = item.time;
            } else if (startMin !== undefined) {
                const h = Math.floor(startMin / 60);
                const m = startMin % 60;
                timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            }

            const chip = document.createElement("div");
            chip.className = "bg-white px-2 py-1 rounded-full border border-emerald-200 text-[9px] font-bold text-emerald-700 shadow-sm";
            chip.textContent = `${timeStr} 〜 ${title}`;
            actionsArea.appendChild(chip);
        });

        // 反映ボタンの挙動を更新
        if (approveBtn) {
            approveBtn.onclick = () => {
                approveBtn.classList.add("hidden");
                AppState.tempPlan = schedule;
                window.applyAIPosition();
                setTimeout(() => card.classList.add("hidden"), 500);
            };
        }

        card.classList.remove("hidden");
        // スクロールをカードが見える位置へ
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },

    approveAIProposal(timeStr, activityName) {
        const [h, m] = timeStr.split(":").map(Number);
        const startMinute = h * 60 + m;

        const newActivity = {
            title: activityName,
            startMinute: startMinute,
            planned_duration_min: 15,
            isAI: true,
            isDone: false
        };

        if (!Array.isArray(AppState.dailyPlan)) AppState.dailyPlan = [];

        // Remove duplicate/overlapping AI suggestions at same time?
        // For simplicity, just push.
        AppState.dailyPlan.push(newActivity);

        // Save
        if (typeof savePlanToStorage === 'function') {
            savePlanToStorage();
        } else {
            localStorage.setItem("eo_daily_plan_v1", JSON.stringify(AppState.dailyPlan));
        }

        alert(`「${activityName}」をスケジュールに追加しました。`);

        // Refresh UI
        if (typeof renderPlanTimeline === 'function') renderPlanTimeline();
        // Skip calling refreshUI() here to avoid loop if refreshUI calls requestAIAddonProposal
        // But we need to update home screen summary.
        if (typeof renderHomeSummary === 'function') renderHomeSummary();
    },

    async logActivity(item, duration, silent = false) {
        if (!AppState.subject) return;

        // 1. Prepare Log Data
        const logData = {
            type: "activity",
            date: new Date().toISOString(),
            name: item.name || item.title || "不明な活動",
            mets: item.planned_mets || 3.0,
            duration: duration,
            done: true
        };

        try {
            // 2. AWS Logging
            const res = await fetch(getApiUrl('logs'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    subjectId: String(AppState.subject.id),
                    log: logData
                })
            });
            if (!res.ok) console.warn("Log upload failed", res.status);

            // 3. Local Log Update (V146: Restored for immediate UI update)
            if (!AppState.subject.logs) AppState.subject.logs = [];
            AppState.subject.logs.push(logData);

        } catch (e) {
            console.error("Log Activity Error:", e);
        }

        // 4. Update Daily Plan (Reflect in Plan Screen)
        const now = new Date();
        const startMin = now.getHours() * 60 + now.getMinutes();

        const planItem = {
            title: logData.name,
            startMinute: startMin,
            planned_duration_min: duration,
            planned_mets: logData.mets,
            planned_met_min: Math.round(logData.mets * duration), // Recalculate for tracking
            isAI: false,
            isUser: true,
            isDone: true, // Mark as completed
            isNew: true   // Highlight for confirmation
        };

        if (!Array.isArray(AppState.dailyPlan)) AppState.dailyPlan = [];
        AppState.dailyPlan.push(planItem);

        // Sort Plan
        AppState.dailyPlan.sort((a, b) => (a.startMinute || 0) - (b.startMinute || 0));

        // 5. Save & Refresh
        if (typeof savePlanToStorage === 'function') {
            savePlanToStorage();
        } else {
            localStorage.setItem("eo_daily_plan_v1", JSON.stringify(AppState.dailyPlan));
        }

        // 6. UI Navigation / Result
        const durModal = document.getElementById("duration-modal");
        if (durModal) durModal.classList.add("hidden");

        if (!silent) {
            switchScreen("screen-complete");
            const compText = document.getElementById("complete-activity-text");
            if (compText) compText.textContent = `${logData.name} (${duration}分) をプランに記録しました！`;
        } else {
            if (typeof renderPlanTimeline === 'function') renderPlanTimeline();
            refreshUI();
        }
    },

    async logCondition(day) {
        if (!AppState.subject) return;
        const { fatigue, pain, mood } = MoveCare.state;
        const logData = {
            type: "condition",
            date: new Date().toISOString(),
            day: day,
            fatigue, pain, mood
        };
        try {
            const res = await fetch(getApiUrl('logs'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subjectId: AppState.subject.id, log: logData })
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || "API Error " + res.status);
            }
            if (!AppState.subject.logs) AppState.subject.logs = [];
            AppState.subject.logs.push(logData);
        } catch (e) { console.error("Log Condition Error", e); }
    },
};

/* ===== UI Helpers ===== */
function refreshSubjectUI() {
    if (!AppState.subject) return;
    renderCompletedActivities();
    renderWeeklyProgress();
    renderHomeSummary();
    renderAdminMessage();
    MoveCare.checkMuchikoPlan();
    MoveCare.renderRecommendedActivities();
    if (typeof renderFitbitSteps === 'function') renderFitbitSteps();
    if (typeof refreshUiFitbitStatus === 'function') refreshUiFitbitStatus();
}

MoveCare.checkMuchikoPlan = function () {
    if (!AppState.dailyPlan || !Array.isArray(AppState.dailyPlan) || AppState.dailyPlan.length === 0) return;

    // 現在の時刻を取得 (分換算)
    const now = new Date();
    const currentMin = now.getHours() * 60 + now.getMinutes();

    // 稼働時間外（24時以降〜5時未満）は表示しない
    if (now.getHours() < 5) return;

    // Find active task
    // Task is active if start <= current < start + duration
    const task = AppState.dailyPlan.find(t =>
        t && t.startMinute !== undefined &&
        t.startMinute <= currentMin && (t.startMinute + t.planned_duration_min) > currentMin
    );

    // 予定（task）がある場合のみ実行
    if (task && task.title) {
        // 表示先の「小さなコンテナ」を取得
        const container = document.getElementById("muchiko-container");
        const bubble = document.getElementById("muchiko-bubble");

        if (container && bubble) {
            // メッセージを流し込む
            bubble.innerText = `今は「${task.title}」の時間だね！ムチムチ頑張ろう！`;

            // 表示をオンにする（hiddenを外してアニメーションさせる）
            container.classList.remove("hidden");
            container.classList.remove("translate-y-4"); // 下からスライドイン

            console.log("ムチコが登場しました:", task.title);

            // Check if Main Modal is open, if so, hide this small one
            const mainModal = document.getElementById("modal-muchiko");
            if (mainModal && !mainModal.classList.contains("hidden")) {
                container.classList.add("hidden");
                return;
            }

            // 4秒後に自動で隠す
            setTimeout(() => {
                container.classList.add("translate-y-4");
                setTimeout(() => {
                    container.classList.add("hidden");
                }, 500); // アニメーションが終わってから隠す
            }, 4000);

            // 【注意】本番運用で「1時間に1回だけ」にしたい場合は、
            // ここに sessionStorage.setItem(lastShownKey, "true") を戻してください。
        }
    }
};

MoveCare.renderRecommendedActivities = function () {
    const container = document.getElementById("home-recommended-activities");
    if (!container) return;

    const { fatigue, pain, mood } = MoveCare.state;
    const vo2 = AppState.currentVo2max || 30;
    const metsMax = (vo2 / 3.5);

    let level = "normal";
    if (fatigue >= 7 || pain === 1) level = "light";
    else if (fatigue <= 3 && mood === "high") level = "high";

    let activities = filterActivitiesByAP(level, metsMax);

    // V170: 夜間の活動制限 (20時以降) - METs 3.0未満に限定
    const currentHour = new Date().getHours();
    if (currentHour >= 20) {
        activities = activities.filter(a => a.planned_mets < 3.0);
        console.log("[V170] Night filter applied (20:00+). Limited to < 3.0 METs.");
    }

    // Shuffle and pick 3
    const shuffled = [...activities].sort(() => 0.5 - Math.random());
    const picked = shuffled.slice(0, 3);

    container.innerHTML = picked.map(a => `
        <div class="bg-white p-3 rounded-2xl border border-slate-100 shadow-sm active:scale-95 transition-all cursor-pointer flex flex-col items-center text-center" 
             onclick="MoveCare.openQuickPlanModal({name: '${a.name}', planned_mets: ${a.planned_mets}})">
            <div class="text-[8px] font-bold text-slate-400 mb-1 leading-none">${a.planned_mets} METs</div>
            <div class="text-[10px] font-black text-slate-700 mb-2 leading-tight h-8 flex items-center justify-center">${a.name}</div>
            <div class="bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full text-[7px] font-bold">
                目安: 15〜30分
            </div>
        </div>
    `).join("");
};

MoveCare.openQuickPlanModal = function (activity) {
    const modal = document.getElementById('modal-plan-input');
    if (!modal) return;

    // UI初期化
    MoveCare.setupTimeSelectOptions();
    document.getElementById('plan-input-title').value = activity.name;

    // 現在時刻をデフォルトに
    const now = new Date();
    const h = now.getHours();
    const m = Math.floor(now.getMinutes() / 5) * 5;

    MoveCare.currentPlanInput = { start: h * 60 + m, end: h * 60 + m + 20 };
    MoveCare.updatePlanModalSelects();

    // フラグセット
    AppState.isQuickPlanning = true;
    modal.classList.remove('hidden');
};

MoveCare.proposeSingleActivity = function (activity) {
    // 既存互換用
    MoveCare.openQuickPlanModal(activity);
};

// --- Render Program List (Scheduled & Anytime [Categorized]) ---
function renderProgramList() {
    renderScheduled();
    renderAnytime('all');
}

function renderScheduled() {
    const scheduledContainer = document.getElementById('scheduled-list');
    if (!scheduledContainer) return;

    // 1. Calculate Progress Day
    const today = AppState.subject.logs?.length > 0 ? getTodayStr() : getJSTDateStr();
    const start = AppState.subject.startDate;
    let day = 0;
    if (start) {
        const d1 = new Date(start);
        const d2 = new Date(today); // Use system date or today
        day = Math.floor((d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
    }

    // 2. Scheduled Program
    let scheduledItems = [];
    if (AppState.project && AppState.project.program) {
        // Simple day check
        const tasks = AppState.project.program.filter(p => day >= p.startDay && day <= p.endDay);
        // Find exercises
        tasks.forEach(t => {
            const ex = AppState.exercises.find(e => String(e.id) === String(t.exerciseId));
            if (ex) scheduledItems.push({ ...ex, freq: t.freq });
        });
    }

    if (scheduledItems.length > 0) {
        scheduledContainer.innerHTML = scheduledItems.map(item => renderExerciseCard(item, false, true)).join('');
    } else {
        scheduledContainer.innerHTML = `<div class="text-xs text-gray-400 text-center py-4 bg-slate-50 rounded-lg">今日のプログラムはありません (Day ${day})</div>`;
    }
}

// Global scope render function for Proposal
function renderActivityCards(items) {
    const container = document.getElementById("activity-card-list");
    if (!container) return;

    if (!items || items.length === 0) {
        container.innerHTML = `<div class="text-xs text-gray-400 text-center py-4 w-full">おすすめの活動はありません</div>`;
        return;
    }

    container.innerHTML = items.map(item => `
        <div class="app-card min-w-[140px] w-[140px] p-3 flex flex-col justify-between relative shrink-0 ${item.isProposal ? 'border-2 border-emerald-400 bg-emerald-50 shadow-md' : 'border border-slate-100'}" 
             onclick="MoveCare.openDurationModal('${item.name}', ${item.planned_mets})">
            ${item.isProposal ? '<div class="absolute -top-2 -right-2 bg-emerald-500 text-white text-[9px] px-2 py-0.5 rounded-full font-bold shadow-sm">おすすめ</div>' : ''}
            <div class="text-3xl text-center mb-2 mt-1">🏃</div>
            <div>
                <div class="text-xs font-bold text-slate-700 leading-tight mb-1 line-clamp-2">${item.name}</div>
                <div class="text-[10px] text-slate-500 font-mono">${item.planned_mets} METs</div>
            </div>
            <div class="mt-2 text-[9px] text-center text-emerald-600 font-bold border-t border-dashed border-emerald-200 pt-1">プランする</div>
        </div>
    `).join("");
}

function renderAnytime(filter = 'all') {
    const anytimeContainer = document.getElementById('anytime-section');
    if (!anytimeContainer) return;

    // 1. Setup Container Layout (once)
    let filterContainer = document.getElementById('anytime-filters');
    let listContainer = document.getElementById('anytime-list');

    // If layout doesn't exist inside anytime-section (or is just raw list), rebuild it
    if (!filterContainer) {
        anytimeContainer.innerHTML = `
            <div class="app-card-title text-sm mb-2 text-emerald-700 border-l-4 border-emerald-500 pl-2">いつでもできる (Anytime)</div>
            <div id="anytime-filters" class="flex flex-wrap gap-2 mb-3"></div>
            <div id="anytime-list" class="grid grid-cols-2 gap-3 mb-4"></div>
        `;
        filterContainer = document.getElementById('anytime-filters');
        listContainer = document.getElementById('anytime-list');
    }

    // 2. Render Filter Buttons
    const catsData = ["HIIT", "筋トレ", "有酸素", "ストレッチ", "その他"];
    const cats = [{ name: 'all', label: 'すべて' }, ...catsData.map(c => ({ name: c, label: c }))];

    filterContainer.innerHTML = cats.map(c => `
        <button onclick="renderAnytime('${c.name}')" 
            class="px-3 py-1 rounded-full text-[10px] font-bold border transition-colors ${filter === c.name ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm' : 'bg-white text-emerald-600 border-emerald-200 hover:bg-emerald-50'}">
            ${c.label}
        </button>
    `).join('');

    // 3. Filter Items
    // Start with ALL exercises if possible, then filter down
    let items = AppState.exercises || [];

    // Strict logic: Only show what is in project.anytimeExercises IF it exists
    if (AppState.project && AppState.project.anytimeExercises && AppState.project.anytimeExercises.length > 0) {
        const allowedIds = AppState.project.anytimeExercises;
        items = items.filter(e => allowedIds.includes(e.id));
    }

    // If we have 0 items after ID filtering, maybe fallback? 
    // For now, let's assume if the user has NO anytimeExercises config, we show ALL exercises as a fallback feature.
    // This fixes the issue where "All" was empty if `anytimeExercises` was not properly set but data existed.
    if (items.length === 0 && (!AppState.project || !AppState.project.anytimeExercises || AppState.project.anytimeExercises.length === 0)) {
        items = AppState.exercises || [];
    }

    if (filter !== 'all') {
        items = items.filter(i => (i.category === filter) || (i.category && i.category.includes(filter)));
    }

    // 4. Render List
    if (items.length > 0) {
        listContainer.innerHTML = items.map(item => renderExerciseCard(item, true)).join('');
    } else {
        listContainer.innerHTML = `<div class="col-span-2 text-xs text-gray-400 text-center py-4 bg-emerald-50/50 rounded-lg">このカテゴリの運動はありません</div>`;
    }
}

function getTodayStr() { return getJSTDateStr(); }

// Helper for card rendering
function renderExerciseCard(item, isAnytime, isScheduled = false) {
    // 1. Determine Flags
    const isHIIT = (item.category === "HIIT") || (item.title && item.title.includes("HIIT"));

    // Determine visibility: Use explicit flag if present, otherwise default to "True if HIIT"
    const hasHabitB = item.hasHabitB !== undefined ? item.hasHabitB : isHIIT;

    // Check for explicit video URL (not habit-B itself)
    const hasVideo = item.url && !item.url.includes("habit-B.html") && !item.url.includes("habit-B");

    const hasTimer = item.hasTimer !== false; // Default true

    // 2. Build Buttons
    let buttonsHtml = '';

    if (hasVideo) {
        buttonsHtml += `<button class="flex-1 bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-bold py-2 rounded-lg shadow-sm active:scale-95 transition-transform flex justify-center items-center gap-1" onclick="openVideoModal('${item.url}')"><span>▶</span> 動画</button>`;
    }

    if (hasHabitB) {
        buttonsHtml += `<button class="flex-1 bg-pink-500 hover:bg-pink-600 text-white text-[10px] font-bold py-2 rounded-lg shadow-sm active:scale-95 transition-transform" onclick="openHIIT('habit-B.html')">habit-B</button>`;
    }

    if (hasTimer) {
        buttonsHtml += `<button class="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-bold py-2 rounded-lg shadow-sm active:scale-95 transition-transform" onclick="openCustomTimer()">タイマー</button>`;
    }

    // 3. Render Card
    return `
    <div class="app-card p-3 ${isScheduled ? 'border-2 border-blue-100 bg-blue-50/30' : ''} ${isAnytime ? 'border-l-4 border-emerald-500 bg-emerald-50/20' : ''} flex flex-col justify-between h-full">
        <div>
            <div class="flex justify-between items-start mb-2">
                <span class="font-bold text-sm line-clamp-2 leading-tight text-slate-800">${item.title}</span>
                <span class="text-[9px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-400 whitespace-nowrap bg-white">${item.category || ''}</span>
            </div>
            ${item.freq ? `<div class="text-[10px] text-blue-600 font-bold mb-1">頻度: 週${item.freq}回</div>` : ''}
            <p class="text-[10px] text-gray-500 mb-3 line-clamp-2 leading-tight">${item.note || ''}</p>
        </div>
        <div class="flex flex-wrap gap-2">
            ${buttonsHtml}
            ${!buttonsHtml ? `<div class="text-[9px] text-gray-400 w-full text-center">アクションなし</div>` : ''}
        </div>
    </div>
    `;
}

// --- Video Modal Logic ---
window.openVideoModal = function (url) {
    if (!url) return;
    let embedUrl = url;
    // Simple converter
    if (url.includes("youtu.be/")) embedUrl = url.replace("youtu.be/", "www.youtube.com/embed/");
    else if (url.includes("watch?v=")) embedUrl = url.replace("watch?v=", "embed/");

    // Ensure clean param
    if (embedUrl.includes("&")) embedUrl = embedUrl.split("&")[0];

    const iframe = document.getElementById("video-iframe");
    if (iframe) iframe.src = embedUrl;

    const modal = document.getElementById("video-modal");
    if (modal) modal.classList.remove("hidden");
};

window.closeVideoModal = function () {
    const iframe = document.getElementById("video-iframe");
    if (iframe) iframe.src = ""; // Stop playback

    const modal = document.getElementById("video-modal");
    if (modal) modal.classList.add("hidden");
};

function renderAdminMessage() {
    const container = document.getElementById("home-admin-message");
    const textEl = document.getElementById("home-admin-message-text");

    if (!container || !textEl) return;

    const msg = AppState.subject ? AppState.subject.feedforward : null;

    if (msg && msg.trim() !== "") {
        textEl.textContent = msg;
        container.classList.remove("hidden");
    } else {
        container.classList.add("hidden");
    }
}

function renderCompletedActivities() {
    // Filter from AppState.subject.logs where type='activity' AND date is today
    const container = document.getElementById("completed-activities-container");
    const countEl = document.getElementById("completed-count");
    if (!container) return;

    if (!AppState.subject || !AppState.subject.logs) {
        if (countEl) countEl.textContent = 0;
        return;
    }

    const todayStr = getJSTDateStr();
    const logs = AppState.subject.logs.filter(l =>
        l.type === "activity" && l.date.startsWith(todayStr)
    );

    if (countEl) countEl.textContent = logs.length;

    if (logs.length === 0) {
        container.innerHTML = `
            <div class="text-[10px] text-gray-400 text-center py-6 bg-white/50 rounded-2xl border border-dashed">
                まだ活動の記録がありません。
            </div>
        `;
        return;
    }

    container.innerHTML = logs.reverse().map(l => `
        <div class="flex justify-between items-center p-3 bg-white rounded-xl border border-emerald-50 mb-1 shadow-sm">
            <div>
                <div class="text-[11px] font-bold text-slate-700">${l.name}</div>
                <div class="text-[9px] text-slate-400">${new Date(l.date).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour: '2-digit', minute: '2-digit' })} / ${l.duration}分</div>
            </div>
            <div class="text-[11px] font-bold text-emerald-600">${(l.mets * l.duration / 60).toFixed(2)} <span class="text-[8px]">M・h</span></div>
        </div>
    `).join("");
}

function renderHomeSummary() {
    const todayStr = getJSTDateStr();
    let mh = 0;

    if (AppState.subject && AppState.subject.logs) {
        AppState.subject.logs.forEach(l => {
            if (l.type === "activity" && l.date.startsWith(todayStr)) {
                mh += (l.mets || 0) * ((l.duration || 0) / 60);
            }
        });
    }

    const mEl = document.getElementById("home-summary-mets");
    if (mEl) mEl.textContent = mh.toFixed(2);
    const kEl = document.getElementById("home-summary-kcal");
    if (kEl) kEl.textContent = Math.round(mh * AppState.weight);

    // V98: Update next action card
    updateNextActionCard();
}

/**
 * V98: Update home screen next action card
 */
function updateNextActionCard() {
    const card = document.getElementById("next-action-card");
    const textEl = document.getElementById("next-action-text");
    if (!card || !textEl) return;

    if (!AppState.dailyPlan || AppState.dailyPlan.length === 0) {
        card.classList.add("hidden");
        return;
    }

    const now = new Date();
    const currentMin = now.getHours() * 60 + now.getMinutes();

    // Find current or next upcoming task
    const upcoming = AppState.dailyPlan
        .filter(t => (t.startMinute + (t.planned_duration_min || 30)) > currentMin)
        .sort((a, b) => a.startMinute - b.startMinute)[0];

    if (upcoming) {
        const h = Math.floor(upcoming.startMinute / 60);
        const m = upcoming.startMinute % 60;
        const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        const suffix = upcoming.isAI ? " (AI提案)" : "";
        textEl.textContent = `${timeStr} 〜 ${upcoming.title}${suffix}`;
        card.classList.remove("hidden");
    } else {
        card.classList.add("hidden");
    }
}

function renderFitbitSteps() {
    const container = document.getElementById("home-fitbit-steps-container");
    const todayEl = document.getElementById("fitbit-steps-today");
    const yesterdayEl = document.getElementById("fitbit-steps-yesterday");

    if (!container) return;

    // hasFitbit または fitbitConnected が真なら表示
    const isConnected = AppState.fitbitConnected || (AppState.subject && AppState.subject.hasFitbit);
    console.log(`[FitbitRender] Connected: ${isConnected}, Steps: ${AppState.stepsToday}, Prev: ${AppState.stepsYesterday}`);

    if (isConnected) {
        container.classList.remove("hidden");
        // Ensure 0 is displayed if undefined
        if (todayEl) todayEl.textContent = Number(AppState.stepsToday || 0).toLocaleString();
        if (yesterdayEl) yesterdayEl.textContent = Number(AppState.stepsYesterday || 0).toLocaleString();
    } else {
        container.classList.add("hidden");
    }
}

/* --- Metrics & Charts --- */
function renderWeeklyProgress() {
    // V132: Real-time Completed Progress
    if (!AppState.subject) return;

    let totalMH = 0;
    let achieved_met_min_total = 0; // New accumulator in MET-min
    const now = new Date();
    const todayStr = now.toDateString();

    // 1. Logs (Manual Records + History) - Include TODAY's manual logs
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(now.getDate() - 6);
    oneWeekAgo.setHours(0, 0, 0, 0);

    const todayLoggedNames = new Set(); // Track today's logged activities

    if (AppState.subject.logs) {
        AppState.subject.logs.forEach(l => {
            if (l.type === "activity") {
                const d = new Date(l.date);
                if (d >= oneWeekAgo) {
                    const mh = (l.mets || 0) * (l.duration / 60);
                    totalMH += mh;
                    achieved_met_min_total += (l.mets || 0) * l.duration;

                    // Track what we counted for today to avoid duplicate form Daily Plan
                    if (d.toDateString() === todayStr) {
                        todayLoggedNames.add(l.name);
                    }
                }
            }
        });
    }

    // 2. Today's Plan (Completed Only)
    // Only add if p.isDone is TRUE (User request: don't count pending/planned)
    if (Array.isArray(AppState.dailyPlan)) {
        AppState.dailyPlan.forEach(p => {
            if (p.isDone && (p.planned_mets || 0) > 0 && (p.planned_duration_min || 0) > 0) {
                // If this activity name is NOT in today's logs, add to calculation
                // (Addresses the case where 'DailyPlan completion' hasn't synced to 'logs' yet)
                if (!todayLoggedNames.has(p.title)) {
                    totalMH += p.planned_mets * (p.planned_duration_min / 60);
                    achieved_met_min_total += p.planned_mets * p.planned_duration_min;
                }
            }
        });
    }

    AppState.weeklyMets = totalMH; // Save to state
    AppState.achieved_met_min_total = Math.round(achieved_met_min_total);

    const target = AppState.settings.week_goal_value / 60; // Convert MET-min to MET-h for display
    const pct = Math.min(100, Math.round((totalMH / target) * 100));

    const ring = document.getElementById("weekly-progress-ring");
    const label = document.getElementById("weekly-progress-label");
    const text = document.getElementById("home-weekly-mets");

    if (ring) {
        // SVG circumference is ~100
        ring.setAttribute("stroke-dasharray", `${pct}, 100`);
    }
    if (label) label.textContent = pct + "%";
    if (text) text.textContent = `${totalMH.toFixed(1)} / ${target.toFixed(1)} METs・h`;
}

/* ===== Plan / Timeline Logic (Restored) ===== */
const PLAN_STORAGE_KEY = "eo_daily_plan_v1";

function loadPlanFromStorage() {
    try {
        const raw = localStorage.getItem(PLAN_STORAGE_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            if (Array.isArray(data)) {
                // Migration for V141: Mapping old keys to new keys
                data.forEach(item => {
                    if (item && typeof item === 'object') {
                        if (item.mets && !item.planned_mets) item.planned_mets = item.mets;
                        if (item.duration && !item.planned_duration_min) item.planned_duration_min = item.duration;
                    }
                });
                AppState.dailyPlan = data.filter(item => item !== null && typeof item === 'object');
            } else {
                AppState.dailyPlan = [];
            }
        } else {
            AppState.dailyPlan = [];
        }
    } catch (e) {
        console.error("Plan Load Error", e);
        AppState.dailyPlan = [];
    }
}

function loadConfigFromStorage() {
    try {
        const raw = localStorage.getItem("eo_config_v1");
        if (raw) {
            AppState.config = JSON.parse(raw);
        }
    } catch (e) {
        console.error("Config Load Error", e);
    }
}

let _syncDebounce = null;
function savePlanToStorage() {
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(AppState.dailyPlan));

    // V98: 連続呼び出しを抑制し、API通信を1回にまとめる（デバウンス処理）
    if (_syncDebounce) clearTimeout(_syncDebounce);
    _syncDebounce = setTimeout(() => {
        syncScheduleToBackend();
        _syncDebounce = null;
    }, 500);
}

async function syncScheduleToBackend() {
    if (!AppState.subject || !AppState.subject.id) return;
    try {
        console.log("Syncing schedule to backend for ID:", AppState.subject.id);
        const payload = {
            id: String(AppState.subject.id), // IDを確実に文字列として送る
            daily_schedule: AppState.dailyPlan || [], // スケジュール本体
            updatedAt: new Date().toISOString()
        };

        const res = await fetch(getApiUrl(`subjects/${AppState.subject.id}`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload) // 絞り込んだデータを送る
        });

        if (res.status === 403) {
            console.error("Permission denied (403) while syncing schedule.");
            alert("保存権限がありません(403)。管理者によってIDが保護されている可能性があります。");
        } else if (res.ok) {
            // SUCCESS SYNC: Update AppState.subject and localStorage
            if (AppState.subject) {
                AppState.subject.daily_schedule = AppState.dailyPlan;
                localStorage.setItem("currentUser", JSON.stringify(AppState.subject));
                console.log("Successfully synced and updated local state.");
            }
        } else {
            console.warn("Schedule sync failed with status:", res.status);
        }
    } catch (e) {
        console.warn("Schedule sync failed", e);
    }
}

/**
 * 過去のログから習慣（固定予定）を分析してスケジュールを自動生成する (V99)
 */
MoveCare.generateFromHabits = function () {
    console.log("Starting V99 habit analysis...");

    if (!AppState.subject || !AppState.subject.logs) {
        alert("過去の活動データが不足しているため、習慣を分析できません。");
        return;
    }

    const today = new Date();
    const isWeekend = (today.getDay() === 0 || today.getDay() === 6); // 0:日, 6:土
    const logs = AppState.subject.logs;

    // 1. 過去30日間の同一曜日属性（平日/休日）のログを抽出
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);

    const relevantLogs = logs.filter(log => {
        const logDate = new Date(log.date);
        const logIsWeekend = (logDate.getDay() === 0 || logDate.getDay() === 6);
        return logDate >= thirtyDaysAgo && logIsWeekend === isWeekend && log.type === 'activity';
    });

    // 2. 出現頻度の高い活動（習慣）を特定
    // タイトルごとに「開始時間」と「継続時間」の平均を算出
    const habitMap = {};
    relevantLogs.forEach(log => {
        if (!habitMap[log.name]) habitMap[log.name] = { counts: 0, startMins: [], durations: [] };
        const d = new Date(log.date);
        habitMap[log.name].counts++;
        habitMap[log.name].startMins.push(d.getHours() * 60 + d.getMinutes());
        habitMap[log.name].durations.push(log.duration || 60);
    });

    // 3. 3回以上出現している活動を「習慣」として採用し、プランにセット
    const newPlan = [];
    Object.keys(habitMap).forEach(name => {
        const h = habitMap[name];
        if (h.counts >= 3) {
            const avgStart = Math.round((h.startMins.reduce((a, b) => a + b) / h.counts) / 5) * 5;
            const avgDur = Math.round((h.durations.reduce((a, b) => a + b) / h.counts) / 5) * 5;

            newPlan.push({
                title: name,
                startMinute: avgStart,
                planned_duration_min: avgDur,
                isAI: false,
                isDone: false
            });
        }
    });

    if (newPlan.length > 0) {
        AppState.dailyPlan = newPlan.sort((a, b) => a.startMinute - b.startMinute);
        savePlanToStorage(); // 同期と保存
        renderPlanTimeline(); // 描画更新
        alert(`${isWeekend ? '休日' : '平日'}の習慣に基づき、${newPlan.length}件の予定を生成しました。`);

        // 生成後に即座に隙間を解析してAI提案（AI Addon）をトリガー (V99)
        if (typeof MoveCare.requestAIAddonProposal === 'function') {
            MoveCare.requestAIAddonProposal();
        }
    } else {
        alert("明確な習慣パターンが見つかりませんでした。");
    }
};

function renderPlanTimeline() {
    const container = document.getElementById("plan-body");
    if (!container) return;

    const startMin = AppState.config.startHour * 60;
    const endMin = AppState.config.endHour * 60;
    const totalMin = endMin - startMin;

    container.innerHTML = "";
    container.style.height = `${totalMin * PX_PER_MIN}px`;

    // 1. 時間軸の目盛りと背景（左端に配置）
    for (let h = AppState.config.startHour; h <= AppState.config.endHour; h++) {
        const top = (h * 60 - startMin) * PX_PER_MIN;
        const line = document.createElement("div");
        line.className = "absolute w-full border-t border-slate-100 pointer-events-none flex items-center";
        line.style.top = `${top}px`;
        line.innerHTML = `<span class="text-[9px] font-bold text-slate-300 -mt-2 bg-white pr-1">${String(h).padStart(2, '0')}:00</span>`;
        container.appendChild(line);

        // 30分ライン（点線）
        if (h < AppState.config.endHour) {
            const midLine = document.createElement("div");
            midLine.className = "absolute w-full border-t border-slate-50 border-dashed pointer-events-none";
            midLine.style.top = `${top + (30 * PX_PER_MIN)}px`;
            container.appendChild(midLine);
        }
    }

    // 2. タスクの描画（2カラム化）
    // Ensure dailyPlan is array (migration safety)
    if (!Array.isArray(AppState.dailyPlan)) {
        AppState.dailyPlan = [];
    }

    AppState.dailyPlan.forEach((task, index) => {
        // Skip if out of range
        if (task.startMinute < startMin || task.startMinute > endMin) return;

        const top = (task.startMinute - startMin) * PX_PER_MIN;
        const height = Math.max(20, (task.planned_duration_min || 15) * PX_PER_MIN);

        // AI提案（右側）か、自分（左側）かを判定
        const isAI = task.isAI;
        // V133: Swapped columns (Manual: Left, AI: Right)
        const left = isAI ? "left-[55%]" : "left-[14%]";
        const width = "w-[40%]";
        const colorClass = isAI ?
            "bg-emerald-50 border-emerald-200 text-emerald-800" :
            "bg-blue-50 border-blue-200 text-blue-800";

        const card = document.createElement("div");
        const highlightClass = task.isNew ? "ring-4 ring-yellow-400 ring-offset-2 z-20" : "";
        card.className = `absolute ${left} ${width} ${colorClass} ${highlightClass} border-2 rounded-xl p-2 shadow-sm flex flex-col justify-center animate-in fade-in zoom-in-95 duration-300 cursor-pointer overflow-hidden leading-none touch-none`;
        card.style.top = `${top}px`;
        card.style.height = `${height}px`;
        card.innerHTML = `
            <div class="flex items-center gap-1 mb-0.5 pointer-events-none">
                ${isAI ? '<span class="text-[9px]">🤖</span>' : ''}
                <div class="text-[10px] font-extrabold truncate leading-tight">${task.title}</div>
            </div>
            <div class="text-[8px] opacity-60 font-bold pointer-events-none">${task.planned_duration_min}分</div>
            <button class="absolute top-1 right-2 text-xs opacity-50 hover:opacity-100 p-1 z-10" onclick="event.stopPropagation(); MoveCare.deletePlanItem(${index})">✕</button>
        `;

        // ドラッグ移動の実装
        MoveCare.initTaskDrag(card, index, startMin);

        card.onclick = (e) => {
            if (MoveCare.isDragging) return;
            e.stopPropagation();
            MoveCare.handleTaskEdit(index);
        };
        container.appendChild(card);
    });

    // 3. 空白タップで予定追加（右側の自由枠を優先）
    container.onclick = (e) => {
        if (e.target !== container) return;
        const rect = container.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const clickedMin = Math.round(y / PX_PER_MIN / 5) * 5 + startMin; // 5分単位に丸める
        MoveCare.handlePlanTap(clickedMin);
    };

    // V99: Timeline更新後に隙間を解析して自動でAI提案を小窓に表示する
    if (typeof MoveCare.requestAIAddonProposal === 'function') {
        // 頻繁な呼び出しを防ぐため短時間デバウンス（任意だが推奨）
        clearTimeout(window._aiAddonTimer);
        window._aiAddonTimer = setTimeout(() => {
            MoveCare.requestAIAddonProposal();
        }, 500);
    }
}

function renderPlanItem(item, index) {
    // Item: { title, duration, isDone }
    return `
        <div class="m-1 p-2 bg-emerald-100 rounded-lg border border-emerald-200 shadow-sm flex justify-between items-center h-[calc(100%-8px)]">
            <div>
                <div class="text-[11px] font-bold text-slate-700 line-clamp-1">${item.title}</div>
                <div class="text-[9px] text-emerald-600">${item.planned_duration_min}分</div>
            </div>
            <button class="text-emerald-500 hover:text-emerald-700 font-bold px-2" onclick="event.stopPropagation(); MoveCare.deletePlanItem(${index})">×</button>
        </div>
    `;
}

MoveCare.handlePlanTap = function (startMinute) {
    MoveCare.currentPlanInput = {
        start: startMinute,
        end: startMinute + 60
    };

    // UI初期化
    MoveCare.setupTimeSelectOptions();
    MoveCare.updatePlanModalSelects();
    document.getElementById('plan-input-title').value = "";

    // チップの生成
    const history = JSON.parse(localStorage.getItem("eo_activity_history_v1") || "[]");
    const defaultList = ["仕事", "食事", "家事", "散歩", "読書", "休養"];
    const combinedList = [...new Set([...defaultList, ...history])];

    const chipContainer = document.getElementById('plan-activity-chips');
    if (chipContainer) {
        chipContainer.innerHTML = combinedList.map(activity => `
            <button onclick="MoveCare.selectActivityChip('${activity}')" class="px-3 py-1.5 bg-slate-50 border border-slate-100 rounded-full text-[10px] font-bold text-slate-500 active:bg-emerald-50 active:border-emerald-200 active:scale-95 transition-all">
                ${activity}
            </button>
        `).join("");
    }

    document.getElementById('modal-plan-input').classList.remove('hidden');
};

MoveCare.setupTimeSelectOptions = function () {
    const sh = document.getElementById('plan-input-start-h');
    const sm = document.getElementById('plan-input-start-m');
    const eh = document.getElementById('plan-input-end-h');
    const em = document.getElementById('plan-input-end-m');
    if (!sh || sh.options.length > 0) return; // 既に生成済みならスキップ

    for (let i = 0; i < 24; i++) {
        const val = String(i).padStart(2, '0');
        sh.add(new Option(val, i));
        eh.add(new Option(val, i));
    }
    for (let i = 0; i < 60; i += 5) {
        const val = String(i).padStart(2, '0');
        sm.add(new Option(val, i));
        em.add(new Option(val, i));
    }
};

MoveCare.updatePlanModalSelects = function () {
    const { start, end } = MoveCare.currentPlanInput;
    document.getElementById('plan-input-start-h').value = Math.floor(start / 60);
    document.getElementById('plan-input-start-m').value = start % 60;
    document.getElementById('plan-input-end-h').value = Math.floor(end / 60);
    document.getElementById('plan-input-end-m').value = end % 60;
};

MoveCare.syncPlanModalTimes = function () {
    const sh = parseInt(document.getElementById('plan-input-start-h').value);
    const sm = parseInt(document.getElementById('plan-input-start-m').value);
    const eh = parseInt(document.getElementById('plan-input-end-h').value);
    const em = parseInt(document.getElementById('plan-input-end-m').value);

    let start = sh * 60 + sm;
    let end = eh * 60 + em;

    // バリデーション: 開始が終了を追い越さないように
    if (start >= end) {
        end = start + 5;
        // 24時を超えないようにケアが必要だが簡易的に
        if (end > 24 * 60) end = 24 * 60;
    }

    MoveCare.currentPlanInput = { start, end };
    MoveCare.updatePlanModalSelects();
};

MoveCare.selectActivityChip = function (activity) {
    const titleInp = document.getElementById('plan-input-title');
    if (titleInp) titleInp.value = activity;
};

MoveCare.adjustPlanTime = function (type, delta) {
    if (!MoveCare.currentPlanInput) return;

    if (type === 'start') {
        MoveCare.currentPlanInput.start = Math.max(0, MoveCare.currentPlanInput.start + delta);
        // 開始が終了を追い越さないように
        if (MoveCare.currentPlanInput.start >= MoveCare.currentPlanInput.end) {
            MoveCare.currentPlanInput.end = MoveCare.currentPlanInput.start + 5;
        }
    } else {
        MoveCare.currentPlanInput.end = Math.max(MoveCare.currentPlanInput.start + 5, MoveCare.currentPlanInput.end + delta);
    }

    document.getElementById('plan-input-start-text').textContent = getJSTTimeStr(MoveCare.currentPlanInput.start);
    document.getElementById('plan-input-end-text').textContent = getJSTTimeStr(MoveCare.currentPlanInput.end);
};

MoveCare.initTaskDrag = function (card, index, startMin) {
    let startY = 0;
    let startTop = 0;
    MoveCare.isDragging = false;

    const onMove = (e) => {
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const delta = clientY - startY;
        if (Math.abs(delta) > 5) {
            MoveCare.isDragging = true;
            card.style.top = `${startTop + delta}px`;
            card.style.zIndex = "1000";
            card.style.opacity = "0.8";
        }
    };

    const onEnd = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);

        if (MoveCare.isDragging) {
            const finalTop = parseInt(card.style.top);
            let newStartMin = Math.round((finalTop / PX_PER_MIN + startMin) / 5) * 5;

            // 範囲チェック
            const maxMin = AppState.config.endHour * 60 - (AppState.dailyPlan[index].planned_duration_min || 15);
            newStartMin = Math.max(startMin, Math.min(maxMin, newStartMin));

            AppState.dailyPlan[index].startMinute = newStartMin;
            savePlanToStorage();
            renderPlanTimeline();

            // ドラッグ終了後、少し遅らせてフラグを下ろす（clickイベントとの競合回避）
            setTimeout(() => { MoveCare.isDragging = false; }, 50);
        }
    };

    const onStart = (e) => {
        // ✕ボタンなどは除外
        if (e.target.tagName === 'BUTTON') return;

        startY = e.touches ? e.touches[0].clientY : e.clientY;
        startTop = parseInt(card.style.top);
        MoveCare.isDragging = false;

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    };

    card.addEventListener('mousedown', onStart);
    card.addEventListener('touchstart', onStart, { passive: false });
};

MoveCare.handleTaskEdit = function (index) {
    const task = AppState.dailyPlan[index];
    if (task && task.isPending) {
        MoveCare.chooseActivityForPending(index);
        return;
    }
    MoveCare.deletePlanItem(index);
};

// V149: Find the closest activity from ACTIVITY_DATABASE based on target METs and optional category
MoveCare.findClosestActivity = function (targetMets, category = null) {
    let closestActivity = { name: "活動", planned_mets: 3.0 }; // Default fallback
    let minDiff = Infinity;

    const activitiesToSearch = category
        ? ACTIVITY_DATABASE.filter(a => a.category === category)
        : ACTIVITY_DATABASE;

    if (activitiesToSearch.length === 0) {
        // If no activities in the specified category, or database is empty, return generic fallback
        return closestActivity;
    }

    for (const activity of activitiesToSearch) {
        if (activity.planned_mets) {
            const diff = Math.abs(activity.planned_mets - targetMets);
            if (diff < minDiff) {
                minDiff = diff;
                closestActivity = { name: activity.name, planned_mets: activity.planned_mets };
            }
        }
    }
    return closestActivity;
};

MoveCare.chooseActivityForPending = function (index) {
    console.log("Choose activity for pending slot:", index);
    MoveCare.pendingIndex = index;
    const modal = document.getElementById("modal-pending-choice");
    if (!modal) return;

    // V149: Update modal text with specific activity examples based on current fitness
    const vo2 = AppState.currentVo2max || 30;
    const maxMets = vo2 / 3.5;

    const highMets = maxMets * 0.75;
    const medMets = maxMets * 0.50;
    const lowMets = maxMets * 0.30;

    const highAct = MoveCare.findClosestActivity(highMets, "EXERCISE");
    const medAct = MoveCare.findClosestActivity(medMets);
    const lowAct = MoveCare.findClosestActivity(lowMets);

    // Update buttons in index.html (relies on structure from V119)
    const btnHigh = modal.querySelector('button[onclick*="High"] .font-black');
    const btnMed = modal.querySelector('button[onclick*="Medium"] .font-black');
    const btnLow = modal.querySelector('button[onclick*="Low"] .font-black');

    if (btnHigh) btnHigh.textContent = `しっかり（${highAct.name}など）`;
    if (btnMed) btnMed.textContent = `ほどほど（${medAct.name}など）`;
    if (btnLow) btnLow.textContent = `ゆったり（${lowAct.name}など）`;

    modal.classList.remove("hidden");
};

MoveCare.reflectPendingChoice = function (intensity) {
    const index = MoveCare.pendingIndex;
    if (index === undefined || !AppState.dailyPlan[index]) return;

    let activityName = "活動";
    let mets = 3.0;

    // V141: Individual Intensity Calculation based on VO2max (Relative METs)
    const vo2 = AppState.currentVo2max || 30;
    const maxMets = vo2 / 3.5;

    let targetMets = 3.0;
    let fallbackCategory = null;

    if (intensity === 'High') {
        targetMets = maxMets * 0.75;
        fallbackCategory = "EXERCISE";
    } else if (intensity === 'Medium') {
        targetMets = maxMets * 0.50;
    } else if (intensity === 'Low') {
        targetMets = maxMets * 0.30;
    }

    // V149: Search for the most appropriate specific activity name
    const closest = MoveCare.findClosestActivity(targetMets, fallbackCategory);
    activityName = closest.name;
    mets = parseFloat(targetMets.toFixed(2));

    // 2. 選択時のデータ上書き (デフォルト15分)
    const task = AppState.dailyPlan[index];
    task.title = activityName;
    task.planned_mets = mets;
    task.isPending = false;
    if (!task.planned_duration_min) task.planned_duration_min = 15;

    // Calculate planned_met_min (METs * min)
    task.planned_met_min = Math.round(task.planned_mets * task.planned_duration_min);

    document.getElementById("modal-pending-choice").classList.add("hidden");

    // 即時計算・反映
    savePlanToStorage();
    renderPlanTimeline();
    if (typeof renderWeeklyProgress === 'function') renderWeeklyProgress();

    // 3. 時間（duration）の確認
    setTimeout(() => {
        MoveCare.openDurationConfirmModal(index);
    }, 150);
};

/* --- Duration Confirm Modal Helpers (V130) --- */
MoveCare.editingIndex = null;

MoveCare.openDurationConfirmModal = function (index) {
    MoveCare.editingIndex = index;
    const item = AppState.dailyPlan[index];
    if (!item) return;

    const modal = document.getElementById("modal-duration-confirm");
    const input = document.getElementById("confirm-duration-input");
    if (modal && input) {
        input.value = item.planned_duration_min || 15;
        modal.classList.remove("hidden");
    }
};

MoveCare.closeDurationConfirmModal = function () {
    const modal = document.getElementById("modal-duration-confirm");
    if (modal) modal.classList.add("hidden");
    MoveCare.editingIndex = null;
};

MoveCare.saveDurationConfirm = function () {
    const index = MoveCare.editingIndex;
    if (index === null || !AppState.dailyPlan[index]) {
        MoveCare.closeDurationConfirmModal();
        return;
    }

    const input = document.getElementById("confirm-duration-input");
    const newDur = parseInt(input.value, 10);
    const task = AppState.dailyPlan[index];

    if (!isNaN(newDur) && newDur > 0) {
        // Change logic
        const currentDur = task.planned_duration_min;
        if (newDur !== currentDur) {
            task.planned_duration_min = newDur;
            // Recalculate planned_met_min
            task.planned_met_min = Math.round((task.planned_mets || 3.0) * newDur);

            savePlanToStorage();
            renderPlanTimeline();
            if (typeof renderWeeklyProgress === 'function') renderWeeklyProgress();
            if (typeof showToast === 'function') showToast(`時間を ${newDur}分 に変更しました`);
        } else {
            if (typeof showToast === 'function') showToast(`${task.title} (15分) を設定しました`);
        }
    }
    MoveCare.closeDurationConfirmModal();
};

window.adjustDuration = function (delta) {
    const input = document.getElementById("confirm-duration-input");
    if (input) {
        let val = parseInt(input.value, 10) || 15;
        val += delta;
        if (val < 5) val = 5; // Minimum 5 min
        input.value = val;
    }
};

MoveCare.savePlanFromModal = async function () {
    const titleInp = document.getElementById('plan-input-title');
    const title = titleInp ? titleInp.value.trim() : "";

    if (!title) {
        alert("活動内容を入力してください");
        return;
    }

    const { start, end } = MoveCare.currentPlanInput;
    const duration = end - start;

    // 履歴に追加
    const history = JSON.parse(localStorage.getItem("eo_activity_history_v1") || "[]");
    const defaultList = ["仕事", "食事", "家事", "散歩", "読書", "休養"];
    if (!defaultList.includes(title) && !history.includes(title)) {
        history.push(title);
        localStorage.setItem("eo_activity_history_v1", JSON.stringify(history.slice(-10)));
    }

    const activity = ACTIVITY_DATABASE.find(a => a.name === title);
    const mets = activity ? activity.planned_mets : 3.0;
    const category = activity ? activity.category : "OTHER";

    const newTask = {
        title: title,
        startMinute: start,
        planned_duration_min: duration,
        isAI: false,
        isUser: true,
        isDone: false,
        planned_mets: mets,
        planned_met_min: Math.round(mets * duration), // MET-min calculation
        category: category,
        isNew: true // ハイライト用标记
    };

    AppState.dailyPlan.push(newTask);

    // V111: クイックプランからの場合はログにも残して進捗を更新する
    if (AppState.isQuickPlanning) {
        await MoveCare.logActivity({ name: title, planned_mets: mets }, duration, true);
        AppState.isQuickPlanning = false;
    }

    savePlanToStorage();
    renderPlanTimeline();
    if (typeof renderWeeklyProgress === 'function') renderWeeklyProgress();

    // モーダルを閉じる
    document.getElementById('modal-plan-input').classList.add('hidden');

    // プラン画面へ遷移
    switchScreen('screen-plan');
    setActiveNav('nav-plan');

    // 数秒後にハイライトを消す
    setTimeout(() => {
        newTask.isNew = false;
        renderPlanTimeline();
    }, 3000);
};

MoveCare.deletePlanItem = function (index) {
    if (confirm("この予定を削除しますか？")) {
        AppState.dailyPlan.splice(index, 1);
        savePlanToStorage();
        renderPlanTimeline();
    }
};

// スケジュールの隙間（ギャップ）を見つける関数
MoveCare.findScheduleGaps = function () {
    const start = AppState.config.startHour * 60;
    const end = AppState.config.endHour * 60;
    // 予定を開始時間順にソート
    const sortedPlans = [...AppState.dailyPlan].sort((a, b) => a.startMinute - b.startMinute);

    let gaps = [];
    let current = start;

    sortedPlans.forEach(plan => {
        if (plan.startMinute > current + 15) { // 15分以上の空きがあれば隙間とみなす
            gaps.push({ start: current, end: plan.startMinute });
        }
        current = Math.max(current, plan.startMinute + (plan.planned_duration_min || 15));
    });

    if (current < end - 15) {
        gaps.push({ start: current, end: end });
    }
    return gaps;
};

/* ===== Standard UI / Navigation (Preserved) ===== */
function switchScreen(id) {
    document.querySelectorAll(".app-screen").forEach(el => el.classList.remove("active"));
    const target = document.getElementById(id);
    if (!target) return;
    target.classList.add("active");

    const titleEl = document.getElementById("header-title");
    const subEl = document.getElementById("header-subtitle");
    // Simple title switch

    const titles = {
        "screen-home": ["ホーム", "体調と体力に合わせて、今日の一歩を決めましょう。"],
        "screen-plan": ["今日のプラン", "MOVE-CAREとVO₂maxから作成したプランです。"],
        "screen-program": ["運動プログラム", "コース別のトレーニング・メニューです。"],
        "screen-measure": ["測定＆ゲーム", "スクワット等の計測モードを利用できます。"],
        "screen-tools": ["体力・強度ツール", "VO₂max と METs を使って運動処方を考えます。"],
        "screen-cloud": ["クラウド", "データの同期とアカウント設定を行います。"],
    };

    if (titles[id]) { titleEl.textContent = titles[id][0]; subEl.textContent = titles[id][1]; }

    // View Resets
    if (id === "screen-home") {
        MoveCare.requestAIAddonProposal();
        const header = document.getElementById("condition-header-area");
        const inputView = document.getElementById("mc-view-input");
        const resultView = document.getElementById("mc-view-result");

        if (AppState.homeMode === "result") {
            const restored = restoreProposalFromStorage();
            if (!restored) {
                // V125 Fix: 申請済み OR 既にプランがある場合は Inputに戻さずResult表示(再入力ボタンのみ)にする
                if (AppState.dailyConditionSubmitted || AppState.dailyPlan.length > 0) {
                    if (header) header.classList.add("hidden");
                    if (inputView) inputView.classList.add("hidden");

                    // V124: 結果ビュー自体は出して、「カード」「再作成」は隠し、「再入力」だけ残す
                    if (resultView) resultView.classList.remove("hidden");

                    const card = document.getElementById("mc-result-card-container");
                    if (card) card.classList.add("hidden");
                    const btnCreate = document.getElementById("mc-btn-create-proposal");
                    if (btnCreate) btnCreate.classList.add("hidden");
                    // V133: New Bottom Button
                    const btnRetry = document.getElementById("mc-btn-retry-input-bottom");
                    if (btnRetry) btnRetry.classList.remove("hidden");
                } else {
                    AppState.homeMode = "input";
                    if (header) header.classList.remove("hidden");
                    if (inputView) inputView.classList.remove("hidden");
                    if (resultView) resultView.classList.add("hidden");
                }
            } else {
                if (header) header.classList.add("hidden");
                if (inputView) inputView.classList.add("hidden");
                if (resultView) resultView.classList.remove("hidden");

                // V124: Cache復元成功時は全部見せる
                const card = document.getElementById("mc-result-card-container");
                if (card) card.classList.remove("hidden");
                const btnCreate = document.getElementById("mc-btn-create-proposal");
                if (btnCreate) btnCreate.classList.remove("hidden");
                // V133
                const btnRetry = document.getElementById("mc-btn-retry-input-bottom");
                if (btnRetry) btnRetry.classList.remove("hidden");
            }
        } else {
            if (header) header.classList.remove("hidden");
            if (inputView) inputView.classList.remove("hidden");
            if (resultView) resultView.classList.add("hidden");
        }
        refreshSubjectUI();
    }
    if (id === "screen-activities") {
        filterMetsTable('all', document.querySelector('.activity-filter-chip'));
    }
    if (id === "screen-program") {
        renderProgramList();
    }
    if (id === "screen-plan") {
        // FIXED: Restore Timeline View
        loadConfigFromStorage();
        loadPlanFromStorage();
        renderPlanTimeline();
    }
}

function setActiveNav(id) {
    document.querySelectorAll(".nav-item").forEach(el => el.classList.remove("active"));
    const btn = document.getElementById(id);
    if (btn) btn.classList.add("active");
}

/* --- Dynamic Bottom Nav (Moved) --- */
function renderBottomNav() {
    const navInner = document.querySelector('.bottom-nav-inner');
    if (!navInner) return;

    // Visibility Source Priority: AppState.project.menuConfig > AppState.settings.visibility > Default (All On)
    let configIds = [];
    if (AppState.project && AppState.project.menuConfig && AppState.project.menuConfig.length > 0) {
        configIds = AppState.project.menuConfig;
        console.log("[Nav] Using Project MenuConfig (Priority):", configIds);
    } else if (AppState.settings && AppState.settings.visibility) {
        configIds = APP_MENUS.filter(m => AppState.settings.visibility[m.id] !== false).map(m => m.id);
        console.log("[Nav] Using Settings Visibility:", configIds);
    } else {
        configIds = APP_MENUS.map(m => m.id);
        console.log("[Nav] Using Default (All Visible):", configIds);
    }

    // Map configIds back to menu objects (Reserves Order)
    const visibleMenus = configIds.map(id => APP_MENUS.find(m => m.id === id)).filter(Boolean);

    navInner.innerHTML = visibleMenus.map(m => {
        const customLabels = AppState.project?.menuLabels || {};
        const label = customLabels[m.id] || m.label;
        return `
            <button id="${m.id}" class="nav-item ${m.id === 'nav-home' ? 'active' : ''}" 
                onclick="setActiveNav('${m.id}'); switchScreen('${m.screen}');">
                ${m.icon}<span class="text-[9px]">${label}</span>
            </button>
        `;
    }).join('');
}

function refreshUI() {
    loadFromStorage();
    renderVo2Chart();
    renderVo2Latest();
    updateHomeVo2Chip();
    if (AppState.subject) {
        renderHomeSummary();
        renderWeeklyProgress();
    }
}

/* ===== VO2 Helper Logic (Preserved) ===== */
function loadFromStorage() {
    const vo2raw = localStorage.getItem(STORAGE_KEY_VO2);
    if (vo2raw) {
        AppState.vo2Records = JSON.parse(vo2raw);
        if (AppState.vo2Records.length > 0) AppState.currentVo2max = AppState.vo2Records[AppState.vo2Records.length - 1].value;
    }
}

function vo2ToMETs(vo2) { return (vo2 || 0) / 3.5; }

function estimateVo2FromCS30(reps, age, weight, sex, mode) {
    if (mode === 'cancer') return 22.610 + (0.347 * reps) - (0.127 * weight);
    const sexFactor = (sex === 'male') ? 3.334 : 0;
    return 16.365 + (0.602 * reps) - (0.101 * age) - (0.129 * weight) + sexFactor;
}

function estimatePowerAlcazar(reps, age, weight, height) {
    const chairHeight = 0.44;
    const timeTotal = 30;
    const velocity = (reps * chairHeight * 2) / timeTotal;
    const force = weight * 9.81;
    return (force * velocity) / weight;
}

async function handleVo2Submit(e) {
    e.preventDefault();
    // Simplified: Just saving to LocalStorage + Firestore Log
    // (Existing logic + sync to logs)
    const source = document.getElementById("vo2-source").value;
    const dateStr = document.getElementById("vo2-date").value || getJSTDateStr();
    const reps = parseFloat(document.getElementById("vo2-cs30-rep").value || "0");
    const age = parseFloat(document.getElementById("vo2-age").value || "60");
    const weight = parseFloat(document.getElementById("vo2-weight").value || "60");
    const height = parseFloat(document.getElementById("vo2-height")?.value || "160");
    const sex = document.getElementById("vo2-sex").value;
    const mode = document.getElementById("vo2-mode").value;
    const direct = parseFloat(document.getElementById("vo2-direct").value || "0");

    let vo2 = (source === "CS30") ? estimateVo2FromCS30(reps, age, weight, sex, mode) : direct;
    if (!vo2) { alert("正しい数値を入力してください。"); return; }
    let power = (source === "CS30") ? estimatePowerAlcazar(reps, age, weight, height) : null;

    const record = { date: dateStr, value: parseFloat(vo2.toFixed(1)), source, power: power ? parseFloat(power.toFixed(2)) : null };
    AppState.vo2Records.push(record);
    AppState.vo2Records.sort((a, b) => a.date.localeCompare(b.date));
    AppState.currentVo2max = AppState.vo2Records[AppState.vo2Records.length - 1].value;

    localStorage.setItem(STORAGE_KEY_VO2, JSON.stringify(AppState.vo2Records));

    // Log to AWS
    if (AppState.subject) {
        const logPayload = {
            subjectId: String(AppState.subject.id),
            log: {
                type: "vo2max",
                date: new Date().toISOString(),
                value: record.value,
                source: record.source,
                power: record.power
            }
        };

        fetch(getApiUrl('logs'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(logPayload)
        }).catch(e => console.error("VO2 Log Error", e));
    }


    showEvidence(source, { reps, age, weight, sex, mode });
    refreshUI();
}

function showEvidence(source, params) {
    const el = document.getElementById("tool-evidence");
    const content = document.getElementById("evidence-content");
    if (!el || !content) return;
    el.classList.remove("hidden");
    // (Keep HTML gen same as original)
    content.innerHTML = "Result calculated.";
}

function openDevTool() {
    const iframe = document.getElementById("dev-iframe");
    if (iframe) iframe.src = "predictvo2.html";
    switchScreen("screen-dev");
}

/* --- Notification Permission (referenced from index.html) --- */
async function requestNotificationPermission() {
    if (!("Notification" in window)) {
        alert("このブラウザは通知機能に対応していません。");
        return;
    }
    try {
        const permission = await Notification.requestPermission();
        if (permission === "granted") {
            if (typeof showToast === 'function') showToast("プッシュ通知を有効にしました");
            new Notification("Activity Pacing", { body: "通知が有効になりました。", icon: "/icon.png" });
        } else {
            alert("通知が許可されませんでした。ブラウザの設定をご確認ください。");
        }
    } catch (e) {
        console.error("Notification permission error:", e);
        alert("通知設定中にエラーが発生しました: " + e.message);
    }
}
window.requestNotificationPermission = requestNotificationPermission;

function renderVo2Latest() {
    const valEl = document.getElementById("vo2-latest-value");
    const labelEl = document.getElementById("vo2-latest-label");
    const metsEl = document.getElementById("vo2-latest-mets");
    if (!AppState.currentVo2max) return;
    const latest = AppState.vo2Records[AppState.vo2Records.length - 1];
    valEl.textContent = latest.value.toFixed(1);
    labelEl.textContent = `${latest.date} / ${latest.source}`;
    metsEl.textContent = `${vo2ToMETs(latest.value).toFixed(1)} METs 相当`;

    const pReport = document.getElementById("power-report");
    if (latest.power && pReport) {
        pReport.classList.remove("hidden");
        document.getElementById("power-value").textContent = latest.power;
    }
    renderExtraTools();
}

function renderExtraTools() {
    const container = document.getElementById("extra-tools");
    const slider = document.getElementById("intensity-slider");
    const hrVal = document.getElementById("target-hr-val");
    const metsVal = document.getElementById("target-rel-mets");
    const zoneLabel = document.getElementById("hr-zone-label");
    const pctLabel = document.getElementById("current-intensity-pct");

    if (!container || !AppState.currentVo2max) {
        if (container) container.classList.add("hidden");
        return;
    }
    container.classList.remove("hidden");

    const vo2 = AppState.currentVo2max;
    const age = parseFloat(document.getElementById("vo2-age")?.value || "60");
    const hrRest = parseFloat(document.getElementById("mets-hr-rest")?.value || "70");
    const hrMaxDirect = parseFloat(document.getElementById("mets-hr-max")?.value || "0");
    const hrMax = hrMaxDirect > 0 ? hrMaxDirect : (220 - age);

    const pct = parseInt(slider?.value || "40", 10);
    if (pctLabel) pctLabel.textContent = `${pct}% VO₂max`;
    const targetHr = Math.round(hrRest + (hrMax - hrRest) * pct / 100);
    if (hrVal) hrVal.textContent = targetHr;

    // Zone
    let label = "低強度"; let color = "text-emerald-600";
    if (pct >= 85) { label = "最高強度 (限界)"; color = "text-purple-600"; }
    else if (pct >= 75) { label = "高強度"; color = "text-red-600"; }
    else if (pct >= 60) { label = "中強度"; color = "text-orange-600"; }
    if (zoneLabel) { zoneLabel.textContent = label; zoneLabel.className = `text-[9px] font-bold mt-1 ${color}`; }

    const relMets = (vo2 / 3.5) * (pct / 100);
    if (metsVal) metsVal.textContent = relMets.toFixed(1);
}

function updateHomeVo2Chip() {
    const el = document.getElementById("home-vo2-display");
    if (!el || !AppState.currentVo2max) return;
    const mets = vo2ToMETs(AppState.currentVo2max);
    el.textContent = `VO₂max ${AppState.currentVo2max.toFixed(1)} (${mets.toFixed(1)} METs)`;
}

function renderVo2Chart() {
    const canvas = document.getElementById("vo2-chart");
    if (!canvas || AppState.vo2Records.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (AppState.vo2Chart) AppState.vo2Chart.destroy();
    AppState.vo2Chart = new Chart(ctx, {
        type: "line",
        data: {
            labels: AppState.vo2Records.map(r => r.date),
            datasets: [{ label: "VO₂max", data: AppState.vo2Records.map(r => r.value), borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,0.1)", fill: true, tension: 0.3 }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
}

/* ===== Activities / Modal Helpers ===== */
let selectedActivity = null;
// Duplicate renderActivityCards removed V149

function filterMetsTable(cat, btn) {
    if (btn) {
        btn.parentNode.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
    }
    let list = ACTIVITY_DATABASE;
    if (cat === 'lifestyle') list = list.filter(a => a.planned_mets < 3.0);
    else if (cat === 'exercise') list = list.filter(a => a.planned_mets >= 3.0);

    const container = document.getElementById("mets-table-container");
    if (!container) return;
    container.innerHTML = list.map(item => {
        const mh = MoveCare.calculateMets(item.name, 15);
        return `
        <div class="p-3 bg-white rounded-2xl border border-slate-100 mb-2 shadow-sm hover:border-emerald-200 hover:bg-emerald-50 transition-all cursor-pointer transform active:scale-[0.98] flex justify-between items-center"             onclick="MoveCare.openQuickPlanModal({name: '${item.name}', planned_mets: ${item.planned_mets}})">
            <div class="flex-1">
                <div class="text-[12px] font-bold text-slate-700">${item.name}</div>
                <div class="text-[10px] text-slate-500 font-mono">${item.planned_mets} METs</div>
            </div>
            <div class="text-[10px] text-emerald-600 font-bold bg-emerald-50 px-3 py-1.5 rounded-xl">プランする</div>
        </div>
    `}).join("");
}

// --- Modal Handling ---
MoveCare.openDurationModal = function (name, mets) {
    selectedActivity = { name, mets };
    const modal = document.getElementById("duration-modal");
    if (modal) modal.classList.remove("hidden");
};
window.openDurationModal = MoveCare.openDurationModal; // Alias for safety V149

function confirmDuration() {
    const dur = parseInt(document.getElementById("duration-input").value, 10) || 15;
    const mh = MoveCare.calculateMets(selectedActivity.name, dur);
    MoveCare.logActivity(selectedActivity, dur);
    document.getElementById("duration-modal").classList.add("hidden");
    alert(`「${selectedActivity.name}」を ${dur}分間 (${mh} METs・h) 記録しました！`);
}

function switchCourse(cat, btn) {
    btn.parentNode.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    renderProgramList(cat);
}

function openHIIT(url) {
    const iframe = document.getElementById("hiit-iframe");
    if (iframe) iframe.src = url;
    switchScreen("screen-hiit");
}

function openCustomTimer() { switchScreen('screen-custom-timer'); }

/* ===== Custom Timer (Preserved) ===== */
let timerInterval = null;
let timerSeconds = 0;
let timerPhase = 'READY';
let timerSet = 1;
let timerIsPaused = false;

function startCustomTimer() {
    const sets = parseInt(document.getElementById('timer-sets').value, 10) || 8;
    document.getElementById('timer-settings').classList.add('hidden');
    document.getElementById('timer-active').classList.remove('hidden');
    document.getElementById('timer-total-sets').textContent = sets;
    timerSeconds = 5; timerPhase = 'READY'; timerSet = 1; timerIsPaused = false;
    const pBtn = document.getElementById("timer-pause-btn");
    if (pBtn) pBtn.textContent = "一時停止";
    updateTimerUI(); runTimerCycle();
}

function runTimerCycle() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if (timerIsPaused) return;
        timerSeconds--;
        if (timerSeconds === 0) {
            updateTimerUI(); handlePhaseTransition(); return;
        }
        updateTimerUI();
    }, 1000);
}

function handlePhaseTransition() {
    const workSec = parseInt(document.getElementById('timer-work-sec').value, 10);
    const restSec = parseInt(document.getElementById('timer-rest-sec').value, 10);
    const totalSets = parseInt(document.getElementById('timer-sets').value, 10);

    if (timerPhase === 'READY') {
        timerPhase = 'WORK'; timerSeconds = workSec;
    } else if (timerPhase === 'WORK') {
        if (timerSet >= totalSets) { finishTimer(); }
        else { timerPhase = 'REST'; timerSeconds = restSec; }
    } else {
        timerPhase = 'WORK'; timerSet++; timerSeconds = workSec;
    }
}

function updateTimerUI() {
    const cd = document.getElementById('timer-countdown');
    const status = document.getElementById('timer-status-label');
    const currentSet = document.getElementById('timer-current-set');
    if (cd) cd.textContent = timerSeconds < 10 ? `0${timerSeconds}` : timerSeconds;
    if (status) status.textContent = timerPhase;
    if (currentSet) currentSet.textContent = timerSet;
}

function toggleTimerPause() {
    timerIsPaused = !timerIsPaused;
    const btn = document.getElementById("timer-pause-btn");
    if (btn) btn.textContent = timerIsPaused ? "再開" : "一時停止";
}

function cancelCustomTimer() {
    clearInterval(timerInterval);
    // Reset UI to Settings
    document.getElementById('timer-active').classList.add('hidden');
    document.getElementById('timer-settings').classList.remove('hidden');
    openCustomTimer();
}

function finishTimer() {
    clearInterval(timerInterval);
    alert("お疲れ様でした！");
    // Reset UI to Settings
    document.getElementById('timer-active').classList.add('hidden');
    document.getElementById('timer-settings').classList.remove('hidden');
    openCustomTimer();
    // Log HIIT?
    MoveCare.logActivity({ name: "HIIT Timer", mets: 8.0 }, 4);
}

/* ===== 初期化・統合シーケンス / Startup Sequence ===== */
document.addEventListener("DOMContentLoaded", async () => {
    const authMode = localStorage.getItem("mc-auth-mode");
    const rawUser = localStorage.getItem("currentUser");
    AppState.version = "V151"; // Update AppState.version
    const storedUser = rawUser ? JSON.parse(rawUser) : null;
    console.log("App Startup V151 - Mode: " + AppState.mode + ", StoredUserLen: " + (storedUser ? storedUser.logs?.length || 0 : 0));

    // Fitbit連携成功のパラメータチェック
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("fitbit") === "success") {
        console.log(">>> [Fitbit] Callback success detected. Refreshing profile...");
        // パラメータを消去して履歴をクリーンにする
        window.history.replaceState({}, document.title, window.location.pathname);
        // セッションがあれば即座にリフレッシュをかける
        if (rawUser) {
            try {
                const u = JSON.parse(rawUser);
                await MoveCare.loginAndFetchProfile(u.id, u.name, authMode || "line");
                alert("Fitbitとの連携が完了しました！");
            } catch (e) { console.error(e); }
        }
    }


    // 1. セッション復旧 (同期)
    if (rawUser) {
        try {
            const user = JSON.parse(rawUser);
            const daysDiff = (Date.now() - (user.loginDate || 0)) / (1000 * 60 * 60 * 24);

            if (daysDiff < 30) {
                console.log("Restoring existing session immediately:", user.id);
                AppState.subject = { ...user, id: user.id || user._docId };
                console.log("DEBUG: Session found, restoring state...");

                // Restore Daily Plan from LocalStorage
                loadConfigFromStorage();
                loadPlanFromStorage();

                // If plan exists locally OR in user object, switch to result mode
                // Check if any slot is filled
                const hasPlan = AppState.dailyPlan.length > 0;

                if (hasPlan) {
                    console.log("DEBUG: Active plan detected. Switching to result mode.");
                    AppState.homeMode = "result";
                    // V128: プランがある場合は、既に体調入力も済んでいるとみなしてフラグを復元
                    AppState.dailyConditionSubmitted = true;
                } else {
                    AppState.homeMode = "input";
                }
                if (user.hasFitbit) AppState.fitbitConnected = true;

                // UI反映とマスタ取得
                await MoveCare.fetchGlobalData();
                MoveCare.showAppScreen();
                // Ensure correct view is shown based on mode
                switchScreen("screen-home");
            } else {
                console.log("Session expired. Clearing...");
                localStorage.removeItem("currentUser");
            }
        } catch (e) {
            console.error("Session Restore Error:", e);
            localStorage.removeItem("currentUser");
        }
    }

    // 2. UIセットアップ
    refreshUI();
    const wInput = document.getElementById("weight-input");
    if (wInput) {
        wInput.value = localStorage.getItem("mc-weight-kg") || 60;
        AppState.weight = parseFloat(wInput.value);
        wInput.onchange = (e) => {
            AppState.weight = parseFloat(e.target.value);
            localStorage.setItem("mc-weight-kg", e.target.value);
            refreshUI();
        };
    }

    // 3. LIFF初期化
    await MoveCare.initLIFF();

    // 4. Pro-active Sync (V144)
    // Listen for updates from Admin Tab via localStorage signal
    window.addEventListener('storage', async (e) => {
        if (e.key === 'mc_sync_timestamp') {
            console.log(">>> [Proactive Sync] Change detected from Admin. Re-fetching data... <<<");
            await MoveCare.fetchGlobalData();
            renderBottomNav();
            if (typeof showToast === 'function') showToast("管理設定が更新されました");
        }
    });
});

/* Exports */
window.MoveCare = MoveCare;
window.switchScreen = switchScreen;
window.setActiveNav = setActiveNav;
window.handleVo2Submit = handleVo2Submit;
window.confirmDuration = confirmDuration;
// window.applyAIPosition will be defined below

/* --- UI Handlers (Added for V60 Fix) --- */
window.applyAIPosition = function () {
    console.log("Applying AI Plan. Current tempPlan:", AppState.tempPlan);
    if (AppState.tempPlan && Array.isArray(AppState.tempPlan)) {
        // 既存の予定すべて
        const currentPlans = Array.isArray(AppState.dailyPlan) ? AppState.dailyPlan : [];
        // 重複チェック用のユーザー予定と「既にあるAI予定」を統合してチェックするか検討
        // 今回は「ユーザーが明示的に入れた予定」との重なりだけを避ける（指示通り複数反映を優先）
        const userPlans = currentPlans.filter(p => !p.isAI);

        // AI提案（AppState.tempPlan）を変換
        const newAIItems = AppState.tempPlan.map((item, idx) => {
            if (!item || typeof item !== 'object') return null;
            // タイトルや時刻、またはisAIフラグがあるものを有効とみなす
            if (!(item.isAI || item.title || item.name)) return null;

            let startMinute = 0;
            if (typeof item.startMinute === 'number') {
                startMinute = item.startMinute;
            } else if (item.time && typeof item.time === 'string') {
                const [h_str, m_str] = item.time.split(':');
                startMinute = (parseInt(h_str) || 0) * 60 + (parseInt(m_str) || 0);
            } else if (AppState.tempPlan.length === 19) {
                startMinute = (idx + 5) * 60;
            } else {
                return null;
            }

            return {
                title: "おすすめ活動時間（タップして活動を選択）",
                startMinute: startMinute,
                planned_duration_min: item.planned_duration_min || 15,
                isAI: true,
                isUser: false,
                isPending: true,
                isDone: false,
                isNew: true,
                planned_mets: item.planned_mets || 3.0,
                planned_met_min: Math.round((item.planned_mets || 3.0) * (item.planned_duration_min || 15))
            };
        }).filter(x => x !== null);

        console.log(`Converted ${newAIItems.length} AI items from tempPlan.`);

        // 重複チェック: 既存のユーザー予定と重なるものを除外
        const validNewItems = newAIItems.filter(newItem => {
            const s1 = newItem.startMinute;
            const e1 = s1 + newItem.planned_duration_min;
            return !userPlans.some(u => {
                const s2 = u.startMinute;
                const e2 = s2 + (u.planned_duration_min || 15);
                return (s1 < e2 && e1 > s2);
            });
        });

        console.log(`Items to be added (after overlap check): ${validNewItems.length}`);

        if (validNewItems.length > 0) {
            // 既存の予定に追加
            AppState.dailyPlan = [...currentPlans, ...validNewItems];
            savePlanToStorage();
            renderPlanTimeline();
            if (typeof renderWeeklyProgress === 'function') renderWeeklyProgress();
            if (typeof showToast === 'function') showToast(`${validNewItems.length}件の活動時間を追加しました`);

            // --- 強制非表示とキャッシュクリアの徹底 (V121) ---
            // 反映した後はもう「未反映の提案」ではないため、キャッシュを消してモードを戻す
            localStorage.removeItem("mc_proposal_cache_v1");
            AppState.homeMode = "result"; // 記録後の「結果表示モード」にする（＝入力欄も提案枠も出ない）

            // V127: 基本プラン確定後、即座に追加提案のチェックを走らせる
            MoveCare.requestAIAddonProposal();
        } else {
            alert("既存の予定と重なっているため、新しい枠を追加できませんでした。");
        }

        // DOMの直接隠ぺい (V124: カードコンテナだけ隠す)
        const resultView = document.getElementById("mc-view-result");
        // if (resultView) resultView.classList.add("hidden");  <-- ここでは隠さない (View自体は残す)

        const cardContainer = document.getElementById("mc-result-card-container");
        if (cardContainer) cardContainer.classList.add("hidden");

        const btnCreate = document.getElementById("mc-btn-create-proposal");
        if (btnCreate) btnCreate.classList.add("hidden");

        const addonCard = document.getElementById("ai-addon-card");
        if (addonCard) addonCard.classList.add("hidden");

        // プラン画面へ遷移
        switchScreen('screen-plan');
        setActiveNav('nav-plan');

        // 数秒後にハイライトを消す
        setTimeout(() => {
            validNewItems.forEach(p => p.isNew = false);
            renderPlanTimeline();
        }, 3000);
    } else {
        alert("反映するプランデータが見つかりません。もう一度提案を作成してください。");
    }
};

/* --- Restore Helper --- */
function restoreProposalFromStorage() {
    try {
        const raw = localStorage.getItem("mc_proposal_cache_v1");
        if (!raw) return false;
        const data = JSON.parse(raw);

        // Render using unified helper
        MoveCare.renderDailyAdvice(data);

        // Restore Temp Plan (for Apply button)
        AppState.tempPlan = data.daily_schedule || [];
        return true;
    } catch (e) {
        console.warn("Proposal restore failed", e);
        return false;
    }
}

window.retryProposal = function () {
    if (typeof MoveCare.retryProposal === 'function') {
        MoveCare.retryProposal();
    } else {
        AppState.homeMode = 'input';
        AppState.dailyConditionSubmitted = false;
        localStorage.removeItem("mc_proposal_cache_v1");
        switchScreen('screen-home');
    }
};

/* --- Recommended Activity Add Handler (V82) --- */
window.addRecommendedActivity = function (activityName) {
    const modal = document.getElementById('modal-plan-input');
    if (!modal) return;

    // UI初期化
    MoveCare.setupTimeSelectOptions();

    document.getElementById('plan-input-title').value = activityName;

    // 推奨されるMETs値をこっそり保存（または計算用に利用）
    const activity = ACTIVITY_DATABASE.find(a => a.name === activityName);
    const mets = activity ? activity.planned_mets : 3.0;

    // 開始時間を現在時刻の30分後にセット
    const now = new Date();
    const future = new Date(now.getTime() + 30 * 60 * 1000);
    const h = future.getHours();
    const m = Math.floor(future.getMinutes() / 5) * 5;

    document.getElementById('plan-input-start-h').value = h;
    document.getElementById('plan-input-start-m').value = m;

    // デフォルト15分
    let endH = h;
    let endM = m + 15;
    if (endM >= 60) { endH++; endM -= 60; }
    if (endH >= 24) endH = 0;

    document.getElementById('plan-input-end-h').value = endH;
    document.getElementById('plan-input-end-m').value = endM;

    MoveCare.currentPlanInput = { start: h * 60 + m, end: endH * 60 + endM };

    modal.classList.remove('hidden');
};

window.openDurationModal = openDurationModal;
window.filterMetsTable = filterMetsTable;
window.switchCourse = switchCourse;
window.openHIIT = openHIIT;
window.openCustomTimer = openCustomTimer;
window.startCustomTimer = startCustomTimer;
window.toggleTimerPause = toggleTimerPause;
window.cancelCustomTimer = cancelCustomTimer;

// Helper to update Fitbit badge in Account Screen
// Helper to update Fitbit badge in Account Screen
window.refreshUiFitbitStatus = function () {
    const btn = document.getElementById("btn-fitbit-connect");
    if (!btn) return;

    if (AppState.fitbitConnected) {
        btn.innerHTML = `<span class="text-lg">⌚</span> Fitbit連携済み`;
        btn.disabled = true;
        btn.classList.add("bg-teal-50", "border-teal-200");
    } else {
        btn.innerHTML = `Fitbitアカウントと連携する`;
        btn.disabled = false;
        btn.classList.remove("bg-teal-50", "border-teal-200");
    }
};
window.cancelCustomTimer = cancelCustomTimer;

/* ===== Date Helper (JST) ===== */
function getJSTDateStr() {
    // Returns YYYY-MM-DD in JST
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}
window.getJSTDateStr = getJSTDateStr; // Export

/* --- Priority Chips Helper (V175) --- */
MoveCare.renderPriorityChips = function () {
    const container = document.getElementById("priority-activity-chips");
    if (!container) return;

    // Quick picks for priority
    const picks = ["仕事", "家事", "散歩", "読書", "買い物", "筋トレ", "病院", "孫と遊ぶ", "掃除", "休憩"];

    container.innerHTML = picks.map(txt => `
        <button onclick="MoveCare.ui.setPriorityName('${txt}', true)" 
            class="px-3 py-1.5 rounded-xl bg-slate-50 text-slate-500 text-[11px] font-bold border border-transparent hover:bg-slate-100 transition-all">
            ${txt}
        </button>
    `).join('');
};

/* ===== Helper: Typewriter Effect ===== */
function typeWriter(text, elementId, speed = 20) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.innerHTML = ""; // Clear existing
    let i = 0;

    // Simple recursive timeout loop
    function type() {
        if (i < text.length) {
            el.innerHTML += text.charAt(i);
            i++;
            setTimeout(type, speed);
        }
    }
    type();
}
function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'bg-slate-800 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-xl animate-in fade-in slide-in-from-bottom-4 duration-300';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-2', 'transition-all', 'duration-500');
        setTimeout(() => toast.remove(), 500);
    }, 3000);
}
window.showToast = showToast;
window.typeWriter = typeWriter;

/* ===== VO2 Helper Functions (Ported) ===== */
function intensityToRPE(percent) {
    const p = Number(percent);
    if (p < 40) return { range: "9–11", label: "楽〜やや楽" };
    else if (p <= 60) return { range: "11–13", label: "ややきつい" };
    else return { range: "13–15", label: "きつめ〜かなりきつい" };
}

function getTriAxisPrescription(percentOverride) {
    if (!AppState.currentVo2max) return null;

    const vo2 = AppState.currentVo2max;
    const percent = percentOverride != null ? Number(percentOverride) : 45;

    // Use DOM inputs if available, else defaults (handled safely)
    const hrRestEl = document.getElementById("mets-hr-rest");
    const hrMaxEl = document.getElementById("mets-hr-max");
    const hrRest = parseFloat(hrRestEl?.value || "0");
    const hrMax = parseFloat(hrMaxEl?.value || "0");

    const metMax = vo2ToMETs(vo2);
    const targetVo2 = vo2 * percent / 100;
    const targetMets = vo2ToMETs(targetVo2);

    let targetHr = null;
    if (hrRest && hrMax && hrMax > hrRest) {
        const hrr = hrMax - hrRest;
        targetHr = Math.round(hrRest + hrr * percent / 100);
    }

    const rpe = intensityToRPE(percent);

    return { vo2, metMax, percent, targetVo2, targetMets, targetHr, rpe };
}

function filterActivitiesByAP(apLevel, maxMets) {
    let filtered;
    if (apLevel === "rest") filtered = ACTIVITY_DATABASE.filter(a => a.planned_mets <= 2.0);
    else if (apLevel === "light") filtered = ACTIVITY_DATABASE.filter(a => a.planned_mets <= maxMets * 0.4);
    else if (apLevel === "high") filtered = ACTIVITY_DATABASE.filter(a => a.planned_mets >= maxMets * 0.5);
    else filtered = ACTIVITY_DATABASE; // Includes "normal"

    // 1. Cap by maxMets
    filtered = filtered.filter(a => a.planned_mets <= maxMets);

    // 2. Shuffle to show variety (not just lowest METs)
    for (let i = filtered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
    }

    return filtered;
}

// Initializer merged into the block above (Startup Sequence)
