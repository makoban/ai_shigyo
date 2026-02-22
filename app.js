// ========================================
// AI士業商圏分析レポート v1.0
// エリア入力 + 士業種別選択 → 政府統計 + AI分析 → プレビュー/課金
// ========================================

// ---- Config ----
var WORKER_BASE = 'https://house-search-proxy.ai-fudosan.workers.dev';
var SUPABASE_URL = 'https://ypyrjsdotkeyvzequdez.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_l5yNWlXOZAHABwlbEalGng_R8zioydf';
var supabaseClient = null;
var currentUser = null;

// ---- 士業 Types ----
var SHIGYO_TYPES = [
  { name: '税理士事務所', code: '7242', icon: '📊' },
  { name: '弁護士事務所', code: '7211', icon: '⚖️' },
  { name: '社会保険労務士事務所', code: '7251', icon: '🏢' },
  { name: '行政書士事務所', code: '7231', icon: '📝' },
  { name: '司法書士事務所', code: '7221', icon: '🏛️' },
  { name: '公認会計士事務所', code: '7241', icon: '🔢' }
];

// ---- Prefecture Codes ----
var PREFECTURE_CODES = {
  '北海道':'01','青森県':'02','岩手県':'03','宮城県':'04','秋田県':'05',
  '山形県':'06','福島県':'07','茨城県':'08','栃木県':'09','群馬県':'10',
  '埼玉県':'11','千葉県':'12','東京都':'13','神奈川県':'14','新潟県':'15',
  '富山県':'16','石川県':'17','福井県':'18','山梨県':'19','長野県':'20',
  '岐阜県':'21','静岡県':'22','愛知県':'23','三重県':'24','滋賀県':'25',
  '京都府':'26','大阪府':'27','兵庫県':'28','奈良県':'29','和歌山県':'30',
  '鳥取県':'31','島根県':'32','岡山県':'33','広島県':'34','山口県':'35',
  '徳島県':'36','香川県':'37','愛媛県':'38','高知県':'39','福岡県':'40',
  '佐賀県':'41','長崎県':'42','熊本県':'43','大分県':'44','宮崎県':'45',
  '鹿児島県':'46','沖縄県':'47'
};

// ---- State ----
var analysisData = null;
var currentArea = null;
var currentShigyoType = null;
var isPurchased = false;
var _analysisRunning = false;

// ---- DOM References ----
var areaInput = document.getElementById('area-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorMsg = document.getElementById('error-msg');
var progressSection = document.getElementById('progress-section');
var resultsSection = document.getElementById('results-section');
var resultsContent = document.getElementById('results-content');
var progressLogContent = document.getElementById('progress-log-content');

// ---- On Load: Check for Stripe redirect ----
var _pendingVerifySessionId = null;

(function checkPurchaseReturn() {
  var params = new URLSearchParams(window.location.search);
  var sessionId = params.get('session_id');
  if (sessionId) {
    // sessionStorageから分析データを復元（決済前に保存したもの）
    try {
      var savedAnalysis = sessionStorage.getItem('ai_shigyo_pendingAnalysis');
      var savedArea = sessionStorage.getItem('ai_shigyo_pendingArea');
      if (savedAnalysis && savedArea) {
        analysisData = JSON.parse(savedAnalysis);
        currentArea = JSON.parse(savedArea);
        if (analysisData && analysisData.shigyoType) {
          currentShigyoType = analysisData.shigyoType;
        }
      }
    } catch (e) { /* ignore */ }
    // 認証完了を待ってからverifyPurchaseを実行
    _pendingVerifySessionId = sessionId;
    // URLをクリーンアップ
    window.history.replaceState({}, '', window.location.pathname);
  }

  // オートコンプリート初期化
  initAutocomplete();

  // Supabase認証初期化
  initSupabase();
})();

// ---- Autocomplete ----
function initAutocomplete() {
  var input = document.getElementById('area-input');
  var dropdown = document.getElementById('autocomplete-dropdown');
  var selectedIdx = -1;
  var currentItems = [];

  input.addEventListener('input', function() {
    if (input.disabled) return;
    var query = input.value.trim();
    if (query.length < 1) {
      dropdown.style.display = 'none';
      return;
    }

    currentItems = searchArea(query);
    selectedIdx = -1;

    if (currentItems.length === 0) {
      dropdown.style.display = 'none';
      return;
    }

    dropdown.innerHTML = '';
    currentItems.forEach(function(area, idx) {
      var item = document.createElement('div');
      item.className = 'autocomplete-item';
      var highlighted = highlightMatch(area.fullLabel, query);
      item.innerHTML = '<span class="autocomplete-item__icon">' + (area.type === 'prefecture' ? '🗾' : '📍') + '</span>' +
        '<div><div class="autocomplete-item__name">' + highlighted + '</div>' +
        '<div class="autocomplete-item__type">' + (area.type === 'prefecture' ? '都道府県' : '市区町村') + '</div></div>';
      item.addEventListener('mousedown', function(e) {
        e.preventDefault();
        selectItem(area);
      });
      dropdown.appendChild(item);
    });
    dropdown.style.display = 'block';
  });

  input.addEventListener('keydown', function(e) {
    if (dropdown.style.display !== 'block' || currentItems.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, currentItems.length - 1);
      highlightItem();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, -1);
      highlightItem();
    } else if (e.key === 'Enter') {
      if (selectedIdx >= 0 && selectedIdx < currentItems.length) {
        e.preventDefault();
        selectItem(currentItems[selectedIdx]);
      }
    } else if (e.key === 'Escape') {
      dropdown.style.display = 'none';
    }
  });

  input.addEventListener('blur', function() {
    setTimeout(function() { dropdown.style.display = 'none'; }, 150);
  });

  function highlightItem() {
    var items = dropdown.querySelectorAll('.autocomplete-item');
    items.forEach(function(el, i) {
      el.classList.toggle('is-selected', i === selectedIdx);
    });
  }

  function selectItem(area) {
    input.value = area.fullLabel;
    dropdown.style.display = 'none';
    // ボタン押下で分析開始に統一（即時分析しない）
  }
}

// ---- Supabase Auth ----
var _pendingCheckout = false;

function initSupabase() {
  if (typeof supabase !== 'undefined' && supabase.createClient) {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: 'implicit' }
    });
    // onAuthStateChangeのみで管理（INITIAL_SESSIONイベントで初期セッションも通知される）
    supabaseClient.auth.onAuthStateChange(function(event, session) {
      currentUser = session ? session.user : null;
      updateAuthUI();
      // ログイン完了後にGoogleリダイレクトやログインモーダルを処理
      if (event === 'SIGNED_IN') {
        var modal = document.getElementById('login-modal');
        if (modal && modal.classList.contains('active')) {
          modal.classList.remove('active');
        }
        // ログイン後に購入フローを自動再開
        if (_pendingCheckout && currentArea) {
          _pendingCheckout = false;
          _doCheckout();
        }
      }
      // パスワードリセットリンクからのリダイレクト検知
      if (event === 'PASSWORD_RECOVERY') {
        var newPass = prompt('新しいパスワードを入力してください（6文字以上）');
        if (newPass && newPass.length >= 6) {
          supabaseClient.auth.updateUser({ password: newPass }).then(function(res) {
            if (res.error) alert('パスワード変更エラー: ' + res.error.message);
            else alert('パスワードを変更しました。ログイン済みです。');
          });
        }
      }
      // 認証完了後にStripe決済戻りの購入確認を実行
      if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && _pendingVerifySessionId) {
        // INITIAL_SESSION で未ログイン → ログインを促す
        if (event === 'INITIAL_SESSION' && !session) {
          showLoginModal();
          return;
        }
        var sid = _pendingVerifySessionId;
        _pendingVerifySessionId = null;
        verifyPurchase(sid);
      }
    });
  } else {
    console.warn('[Auth] Supabase SDK not loaded');
  }
}

function updateAuthUI() {
  var authArea = document.getElementById('auth-area');
  if (!authArea) return;
  if (currentUser) {
    var email = currentUser.email || '';
    var displayName = email.split('@')[0];
    authArea.innerHTML = '<span class="auth-user">\uD83D\uDC64 ' + escapeHtml(displayName) + '</span>' +
      '<button class="header__history-btn" onclick="showHistoryModal()">📋 履歴</button>' +
      '<button class="auth-logout-btn" onclick="logoutUser()">ログアウト</button>';
  } else {
    authArea.innerHTML = '<button class="auth-login-btn" onclick="showLoginModal()">🔑 ログイン</button>';
  }
}

function showLoginModal() {
  document.getElementById('login-modal').classList.add('active');
  // デフォルトはログインモード
  switchAuthMode('login');
}

function switchAuthMode(mode) {
  var isLogin = (mode === 'login');
  document.getElementById('auth-mode-title').textContent = isLogin ? 'ログイン' : '新規登録';
  document.getElementById('auth-submit-btn').textContent = isLogin ? 'ログイン' : '登録する';
  document.getElementById('auth-switch-text').innerHTML = isLogin ?
    'アカウントをお持ちでない方は <a href="#" onclick="switchAuthMode(\'signup\'); return false;">新規登録</a>' :
    'すでにアカウントをお持ちの方は <a href="#" onclick="switchAuthMode(\'login\'); return false;">ログイン</a>';
  document.getElementById('auth-error').textContent = '';
  // パスワードリセットモードからの復帰
  document.getElementById('auth-password').style.display = '';
  var forgotEl = document.getElementById('auth-forgot');
  if (forgotEl) forgotEl.style.display = isLogin ? '' : 'none';
  // 現在のモードをdata属性に保持
  document.getElementById('auth-form').dataset.mode = mode;
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  if (!supabaseClient) { alert('認証システムを初期化中です。少々お待ちください。'); return; }

  var email = document.getElementById('auth-email').value.trim();
  var password = document.getElementById('auth-password').value;
  var errorEl = document.getElementById('auth-error');
  var submitBtn = document.getElementById('auth-submit-btn');
  var mode = document.getElementById('auth-form').dataset.mode || 'login';

  if (!email || !password) { errorEl.textContent = 'メールアドレスとパスワードを入力してください'; return; }
  if (password.length < 6) { errorEl.textContent = 'パスワードは6文字以上で入力してください'; return; }

  submitBtn.disabled = true;
  submitBtn.textContent = '処理中...';
  errorEl.textContent = '';

  try {
    var result;
    if (mode === 'reset') {
      // パスワードリセットメール送信
      result = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname
      });
      if (result.error) throw result.error;
      errorEl.style.color = '#10b981';
      errorEl.textContent = 'リセットメールを送信しました。メールのリンクからパスワードを再設定してください。';
      return;
    } else if (mode === 'login') {
      result = await supabaseClient.auth.signInWithPassword({ email: email, password: password });
    } else {
      result = await supabaseClient.auth.signUp({ email: email, password: password });
    }

    if (result.error) throw result.error;

    // 成功 → モーダルを閉じる
    document.getElementById('login-modal').classList.remove('active');
    document.getElementById('auth-form').reset();

  } catch (err) {
    var msg = err.message || '認証エラーが発生しました';
    // よくあるエラーメッセージを日本語化
    if (msg.includes('Invalid login')) msg = 'メールアドレスまたはパスワードが正しくありません';
    if (msg.includes('already registered')) msg = 'このメールアドレスは既に登録されています';
    if (msg.includes('Email not confirmed')) msg = 'メールアドレスが未確認です';
    errorEl.style.color = '';
    errorEl.textContent = msg;
  } finally {
    submitBtn.disabled = false;
    if (mode === 'reset') submitBtn.textContent = 'リセットメールを送信';
    else submitBtn.textContent = (mode === 'login') ? 'ログイン' : '登録する';
  }
}

async function loginWithGoogle() {
  if (!supabaseClient) return;
  var currentUrl = window.location.origin + window.location.pathname;
  // hashやqueryを除いたクリーンなURLを渡す
  var result = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: currentUrl }
  });
  if (result.error) {
    document.getElementById('auth-error').textContent = result.error.message || 'Googleログインエラー';
  }
}

async function logoutUser() {
  if (!supabaseClient) return;
  // signOut()がonAuthStateChangeをトリガーし、currentUser=null + updateAuthUI()が自動実行される
  await supabaseClient.auth.signOut();
}

function showPasswordReset() {
  document.getElementById('auth-mode-title').textContent = 'パスワードリセット';
  document.getElementById('auth-password').style.display = 'none';
  document.getElementById('auth-submit-btn').textContent = 'リセットメールを送信';
  document.getElementById('auth-forgot').style.display = 'none';
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-form').dataset.mode = 'reset';
  document.getElementById('auth-switch-text').innerHTML =
    '<a href="#" onclick="switchAuthMode(\'login\'); return false;">ログインに戻る</a>';
}


// ---- Gemini API via Worker Proxy ----
var _lastGeminiCall = 0;
var _geminiMinInterval = 6000;

async function callGemini(prompt) {
  var now = Date.now();
  var elapsed = now - _lastGeminiCall;
  if (_lastGeminiCall > 0 && elapsed < _geminiMinInterval) {
    var waitMs = _geminiMinInterval - elapsed;
    addLog('  ⏳ API間隔調整 ' + Math.ceil(waitMs/1000) + '秒...', 'info');
    await new Promise(function(r) { setTimeout(r, waitMs); });
  }
  _lastGeminiCall = Date.now();

  var maxRetries = 5;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    var res = await fetch(WORKER_BASE + '/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt })
    });

    if (res.status === 429 && attempt < maxRetries) {
      var waitSec = 10 * (attempt + 1);
      addLog('  API制限検知、' + waitSec + '秒後にリトライ... (' + (attempt + 1) + '/' + maxRetries + ')', 'info');
      await new Promise(function(r) { setTimeout(r, waitSec * 1000); });
      _lastGeminiCall = Date.now();
      continue;
    }

    var data = await res.json();
    if (!res.ok) {
      var errMessage = (data.error && typeof data.error === 'string') ? data.error : (data.error && data.error.message) || ('API Error: ' + res.status);
      throw new Error(errMessage);
    }
    return data.text || '';
  }
  // リトライ上限に達した場合
  throw new Error('AI APIが混雑しています。しばらくしてから再度お試しください。');
}

// ---- e-Stat API via Worker Proxy ----
async function fetchEstatPopulation(prefecture, city) {
  var prefCode = PREFECTURE_CODES[prefecture];
  if (!prefCode) return null;

  addLog('政府統計APIから人口データを取得中...', 'info');
  try {
    var url = WORKER_BASE + '/api/estat/population?statsDataId=0003448233&cdArea=' + prefCode + '000&limit=100';
    var res = await fetch(url);
    if (!res.ok) throw new Error('e-Stat API HTTP ' + res.status);
    var data = await res.json();

    var result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) {
      url = WORKER_BASE + '/api/estat/population?statsDataId=0003448233&cdArea=' + prefCode + '&limit=100';
      res = await fetch(url);
      data = await res.json();
      result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    }

    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) {
      addLog('該当データがありません。AI推計に切り替えます。', 'info');
      return null;
    }

    var values = result.DATA_INF.VALUE;
    var population = null;
    var households = null;

    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      var val = parseInt(v.$, 10);
      if (isNaN(val)) continue;
      if (v['@tab'] === '020' || (v['@cat01'] && v['@cat01'].indexOf('0010') >= 0)) {
        if (!population || val > 100) population = val;
      }
      if (v['@tab'] === '040' || (v['@cat01'] && v['@cat01'].indexOf('0020') >= 0)) {
        if (!households || val > 100) households = val;
      }
    }

    if (population) {
      addLog('人口データ取得成功 (' + formatNumber(population) + '人)', 'success');
      return { total_population: population, households: households || Math.round(population / 2.3), source: 'e-Stat 国勢調査', from_estat: true };
    }
    return null;
  } catch (e) {
    console.warn('[e-Stat] Error:', e);
    addLog('統計API接続エラー: ' + e.message + '。AI推計に切り替えます。', 'info');
    return null;
  }
}

// ---- Logging ----
function addLog(message, type) {
  var div = document.createElement('div');
  div.className = 'log-item' + (type ? ' log-item--' + type : '');
  div.textContent = message;
  progressLogContent.appendChild(div);
  progressLogContent.scrollTop = progressLogContent.scrollHeight;
}

function clearLogs() {
  progressLogContent.innerHTML = '';
}

// ---- Analysis Flow ----
async function startAnalysis() {
  var input = areaInput.value.trim();
  if (!input) { showError('エリア名を入力してください'); return; }

  // 士業種別の選択チェック
  var shigyoSelect = document.getElementById('shigyo-type-select');
  if (!shigyoSelect || !shigyoSelect.value) {
    showError('士業の種別を選択してください');
    return;
  }

  hideError();
  var candidates = searchArea(input);

  if (candidates.length === 0) {
    showError('「' + input + '」に一致するエリアが見つかりません。都道府県名や市区町村名を入力してください。');
    return;
  }

  if (candidates.length === 1) {
    runAreaAnalysis(candidates[0]);
    return;
  }

  // 複数候補 → 選択モーダル
  showAreaSelectModal(candidates);
}

function showAreaSelectModal(candidates) {
  var listEl = document.getElementById('area-select-list');
  listEl.innerHTML = '';

  candidates.forEach(function(area) {
    var btn = document.createElement('button');
    btn.className = 'area-select-btn';
    btn.innerHTML = '<span style="font-size:20px;">📍</span>' +
      '<div><div style="font-weight:700;">' + escapeHtml(area.fullLabel) + '</div>' +
      '<div style="font-size:11px; color:var(--text-muted);">' + (area.type === 'prefecture' ? '都道府県' : '市区町村') + '</div></div>';

    btn.addEventListener('click', function() {
      document.getElementById('area-select-modal').classList.remove('active');
      runAreaAnalysis(area);
    });
    listEl.appendChild(btn);
  });

  document.getElementById('area-select-modal').classList.add('active');
}

// ---- Main Analysis ----
async function runAreaAnalysis(area) {
  if (_analysisRunning) return;
  _analysisRunning = true;
  currentArea = area;

  // 士業種別を取得
  var shigyoSelect = document.getElementById('shigyo-type-select');
  var selectedCode = shigyoSelect ? shigyoSelect.value : '';
  currentShigyoType = null;
  for (var ti = 0; ti < SHIGYO_TYPES.length; ti++) {
    if (SHIGYO_TYPES[ti].code === selectedCode) {
      currentShigyoType = SHIGYO_TYPES[ti];
      break;
    }
  }
  if (!currentShigyoType) {
    showError('士業の種別を選択してください');
    _analysisRunning = false;
    return;
  }

  // 購入チェック・DB読み込みを全体try-catchで囲む
  var purchaseKey = area.fullLabel + '__' + currentShigyoType.code;
  try {
    isPurchased = await isAreaPurchasedAsync(purchaseKey);

    // 購入済みかつDBにデータがあれば即表示（再分析不要）
    if (isPurchased && currentUser) {
      var dbData = await _loadAnalysisDataFromDB(purchaseKey);
      if (dbData) {
        analysisData = dbData;
        document.getElementById('purchase-prompt').style.display = 'none';
        renderResults(analysisData, true);
        showResults();
        _analysisRunning = false;
        return;
      }
    }
  } catch (preErr) {
    // 購入チェック失敗は致命的でないのでfalseとして続行
    isPurchased = isAreaPurchased(purchaseKey);
  }

  hideError();
  hideResults();
  showProgress();
  setLoading(true);
  clearLogs();

  addLog('⚖️ 士業商圏分析を開始します...', 'info');
  addLog('対象エリア: ' + area.fullLabel, 'info');
  addLog('士業種別: ' + currentShigyoType.name, 'info');

  try {
    // Step 1: 統計データ取得
    activateStep('step-data');

    addLog('  政府統計APIから人口データを取得中...', 'info');
    var estatPop = await fetchEstatPopulation(area.prefecture, area.city);

    completeStep('step-data');

    // Step 2: AI士業商圏分析
    activateStep('step-ai');
    addLog('AIが士業商圏データを分析中...', 'info');

    var shigyoPrompt = buildShigyoPrompt(area, estatPop, currentShigyoType);
    var shigyoRaw = await callGemini(shigyoPrompt);
    var marketData = parseJSON(shigyoRaw);

    // e-Stat実データで上書き
    if (estatPop && estatPop.from_estat) {
      if (!marketData.population) marketData.population = {};
      marketData.population.total_population = estatPop.total_population;
      marketData.population.households = estatPop.households;
      marketData.population.source = estatPop.source;
    }

    addLog('→ ' + area.fullLabel + ' × ' + currentShigyoType.name + ' 分析完了', 'success');
    completeStep('step-ai');

    // Step 3: レポート生成
    activateStep('step-report');
    addLog('レポート生成中...', 'info');

    analysisData = {
      area: area,
      shigyoType: currentShigyoType,
      shigyo: marketData,
      timestamp: new Date().toISOString(),
      data_source: '政府統計 + AI'
    };

    renderResults(analysisData, isPurchased);
    completeStep('step-report');
    addLog('✅ 士業商圏分析完了！', 'success');

    hideProgress();
    showResults();

    // 購入済みエリアなら分析データをDBにも保存
    if (isPurchased && currentUser) {
      _saveAnalysisDataToDB(purchaseKey, analysisData);
    }

  } catch (err) {
    addLog('エラー: ' + err.message, 'error');
    showError(err.message);
  } finally {
    setLoading(false);
    _analysisRunning = false;
  }
}

// ---- Build Shigyo Prompt ----
function buildShigyoPrompt(area, estatPop, shigyoType) {
  var pref = area.prefecture || '不明';
  var city = area.city || '';
  var estatInfo = '';
  if (estatPop && estatPop.total_population) {
    estatInfo = '\n\n【参考: 政府統計実データ（国勢調査）】\n' +
      '・総人口: ' + formatNumber(estatPop.total_population) + '人\n' +
      '・世帯数: ' + formatNumber(estatPop.households) + '世帯\n' +
      'これらの実データを基準にして、他の項目も整合性のある値を推定してください。\n';
  }

  return 'あなたは日本の士業（専門家・士業事務所）の開業・市場分析の専門家です。\n' +
    '以下の地域に「' + shigyoType.name + '」を開業することを検討している方向けに、商圏分析データを提供してください。\n\n' +
    '対象エリア: ' + pref + ' ' + city + '\n' +
    '士業種別: ' + shigyoType.name + '（産業分類コード: ' + shigyoType.code + '）\n' +
    estatInfo + '\n' +
    'できる限り正確な数値を提供してください。正確な数値が不明な場合は、合理的な推計値を提供し、sourceフィールドに「推計」と明記してください。\n\n' +
    '重要ルール:\n' +
    '・estimated_offices は当該エリアの推計事務所数（実数）で返してください\n' +
    '・offices_per_10000_population は人口1万人あたりの事務所数（小数点1桁）で返してください\n' +
    '・avg_revenue_per_office, market_size_estimate は万円単位の数値で返してください\n' +
    '・suitability_score 内の各スコアは100点満点で返してください\n' +
    '・パーセンテージは数値のみ（例: 25.3）で返してください\n' +
    '・shigyo_summary は1000文字程度の日本語テキストで、当該士業の商圏特性・開業メリット/デメリット・競合状況・市場機会を具体的に記述してください\n' +
    '・marketing_channels のチャネルは士業に特化した集客手法を提案してください\n' +
    '・client_demographics は当該士業種別のターゲット顧客の特性を詳しく記述してください\n\n' +
    '以下のJSON形式で回答してください。マークダウンのコードブロックで囲まず、純粋なJSONのみ返してください:\n' +
    JSON.stringify({
      area_name: pref + ' ' + city,
      shigyo_type: shigyoType.name,
      shigyo_summary: '（1000文字程度の士業商圏分析: 当該士業の商圏特性・開業メリット/デメリット・競合状況・市場機会を具体的に記述）',
      population: {
        total_population: 0,
        households: 0,
        population_density: 0,
        growth_rate: '+0.0%',
        source: 'データソース名'
      },
      competitor_analysis: {
        estimated_offices: 0,
        offices_per_10000_population: 0,
        national_avg_per_10000: 0,
        prefecture_avg_per_10000: 0,
        competition_level: '低/中/高/飽和',
        total_professionals: 0,
        avg_revenue_per_office: 0,
        market_size_estimate: 0,
        nearby_major_firms: ['事務所名1', '事務所名2'],
        differentiation_opportunities: ['差別化ポイント1', '差別化ポイント2']
      },
      client_demographics: {
        individual_clients: {
          count: 0,
          pct: 0,
          avg_fee: 0,
          description: '個人顧客の特性・ニーズ'
        },
        corporate_clients: {
          count: 0,
          pct: 0,
          avg_fee: 0,
          description: '法人顧客の特性・ニーズ'
        },
        primary_needs: ['ニーズ1', 'ニーズ2', 'ニーズ3'],
        growth_sectors: ['成長分野1', '成長分野2'],
        seasonal_demand: '繁忙期の説明（例: 税理士なら確定申告期など）'
      },
      suitability_score: {
        overall_score: 0,
        population_score: 0,
        competition_score: 0,
        demand_score: 0,
        accessibility_score: 0,
        growth_score: 0,
        grade: 'S/A/B/C/D',
        ai_recommendation: '開業に関するAI総合判定（200文字程度）'
      },
      marketing_channels: {
        channels: [
          {
            name: '紹介・口コミ',
            score: 0,
            detail: '具体的な施策',
            reason: '推奨理由'
          },
          {
            name: 'Web集客（SEO）',
            score: 0,
            detail: '具体的な施策',
            reason: '推奨理由'
          },
          {
            name: '士業ポータルサイト',
            score: 0,
            detail: '具体的な施策',
            reason: '推奨理由'
          },
          {
            name: 'セミナー・勉強会',
            score: 0,
            detail: '具体的な施策',
            reason: '推奨理由'
          }
        ],
        best_channel: '最も推奨するチャネル名',
        strategy_summary: '集客戦略の提言（200文字程度）'
      }
    }, null, 2);
}

// ---- JSON Parser ----
function parseJSON(text) {
  var cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    var match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { /* fall through */ }
    }
    throw new Error('AIの応答をパースできませんでした。再度お試しください。');
  }
}

// ---- Render Results ----
function renderResults(data, purchased) {
  var m = data.shigyo;
  var area = data.area;
  var shigyoType = data.shigyoType || currentShigyoType || { name: '士業事務所', icon: '⚖️' };
  var html = '';

  var sourceBadge = '<span style="background: linear-gradient(135deg, #6366f1, #8b5cf6); color:#fff; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">📊 実データ + AI分析</span>';

  // エリア情報カード
  html += '<div class="result-card result-card--company">' +
    '<div class="result-card__header">' +
    '<div class="result-card__icon">' + (shigyoType.icon || '⚖️') + '</div>' +
    '<div>' +
    '<div class="result-card__title">' + escapeHtml(area.fullLabel) + ' 士業商圏分析</div>' +
    '<div class="result-card__subtitle">AI士業商圏レポート ' + sourceBadge + '</div>' +
    '</div></div>' +
    '<div class="result-card__body">' +
    '<table class="data-table">' +
    '<tr><th>分析対象</th><td>' + escapeHtml(area.fullLabel) + '</td></tr>' +
    '<tr><th>士業種別</th><td>' + escapeHtml(shigyoType.name) + '</td></tr>' +
    '<tr><th>分析日時</th><td>' + new Date().toLocaleString('ja-JP') + '</td></tr>' +
    '</table>' +
    '</div></div>';

  // ① 人口・世帯（無料プレビュー）
  if (m.population) {
    var pop = m.population;
    var popSource = pop.source ? ' <span style="font-size:11px; color:var(--text-muted);">(' + escapeHtml(pop.source) + ')</span>' : '';
    html += '<div class="result-card" data-section="free">' +
      '<div class="result-card__header"><div class="result-card__icon">👥</div>' +
      '<div><div class="result-card__title">① エリア人口・世帯' + popSource + '</div>' +
      '<div class="result-card__subtitle"><span class="badge-free">無料プレビュー</span></div></div></div>' +
      '<div class="result-card__body">' +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pop.total_population) + '</div><div class="stat-box__label">総人口（人）</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pop.households) + '</div><div class="stat-box__label">世帯数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (pop.population_density ? formatNumber(pop.population_density) : '—') + '</div><div class="stat-box__label">人口密度（人/km²）</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (pop.growth_rate || '—') + '</div><div class="stat-box__label">人口増減率</div></div>' +
      '</div></div></div>';
  }

  // 有料セクション共通設定
  var paidClass = purchased ? '' : ' blurred-section';
  var paidOverlay = purchased ? '' : '<div class="blur-overlay"><div class="blur-overlay__inner"><span class="blur-overlay__icon">🔒</span><span>購入すると表示されます</span></div></div>';

  // ② AI士業商圏分析（有料）
  if (m.shigyo_summary) {
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🤖</div>' +
      '<div><div class="result-card__title">② AI士業商圏分析</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div class="market-summary">' + escapeHtml(m.shigyo_summary).replace(/\n/g, '<br>') + '</div>' +
      '</div></div>';
  }

  // ③ 同業事務所数・競合状況（有料）
  if (m.competitor_analysis) {
    var ca = m.competitor_analysis;
    var compLevelColor = {
      '低': '#10b981', '中': '#f59e0b', '高': '#f97316', '飽和': '#ef4444'
    };
    var clColor = compLevelColor[ca.competition_level] || '#94a3b8';

    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🏛️</div>' +
      '<div><div class="result-card__title">③ 同業事務所数・競合状況</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(ca.estimated_offices) + '</div><div class="stat-box__label">推計事務所数（件）</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (ca.offices_per_10000_population || '—') + '</div><div class="stat-box__label">1万人あたり事務所数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (ca.national_avg_per_10000 || '—') + '</div><div class="stat-box__label">全国平均（1万人あたり）</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (ca.total_professionals || '—') + '</div><div class="stat-box__label">推計従事者数（人）</div></div>' +
      '</div>' +
      '<table class="data-table" style="margin-top:8px;">' +
      '<tr><th>競合レベル</th><td><span class="highlight" style="color:' + clColor + ';">' + escapeHtml(ca.competition_level || '—') + '</span></td></tr>' +
      '<tr><th>都道府県平均（1万人あたり）</th><td>' + (ca.prefecture_avg_per_10000 || '—') + '</td></tr>' +
      '<tr><th>事務所あたり平均年商</th><td>' + (ca.avg_revenue_per_office ? formatNumber(ca.avg_revenue_per_office) + ' 万円' : '—') + '</td></tr>' +
      '<tr><th>市場規模推計</th><td>' + (ca.market_size_estimate ? formatNumber(ca.market_size_estimate) + ' 万円' : '—') + '</td></tr>' +
      '</table>';

    if (ca.nearby_major_firms && ca.nearby_major_firms.length > 0) {
      html += '<div style="margin-top:12px;"><div style="font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">近隣主要事務所</div>';
      html += '<div class="tag-list">';
      ca.nearby_major_firms.forEach(function(firm) {
        html += '<span class="tag">🏛️ ' + escapeHtml(firm) + '</span>';
      });
      html += '</div></div>';
    }

    if (ca.differentiation_opportunities && ca.differentiation_opportunities.length > 0) {
      html += '<div style="margin-top:12px;"><div style="font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">差別化の機会</div>';
      html += '<div class="tag-list">';
      ca.differentiation_opportunities.forEach(function(opp) {
        html += '<span class="tag" style="border-color:rgba(99,102,241,0.3); color:#6366f1;">✅ ' + escapeHtml(opp) + '</span>';
      });
      html += '</div></div>';
    }

    html += '</div></div>';
  }

  // ④ 顧客層分析（有料）
  if (m.client_demographics) {
    var cd = m.client_demographics;
    var indPct = cd.individual_clients ? (cd.individual_clients.pct || 0) : 0;
    var corpPct = cd.corporate_clients ? (cd.corporate_clients.pct || 0) : 0;

    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">👔</div>' +
      '<div><div class="result-card__title">④ 顧客層分析</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay;

    // 個人 vs 法人の割合バー
    html += '<div style="margin-bottom:16px;">' +
      '<div style="font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">顧客構成（個人 vs 法人）</div>' +
      '<div style="display:flex; height:28px; border-radius:8px; overflow:hidden; font-size:11px; font-weight:700;">' +
      '<div style="width:' + indPct + '%; background:#6366f1; display:flex; align-items:center; justify-content:center; color:#fff;">' + (indPct >= 15 ? '個人 ' + indPct + '%' : '') + '</div>' +
      '<div style="width:' + corpPct + '%; background:#8b5cf6; display:flex; align-items:center; justify-content:center; color:#fff;">' + (corpPct >= 15 ? '法人 ' + corpPct + '%' : '') + '</div>' +
      '</div>' +
      '<div style="display:flex; gap:16px; margin-top:4px; font-size:10px; color:var(--text-muted);">' +
      '<span>🟣 個人 ' + indPct + '%</span><span>🟤 法人 ' + corpPct + '%</span></div></div>';

    // 個人客詳細
    if (cd.individual_clients) {
      var ic = cd.individual_clients;
      html += '<div style="margin-bottom:12px; padding:10px; border-radius:8px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.2);">' +
        '<div style="font-size:13px; font-weight:700; color:#6366f1; margin-bottom:4px;">🧑 個人顧客</div>' +
        '<table class="data-table">' +
        '<tr><th>推計件数</th><td>' + formatNumber(ic.count) + ' 件/年</td></tr>' +
        '<tr><th>平均報酬</th><td>' + (ic.avg_fee ? formatNumber(ic.avg_fee) + ' 円' : '—') + '</td></tr>' +
        '</table>' +
        (ic.description ? '<div style="font-size:12px; color:var(--text-secondary); margin-top:6px;">' + escapeHtml(ic.description) + '</div>' : '') +
        '</div>';
    }

    // 法人客詳細
    if (cd.corporate_clients) {
      var cc = cd.corporate_clients;
      html += '<div style="margin-bottom:12px; padding:10px; border-radius:8px; background:rgba(139,92,246,0.08); border:1px solid rgba(139,92,246,0.2);">' +
        '<div style="font-size:13px; font-weight:700; color:#8b5cf6; margin-bottom:4px;">🏢 法人顧客</div>' +
        '<table class="data-table">' +
        '<tr><th>推計件数</th><td>' + formatNumber(cc.count) + ' 件/年</td></tr>' +
        '<tr><th>平均報酬</th><td>' + (cc.avg_fee ? formatNumber(cc.avg_fee) + ' 円' : '—') + '</td></tr>' +
        '</table>' +
        (cc.description ? '<div style="font-size:12px; color:var(--text-secondary); margin-top:6px;">' + escapeHtml(cc.description) + '</div>' : '') +
        '</div>';
    }

    // 主要ニーズ
    if (cd.primary_needs && cd.primary_needs.length > 0) {
      html += '<div style="margin-top:8px;"><div style="font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">主要ニーズ</div>';
      html += '<div class="tag-list">';
      cd.primary_needs.forEach(function(need) {
        html += '<span class="tag" style="border-color:rgba(99,102,241,0.3); color:#6366f1;">💡 ' + escapeHtml(need) + '</span>';
      });
      html += '</div></div>';
    }

    // 成長分野
    if (cd.growth_sectors && cd.growth_sectors.length > 0) {
      html += '<div style="margin-top:8px;"><div style="font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">成長分野</div>';
      html += '<div class="tag-list">';
      cd.growth_sectors.forEach(function(sector) {
        html += '<span class="tag" style="border-color:rgba(16,185,129,0.3); color:#10b981;">📈 ' + escapeHtml(sector) + '</span>';
      });
      html += '</div></div>';
    }

    // 繁忙期
    if (cd.seasonal_demand) {
      html += '<div class="summary-box" style="margin-top:10px;">' +
        '<div class="summary-box__title">📅 繁忙期・季節需要</div>' +
        '<div class="summary-box__text">' + escapeHtml(cd.seasonal_demand) + '</div></div>';
    }

    html += '</div></div>';
  }

  // ⑤ 開業適性スコア（有料）
  if (m.suitability_score) {
    var ss = m.suitability_score;
    var gradeColor = { S: '#10b981', A: '#3b82f6', B: '#f59e0b', C: '#f97316', D: '#ef4444' };
    var gc = gradeColor[ss.grade] || '#94a3b8';

    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🎯</div>' +
      '<div><div class="result-card__title">⑤ 開業適性スコア</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div style="text-align:center; margin-bottom:16px;">' +
      '<div style="font-size:60px; font-weight:900; color:' + gc + '; line-height:1;">' + (ss.overall_score || '—') + '</div>' +
      '<div style="font-size:14px; color:var(--text-muted);">/ 100点</div>' +
      '<div style="font-size:32px; font-weight:900; color:' + gc + '; margin-top:4px;">グレード ' + escapeHtml(ss.grade || '—') + '</div>' +
      '</div>' +
      '<table class="data-table">' +
      '<tr><th>人口・需要規模</th><td><span class="highlight">' + (ss.population_score || '—') + '</span> 点</td></tr>' +
      '<tr><th>競合環境</th><td><span class="highlight">' + (ss.competition_score || '—') + '</span> 点</td></tr>' +
      '<tr><th>需要・ニーズ</th><td><span class="highlight">' + (ss.demand_score || '—') + '</span> 点</td></tr>' +
      '<tr><th>アクセス・立地</th><td><span class="highlight">' + (ss.accessibility_score || '—') + '</span> 点</td></tr>' +
      '<tr><th>市場成長性</th><td><span class="highlight">' + (ss.growth_score || '—') + '</span> 点</td></tr>' +
      '</table>';

    if (ss.ai_recommendation) {
      html += '<div class="summary-box" style="margin-top:10px;">' +
        '<div class="summary-box__title">🤖 AI総合判定</div>' +
        '<div class="summary-box__text">' + escapeHtml(ss.ai_recommendation) + '</div></div>';
    }
    html += '</div></div>';
  }

  // ⑥ 集客チャネル推奨（有料）
  if (m.marketing_channels) {
    var mc = m.marketing_channels;
    var channels = mc.channels || [];

    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">📢</div>' +
      '<div><div class="result-card__title">⑥ 集客チャネル推奨</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay;

    var medals = ['🥇', '🥈', '🥉'];
    var sortedCh = channels.slice().sort(function(a, b) { return (b.score || 0) - (a.score || 0); });
    html += '<div style="font-size:12px; font-weight:600; margin-bottom:8px; color:var(--text-secondary);">推奨集客チャネル</div>';
    sortedCh.forEach(function(ch, idx) {
      var score = ch.score || 0;
      var isBest = (idx === 0);
      var barColor = isBest ? '#6366f1' : (idx === 1 ? '#8b5cf6' : '#6b7280');
      var medal = medals[idx] || '　';
      html += '<div style="margin-bottom:8px; padding:10px; border-radius:8px; background:' + (isBest ? 'rgba(99,102,241,0.1)' : 'rgba(30,41,59,0.5)') + '; border:1px solid ' + (isBest ? 'rgba(99,102,241,0.3)' : 'rgba(99,102,241,0.1)') + ';">' +
        '<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">' +
        '<span style="font-size:16px;">' + medal + '</span>' +
        '<span style="font-weight:700; font-size:13px; color:var(--text-primary);">' + escapeHtml(ch.name || '') + '</span>' +
        '<span style="font-size:18px; font-weight:800; color:' + barColor + '; margin-left:auto;">' + score + '<span style="font-size:11px; font-weight:400;">点</span></span>' +
        (isBest ? '<span style="background:#6366f1; color:#fff; font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px;">推奨</span>' : '') +
        '</div>' +
        '<div style="height:6px; background:rgba(255,255,255,0.1); border-radius:3px; overflow:hidden; margin-bottom:4px;">' +
        '<div style="height:100%; width:' + score + '%; background:' + barColor + '; border-radius:3px;"></div></div>' +
        (ch.detail ? '<div style="font-size:11px; color:var(--text-muted);">📋 ' + escapeHtml(ch.detail) + '</div>' : '') +
        '<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">→ ' + escapeHtml(ch.reason || '') + '</div>' +
        '</div>';
    });

    if (mc.best_channel) {
      html += '<div style="margin-top:8px; padding:8px 12px; background:rgba(99,102,241,0.1); border-radius:8px; font-size:12px; color:#6366f1; font-weight:600;">🏆 最推奨チャネル: ' + escapeHtml(mc.best_channel) + '</div>';
    }

    if (mc.strategy_summary) {
      html += '<div class="summary-box" style="margin-top:10px"><div class="summary-box__title">💡 集客戦略の提言</div><div class="summary-box__text">' + escapeHtml(mc.strategy_summary) + '</div></div>';
    }
    html += '</div></div>';
  }

  resultsContent.innerHTML = html;

  // 未購入なら購入プロンプトを表示
  if (!purchased) {
    document.getElementById('purchase-prompt').style.display = 'flex';
  } else {
    document.getElementById('purchase-prompt').style.display = 'none';
    hidePurchaseFloat();
  }
}

// ---- Stripe Checkout ----
function startCheckout() {
  if (!currentArea) return;

  // 未ログインなら先にログインを促す（ログイン後に自動で _doCheckout を実行）
  if (!currentUser) {
    _pendingCheckout = true;
    showLoginModal();
    return;
  }

  _doCheckout();
}

async function _doCheckout() {
  if (!currentArea || !currentUser) return;

  var shigyoType = currentShigyoType || (analysisData && analysisData.shigyoType);
  if (!shigyoType) {
    alert('士業の種別が選択されていません。再分析してください。');
    return;
  }

  // 決済リダイレクト前に分析データを保存（戻ってきた時に復元するため）
  if (analysisData) {
    try {
      var serialized = JSON.stringify(analysisData);
      sessionStorage.setItem('ai_shigyo_pendingAnalysis', serialized);
      sessionStorage.setItem('ai_shigyo_pendingArea', JSON.stringify(currentArea));
    } catch (e) {
      console.error('[Checkout] sessionStorage保存失敗:', e);
      if (!confirm('分析データの一時保存に失敗しました。決済後は履歴からレポートを再表示できます。続行しますか？')) {
        return;
      }
    }
  }

  var btn = document.getElementById('purchase-btn');
  btn.disabled = true;
  btn.textContent = '処理中...';

  try {
    // セッションからJWTを取得
    var session = await supabaseClient.auth.getSession();
    var token = session.data.session ? session.data.session.access_token : null;
    if (!token) throw new Error('認証トークンが取得できません。再ログインしてください。');

    var purchaseKey = currentArea.fullLabel + '__' + shigyoType.code;

    var res = await fetch(WORKER_BASE + '/api/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        area: purchaseKey,
        area_code: currentArea.code || '',
        service: 'ai-shigyo',
        shigyo_type: shigyoType.name,
        shigyo_code: shigyoType.code,
        success_url: window.location.origin + window.location.pathname + '?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: window.location.origin + window.location.pathname
      })
    });

    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout作成エラー');

    // Stripe CheckoutページへリダイレクトWorkerが返すURLを直接使用）
    if (!data.url) throw new Error('Checkout URLが取得できませんでした');
    window.location.href = data.url;

  } catch (err) {
    alert('決済エラー: ' + err.message);
    btn.disabled = false;
    btn.textContent = '💳 購入してレポートを見る';
  }
}

async function verifyPurchase(sessionId) {
  try {
    // JWTを取得してAuthorizationヘッダーに付与
    var headers = {};
    if (supabaseClient && currentUser) {
      var session = await supabaseClient.auth.getSession();
      var token = session.data.session ? session.data.session.access_token : null;
      if (token) headers['Authorization'] = 'Bearer ' + token;
    }
    var res = await fetch(WORKER_BASE + '/api/purchases?session_id=' + encodeURIComponent(sessionId), { headers: headers });
    var data = await res.json();
    if (data.purchased) {
      // 購入情報をローカルに保存
      savePurchase(data.area, sessionId);
      isPurchased = true;

      // 分析データがあれば購入プロンプトを消して全データ表示
      if (analysisData && analysisData.area) {
        document.getElementById('purchase-prompt').style.display = 'none';
        renderResults(analysisData, true);
        showResults();

        // 領収書メール案内（購入直後のみ表示）
        var receiptNote = document.createElement('div');
        receiptNote.style.cssText = 'text-align:center; padding:8px; margin:8px 0; background:rgba(99,102,241,0.1); border-radius:8px; font-size:13px; color:#6366f1;';
        receiptNote.textContent = '購入ありがとうございます。領収書はご登録メールアドレスに送信されます。';
        var resultsHeader = document.querySelector('.results__header');
        if (resultsHeader) resultsHeader.after(receiptNote);

        // 分析データをDBに保存
        var purchaseKey = data.area;
        _saveAnalysisDataToDB(purchaseKey, analysisData);
      }

      // sessionStorageクリア
      sessionStorage.removeItem('ai_shigyo_pendingAnalysis');
      sessionStorage.removeItem('ai_shigyo_pendingArea');
    }
  } catch (e) {
    console.warn('Purchase verification failed:', e);
  }
}

// ---- DB Analysis Data ----
async function _saveAnalysisDataToDB(areaName, data) {
  if (!currentUser || !supabaseClient) return;
  try {
    var session = await supabaseClient.auth.getSession();
    var token = session.data.session ? session.data.session.access_token : null;
    if (!token) return;
    await fetch(WORKER_BASE + '/api/purchases/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ area_name: areaName, analysis_data: data, service_name: 'ai-shigyo' })
    });
  } catch (e) { console.warn('Analysis data save failed:', e); }
}

async function _loadAnalysisDataFromDB(areaName) {
  if (!currentUser || !supabaseClient) return null;
  try {
    var session = await supabaseClient.auth.getSession();
    var token = session.data.session ? session.data.session.access_token : null;
    if (!token) return null;
    var res = await fetch(WORKER_BASE + '/api/purchases/data?area_name=' + encodeURIComponent(areaName) + '&service_name=ai-shigyo', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var result = await res.json();
    if (result.found && result.analysis_data) return result.analysis_data;
  } catch (e) { /* fall through */ }
  return null;
}

// ---- Purchase History (localStorage) ----
function getPurchases() {
  try {
    return JSON.parse(localStorage.getItem('ai_shigyo_purchases') || '[]');
  } catch (e) { return []; }
}

function savePurchase(areaName, sessionId) {
  var purchases = getPurchases();
  if (!purchases.some(function(p) { return p.area === areaName; })) {
    purchases.push({ area: areaName, session_id: sessionId, date: new Date().toISOString() });
    localStorage.setItem('ai_shigyo_purchases', JSON.stringify(purchases));
  }
}

function isAreaPurchased(areaName) {
  return getPurchases().some(function(p) { return p.area === areaName; });
}

async function isAreaPurchasedAsync(areaName) {
  // ログイン中ならWorker API経由でDB確認
  if (currentUser && supabaseClient) {
    try {
      var session = await supabaseClient.auth.getSession();
      var token = session.data.session ? session.data.session.access_token : null;
      if (token) {
        var res = await fetch(WORKER_BASE + '/api/purchases/check?area_name=' + encodeURIComponent(areaName) + '&service_name=ai-shigyo', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        var result = await res.json();
        if (result.purchased) return true;
      }
    } catch (e) { /* fall through to localStorage */ }
  }
  // フォールバック: localStorage
  return isAreaPurchased(areaName);
}

async function showHistoryModal() {
  var listEl = document.getElementById('history-list');

  if (currentUser && supabaseClient) {
    // Worker API経由でDB購入履歴を取得
    listEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">読み込み中...</p>';
    document.getElementById('history-modal').classList.add('active');

    try {
      var session = await supabaseClient.auth.getSession();
      var token = session.data.session ? session.data.session.access_token : null;
      if (!token) throw new Error('認証トークンなし');

      var res = await fetch(WORKER_BASE + '/api/purchases/history?service_name=ai-shigyo', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || '履歴取得エラー');
      var purchases = data.purchases || [];

      if (purchases.length === 0) {
        listEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">購入履歴はありません</p>';
      } else {
        listEl.innerHTML = '';
        purchases.forEach(function(p) {
          // area_name は "エリア名__shigyoCode" 形式の可能性があるため表示用に整形
          var displayName = p.area_name;
          var parts = displayName.split('__');
          var areaLabel = parts[0];
          var shigyoCode = parts[1] || '';
          var shigyoLabel = '';
          for (var ti = 0; ti < SHIGYO_TYPES.length; ti++) {
            if (SHIGYO_TYPES[ti].code === shigyoCode) {
              shigyoLabel = ' (' + SHIGYO_TYPES[ti].name + ')';
              break;
            }
          }

          var btn = document.createElement('button');
          btn.className = 'area-select-btn';
          btn.innerHTML = '<span style="font-size:20px;">✅</span>' +
            '<div><div style="font-weight:700;">' + escapeHtml(areaLabel + shigyoLabel) + '</div>' +
            '<div style="font-size:11px; color:var(--text-muted);">購入日: ' + new Date(p.purchased_at).toLocaleDateString('ja-JP') + '</div></div>';
          btn.addEventListener('click', async function() {
            document.getElementById('history-modal').classList.remove('active');
            // DBから分析データを読み出し
            var dbData = await _loadAnalysisDataFromDB(p.area_name);
            if (dbData) {
              analysisData = dbData;
              currentArea = dbData.area;
              currentShigyoType = dbData.shigyoType;
              isPurchased = true;
              areaInput.value = dbData.area.fullLabel;
              // 士業種別セレクトを復元
              var sel = document.getElementById('shigyo-type-select');
              if (sel && dbData.shigyoType) sel.value = dbData.shigyoType.code;
              document.getElementById('purchase-prompt').style.display = 'none';
              renderResults(analysisData, true);
              showResults();
            } else {
              // DBにデータがなければ従来通り再分析
              areaInput.value = areaLabel;
              var sel2 = document.getElementById('shigyo-type-select');
              if (sel2 && shigyoCode) sel2.value = shigyoCode;
              startAnalysis();
            }
          });
          listEl.appendChild(btn);
        });
      }
    } catch (err) {
      // DBエラー時はlocalStorageにフォールバック
      showHistoryFromLocalStorage(listEl);
    }
  } else {
    // 未ログイン時はlocalStorageから
    showHistoryFromLocalStorage(listEl);
    document.getElementById('history-modal').classList.add('active');
  }
}

function showHistoryFromLocalStorage(listEl) {
  var purchases = getPurchases();
  if (purchases.length === 0) {
    listEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">購入履歴はありません。ログインするとDB履歴を表示できます。</p>';
  } else {
    listEl.innerHTML = '';
    purchases.forEach(function(p) {
      var displayName = p.area;
      var parts = displayName.split('__');
      var areaLabel = parts[0];
      var shigyoCode = parts[1] || '';
      var shigyoLabel = '';
      for (var ti = 0; ti < SHIGYO_TYPES.length; ti++) {
        if (SHIGYO_TYPES[ti].code === shigyoCode) {
          shigyoLabel = ' (' + SHIGYO_TYPES[ti].name + ')';
          break;
        }
      }

      var btn = document.createElement('button');
      btn.className = 'area-select-btn';
      btn.innerHTML = '<span style="font-size:20px;">✅</span>' +
        '<div><div style="font-weight:700;">' + escapeHtml(areaLabel + shigyoLabel) + '</div>' +
        '<div style="font-size:11px; color:var(--text-muted);">購入日: ' + new Date(p.date).toLocaleDateString('ja-JP') + '</div></div>';
      btn.addEventListener('click', function() {
        document.getElementById('history-modal').classList.remove('active');
        areaInput.value = areaLabel;
        var sel = document.getElementById('shigyo-type-select');
        if (sel && shigyoCode) sel.value = shigyoCode;
        startAnalysis();
      });
      listEl.appendChild(btn);
    });
  }
}

// ---- PDF Export ----
function handlePdfDownload() {
  if (!isPurchased) {
    alert('PDFダウンロードは有料レポート購入後に利用できます。');
    return;
  }
  exportPDF();
}

async function exportPDF() {
  if (!analysisData || !analysisData.shigyo) { alert('分析データがありません'); return; }

  var m = analysisData.shigyo;
  var area = analysisData.area;
  var shigyoType = analysisData.shigyoType || { name: '士業事務所', icon: '⚖️' };
  var dateStr = new Date().toLocaleDateString('ja-JP');

  var html = '<div style="max-width:100%; font-family:\'Noto Sans JP\',sans-serif; color:#000; background:#fff; font-size:12px; line-height:1.6; padding:0;">';

  // セクション共通スタイル
  var S = 'page-break-inside:avoid; margin-bottom:6px; border:1px solid #cbd5e1; border-radius:4px; padding:8px 12px;';
  var T = 'font-size:14px; font-weight:700; border-left:4px solid #6366f1; padding-left:8px; margin-bottom:6px; color:#1e293b;';
  var TBL = 'width:100%; border-collapse:collapse; font-size:11px;';
  var TH = 'text-align:left; padding:5px 8px; background:#e2e8f0; border:1px solid #cbd5e1; font-weight:600; color:#1e293b; width:40%;';
  var TD = 'padding:5px 8px; border:1px solid #cbd5e1; color:#000;';

  function r(label, val) {
    return '<tr><th style="' + TH + '">' + escapeHtml(label) + '</th><td style="' + TD + '">' + escapeHtml(String(val || '—')) + '</td></tr>';
  }

  // ===== ヘッダー =====
  html += '<div style="text-align:center; margin-bottom:10px; padding-bottom:8px; border-bottom:3px solid #6366f1;">';
  html += '<div style="font-size:22px; font-weight:800; color:#0f172a;">AI士業商圏レポート</div>';
  html += '<div style="font-size:16px; color:#6366f1; font-weight:700; margin-top:4px;">' + escapeHtml(area.fullLabel) + ' × ' + escapeHtml(shigyoType.name) + '</div>';
  html += '<div style="font-size:9px; color:#64748b; margin-top:4px;">分析日: ' + dateStr + ' | データソース: 政府統計(e-Stat) + AI分析(Gemini)</div>';
  html += '</div>';

  // ===== 1. 人口・世帯 =====
  if (m.population) {
    var pop = m.population;
    html += '<div style="' + S + '"><div style="' + T + '">1. エリア人口・世帯データ</div>';
    html += '<table style="' + TBL + '">';
    html += r('総人口', formatNumber(pop.total_population));
    html += r('世帯数', formatNumber(pop.households));
    html += r('人口密度', (pop.population_density ? formatNumber(pop.population_density) + '人/km²' : '—'));
    html += r('人口増減率', pop.growth_rate || '—');
    if (pop.source) html += r('データソース', pop.source);
    html += '</table></div>';
  }

  // ===== AI士業商圏分析 =====
  if (m.shigyo_summary) {
    html += '<div style="' + S + '"><div style="' + T + '">2. AI士業商圏分析</div>';
    html += '<div style="font-size:11px; color:#1e293b; white-space:pre-wrap; line-height:1.7; padding:4px 2px;">' + escapeHtml(m.shigyo_summary) + '</div>';
    html += '</div>';
  }

  // ===== 競合状況 =====
  if (m.competitor_analysis) {
    var ca = m.competitor_analysis;
    html += '<div style="' + S + '"><div style="' + T + '">3. 同業事務所数・競合状況</div>';
    html += '<table style="' + TBL + '">';
    html += r('推計事務所数', formatNumber(ca.estimated_offices) + ' 件');
    html += r('1万人あたり事務所数', (ca.offices_per_10000_population || '—'));
    html += r('全国平均（1万人あたり）', (ca.national_avg_per_10000 || '—'));
    html += r('都道府県平均（1万人あたり）', (ca.prefecture_avg_per_10000 || '—'));
    html += r('競合レベル', ca.competition_level || '—');
    html += r('推計従事者数', formatNumber(ca.total_professionals) + ' 人');
    html += r('事務所あたり平均年商', (ca.avg_revenue_per_office ? formatNumber(ca.avg_revenue_per_office) + ' 万円' : '—'));
    html += r('市場規模推計', (ca.market_size_estimate ? formatNumber(ca.market_size_estimate) + ' 万円' : '—'));
    if (ca.nearby_major_firms && ca.nearby_major_firms.length > 0) {
      html += r('近隣主要事務所', ca.nearby_major_firms.join(', '));
    }
    if (ca.differentiation_opportunities && ca.differentiation_opportunities.length > 0) {
      html += r('差別化の機会', ca.differentiation_opportunities.join(' / '));
    }
    html += '</table></div>';
  }

  // ===== 顧客層分析 =====
  if (m.client_demographics) {
    var cd = m.client_demographics;
    html += '<div style="' + S + '"><div style="' + T + '">4. 顧客層分析</div>';
    html += '<table style="' + TBL + '">';
    if (cd.individual_clients) {
      var ic = cd.individual_clients;
      html += r('個人顧客割合', (ic.pct || '—') + '%');
      html += r('個人顧客 推計件数', formatNumber(ic.count) + ' 件/年');
      html += r('個人顧客 平均報酬', (ic.avg_fee ? formatNumber(ic.avg_fee) + ' 円' : '—'));
      if (ic.description) html += r('個人顧客 特性', ic.description);
    }
    if (cd.corporate_clients) {
      var cc = cd.corporate_clients;
      html += r('法人顧客割合', (cc.pct || '—') + '%');
      html += r('法人顧客 推計件数', formatNumber(cc.count) + ' 件/年');
      html += r('法人顧客 平均報酬', (cc.avg_fee ? formatNumber(cc.avg_fee) + ' 円' : '—'));
      if (cc.description) html += r('法人顧客 特性', cc.description);
    }
    if (cd.primary_needs && cd.primary_needs.length > 0) {
      html += r('主要ニーズ', cd.primary_needs.join(' / '));
    }
    if (cd.growth_sectors && cd.growth_sectors.length > 0) {
      html += r('成長分野', cd.growth_sectors.join(' / '));
    }
    if (cd.seasonal_demand) html += r('繁忙期・季節需要', cd.seasonal_demand);
    html += '</table></div>';
  }

  // ===== 開業適性スコア =====
  if (m.suitability_score) {
    var ss = m.suitability_score;
    html += '<div style="' + S + '"><div style="' + T + '">5. 開業適性スコア</div>';
    html += '<table style="' + TBL + '">';
    html += r('総合スコア（/100）', ss.overall_score || '—');
    html += r('グレード', ss.grade || '—');
    html += r('人口・需要規模スコア', ss.population_score || '—');
    html += r('競合環境スコア', ss.competition_score || '—');
    html += r('需要・ニーズスコア', ss.demand_score || '—');
    html += r('アクセス・立地スコア', ss.accessibility_score || '—');
    html += r('市場成長性スコア', ss.growth_score || '—');
    if (ss.ai_recommendation) html += r('AI総合判定', ss.ai_recommendation);
    html += '</table></div>';
  }

  // ===== 集客チャネル =====
  if (m.marketing_channels) {
    var mc = m.marketing_channels;
    html += '<div style="' + S + '"><div style="' + T + '">6. 集客チャネル推奨</div>';
    if (mc.channels && mc.channels.length > 0) {
      html += '<table style="' + TBL + '">';
      html += '<tr><th style="' + TH + 'width:26%;">チャネル</th><th style="' + TH + 'width:12%;">スコア</th><th style="' + TH + 'width:62%;">推奨理由</th></tr>';
      mc.channels.forEach(function(ch) {
        html += '<tr><td style="' + TD + '">' + escapeHtml(ch.name || '') + '</td>';
        html += '<td style="' + TD + 'text-align:center; font-weight:700;">' + (ch.score || '') + '</td>';
        html += '<td style="' + TD + 'font-size:10px;">' + escapeHtml(ch.reason || '') + '</td></tr>';
      });
      html += '</table>';
    }
    if (mc.best_channel) {
      html += '<div style="margin-top:5px; padding:5px 8px; background:#eef2ff; border:1px solid #a5b4fc; border-radius:3px; font-size:11px; color:#3730a3;">最推奨チャネル: ' + escapeHtml(mc.best_channel) + '</div>';
    }
    if (mc.strategy_summary) {
      html += '<div style="margin-top:5px; padding:5px 8px; background:#f0fdf4; border:1px solid #86efac; border-radius:3px; font-size:10px; color:#166534;">' + escapeHtml(mc.strategy_summary) + '</div>';
    }
    html += '</div>';
  }

  // ===== フッター =====
  html += '<div style="text-align:center; margin-top:10px; padding-top:6px; border-top:1px solid #e2e8f0;">';
  html += '<div style="font-size:9px; color:#94a3b8;">AI士業商圏レポート v1.0 | Powered by AI + 政府統計データ | ' + dateStr + '</div>';
  html += '</div>';
  html += '</div>'; // ルートdiv閉じ

  // 新しいウィンドウで印刷
  var printWin = window.open('', '_blank', 'width=800,height=1000');
  if (!printWin) { alert('ポップアップがブロックされました。ポップアップを許可してください。'); return; }

  printWin.document.write('<!DOCTYPE html><html><head><meta charset="utf-8">');
  printWin.document.write('<title>士業商圏分析_' + escapeHtml(area.fullLabel) + '_' + escapeHtml(shigyoType.name) + '</title>');
  printWin.document.write('<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;600;700;800&display=swap" rel="stylesheet">');
  printWin.document.write('<style>');
  printWin.document.write('*{margin:0;padding:0;box-sizing:border-box;}');
  printWin.document.write('body{background:#fff;color:#000;font-family:"Noto Sans JP",sans-serif;font-size:12px;line-height:1.6;padding:20px 30px;}');
  printWin.document.write('@media print{body{padding:0;}@page{margin:12mm 15mm;}}');
  printWin.document.write('</style></head><body>');
  printWin.document.write(html);
  printWin.document.write('</body></html>');
  printWin.document.close();

  // フォント読み込み後に印刷ダイアログを表示
  printWin.onload = function() {
    setTimeout(function() { printWin.print(); }, 800);
  };
}

// ---- Excel Export ----
function handleExcelDownload() {
  if (!isPurchased) {
    alert('Excelダウンロードは有料レポート購入後に利用できます。');
    return;
  }
  exportExcel();
}

function exportExcel() {
  if (!analysisData || !analysisData.shigyo) { alert('分析データがありません'); return; }

  var m = analysisData.shigyo;
  var area = analysisData.area;
  var shigyoType = analysisData.shigyoType || { name: '士業事務所' };
  var wb = XLSX.utils.book_new();

  var merges = [];
  var rowHeights = [];
  var rows = [];

  function pushRow(cells) {
    rows.push(cells);
  }

  // ===== タイトル行 =====
  pushRow(['AI士業商圏レポート', '', '', '']);
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } });

  pushRow(['エリア', area.fullLabel, '', '']);
  pushRow(['士業種別', shigyoType.name, '', '']);
  pushRow(['分析日', new Date().toLocaleDateString('ja-JP'), '', '']);
  pushRow(['データソース', '政府統計(e-Stat) + AI分析(Gemini)', '', '']);

  function pushSectionHeader(title) {
    pushRow(['', '', '', '']); // 区切り空行
    var idx = rows.length;
    pushRow([title, '', '', '']);
    merges.push({ s: { r: idx, c: 0 }, e: { r: idx, c: 3 } });
  }

  function pushDataRow(label, val, unit) {
    var displayVal = (val === null || val === undefined || val === '') ? '—' : String(val);
    if (unit) displayVal = displayVal + unit;
    pushRow([label, displayVal, '', '']);
  }

  // ===== ① 人口・世帯データ =====
  pushSectionHeader('① 人口・世帯データ');
  var pop = m.population || {};
  pushDataRow('総人口', pop.total_population ? formatNumber(pop.total_population) : '', '');
  pushDataRow('世帯数', pop.households ? formatNumber(pop.households) : '', '');
  pushDataRow('人口密度', pop.population_density ? formatNumber(pop.population_density) : '', '人/km²');
  pushDataRow('人口増減率', pop.growth_rate, '');
  if (pop.source) pushDataRow('データソース', pop.source, '');

  // ===== ② 競合状況 =====
  pushSectionHeader('② 同業事務所数・競合状況');
  var ca = m.competitor_analysis || {};
  pushDataRow('推計事務所数', ca.estimated_offices ? formatNumber(ca.estimated_offices) : '', '件');
  pushDataRow('1万人あたり事務所数', ca.offices_per_10000_population, '');
  pushDataRow('全国平均（1万人あたり）', ca.national_avg_per_10000, '');
  pushDataRow('都道府県平均（1万人あたり）', ca.prefecture_avg_per_10000, '');
  pushDataRow('競合レベル', ca.competition_level, '');
  pushDataRow('推計従事者数', ca.total_professionals ? formatNumber(ca.total_professionals) : '', '人');
  pushDataRow('事務所あたり平均年商', ca.avg_revenue_per_office ? formatNumber(ca.avg_revenue_per_office) : '', '万円');
  pushDataRow('市場規模推計', ca.market_size_estimate ? formatNumber(ca.market_size_estimate) : '', '万円');
  if (ca.nearby_major_firms && ca.nearby_major_firms.length > 0) {
    pushDataRow('近隣主要事務所', ca.nearby_major_firms.join(', '), '');
  }
  if (ca.differentiation_opportunities && ca.differentiation_opportunities.length > 0) {
    pushDataRow('差別化の機会', ca.differentiation_opportunities.join(' / '), '');
  }

  // ===== ③ 顧客層分析 =====
  pushSectionHeader('③ 顧客層分析');
  var cd = m.client_demographics || {};
  if (cd.individual_clients) {
    var ic = cd.individual_clients;
    pushDataRow('個人顧客割合', ic.pct || '', '%');
    pushDataRow('個人顧客 推計件数', ic.count ? formatNumber(ic.count) : '', '件/年');
    pushDataRow('個人顧客 平均報酬', ic.avg_fee ? formatNumber(ic.avg_fee) : '', '円');
    if (ic.description) pushDataRow('個人顧客 特性', ic.description, '');
  }
  if (cd.corporate_clients) {
    var cc = cd.corporate_clients;
    pushDataRow('法人顧客割合', cc.pct || '', '%');
    pushDataRow('法人顧客 推計件数', cc.count ? formatNumber(cc.count) : '', '件/年');
    pushDataRow('法人顧客 平均報酬', cc.avg_fee ? formatNumber(cc.avg_fee) : '', '円');
    if (cc.description) pushDataRow('法人顧客 特性', cc.description, '');
  }
  if (cd.primary_needs && cd.primary_needs.length > 0) {
    pushDataRow('主要ニーズ', cd.primary_needs.join(' / '), '');
  }
  if (cd.growth_sectors && cd.growth_sectors.length > 0) {
    pushDataRow('成長分野', cd.growth_sectors.join(' / '), '');
  }
  if (cd.seasonal_demand) pushDataRow('繁忙期・季節需要', cd.seasonal_demand, '');

  // ===== ④ 開業適性スコア =====
  pushSectionHeader('④ 開業適性スコア');
  var ss = m.suitability_score || {};
  pushDataRow('総合スコア（/100）', ss.overall_score, '');
  pushDataRow('グレード', ss.grade, '');
  pushDataRow('人口・需要規模スコア', ss.population_score, '');
  pushDataRow('競合環境スコア', ss.competition_score, '');
  pushDataRow('需要・ニーズスコア', ss.demand_score, '');
  pushDataRow('アクセス・立地スコア', ss.accessibility_score, '');
  pushDataRow('市場成長性スコア', ss.growth_score, '');
  if (ss.ai_recommendation) pushDataRow('AI総合判定', ss.ai_recommendation, '');

  // ===== ⑤ 集客チャネル =====
  pushSectionHeader('⑤ 集客チャネル推奨');
  var mc = m.marketing_channels || {};
  var channels = mc.channels || [];
  if (channels.length > 0) {
    pushRow(['', '', '', '']); // 区切り空行
    var chHeaderIdx = rows.length;
    pushRow(['推奨集客チャネル', '', '', '']);
    merges.push({ s: { r: chHeaderIdx, c: 0 }, e: { r: chHeaderIdx, c: 3 } });
    pushRow(['チャネル名', 'スコア', '施策詳細', '推奨理由']);
    channels.forEach(function(ch) {
      pushRow([
        ch.name || '',
        ch.score || '',
        ch.detail || '',
        ch.reason || ''
      ]);
    });
  }
  pushDataRow('最も推奨チャネル', mc.best_channel, '');
  pushDataRow('集客戦略サマリー', mc.strategy_summary, '');

  // ===== ⑥ AI士業商圏分析サマリー =====
  pushSectionHeader('⑥ AI士業商圏分析サマリー');
  var summaryText = m.shigyo_summary || '';
  var formattedSummary = summaryText.replace(/\r\n|\r|\n/g, '\r\n');
  var summaryRowIdx = rows.length;
  pushRow([formattedSummary, '', '', '']);
  merges.push({ s: { r: summaryRowIdx, c: 0 }, e: { r: summaryRowIdx, c: 3 } });
  rowHeights.push({ idx: summaryRowIdx, hpx: 200 });

  // ===== シート生成 =====
  var ws = XLSX.utils.aoa_to_sheet(rows);

  ws['!cols'] = [{ wch: 28 }, { wch: 50 }, { wch: 30 }, { wch: 40 }];
  ws['!merges'] = merges;

  // 行高さの適用
  var wsRows = [];
  rowHeights.forEach(function(rh) { wsRows[rh.idx] = { hpx: rh.hpx }; });
  ws['!rows'] = wsRows;

  // xlsx-js-style: セルスタイルを適用
  var thinBorder = { style: 'thin', color: { rgb: 'CCCCCC' } };
  var borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
  var wrapAlign = { wrapText: true, vertical: 'top' };

  // 全セルにwrapText + 罫線を適用
  var range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (var R = range.s.r; R <= range.e.r; R++) {
    for (var C = range.s.c; C <= range.e.c; C++) {
      var addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[addr]) ws[addr] = { v: '', t: 's' };
      ws[addr].s = { alignment: wrapAlign, border: borders, font: { name: 'Yu Gothic', sz: 10 } };
    }
  }

  // タイトル行(row 0)を太字・大きく
  var titleAddr = XLSX.utils.encode_cell({ r: 0, c: 0 });
  if (ws[titleAddr]) {
    ws[titleAddr].s = { alignment: { horizontal: 'center', vertical: 'center' }, font: { name: 'Yu Gothic', sz: 14, bold: true }, border: borders };
  }

  // セクションヘッダー行を太字・背景色付き（インディゴ系）
  merges.forEach(function(mg) {
    var hdrAddr = XLSX.utils.encode_cell({ r: mg.s.r, c: 0 });
    if (ws[hdrAddr] && ws[hdrAddr].v && typeof ws[hdrAddr].v === 'string') {
      var val = ws[hdrAddr].v;
      if (val.match(/^[①-⑥]/) || val.match(/^\[/) || val.match(/^推奨/) || val === 'AI士業商圏レポート') {
        ws[hdrAddr].s = {
          alignment: wrapAlign,
          font: { name: 'Yu Gothic', sz: 11, bold: true, color: { rgb: '3730A3' } },
          fill: { fgColor: { rgb: 'EEF2FF' } },
          border: borders
        };
      }
    }
  });

  // AI士業商圏分析サマリー行の特別スタイル
  var summaryAddr = XLSX.utils.encode_cell({ r: summaryRowIdx, c: 0 });
  if (ws[summaryAddr]) {
    ws[summaryAddr].s = { alignment: wrapAlign, font: { name: 'Yu Gothic', sz: 10 }, border: borders };
  }

  XLSX.utils.book_append_sheet(wb, ws, '士業商圏分析レポート');

  var fileName = '士業商圏分析_' + area.fullLabel + '_' + shigyoType.name + '_' + new Date().toISOString().slice(0, 10) + '.xlsx';
  XLSX.writeFile(wb, fileName);
}

function cancelPurchasePrompt() {
  document.getElementById('purchase-prompt').style.display = 'none';
  // 閉じた後も再決済できるフローティングボタンを表示
  var floatBtn = document.getElementById('purchase-float-btn');
  if (!floatBtn) {
    floatBtn = document.createElement('button');
    floatBtn.id = 'purchase-float-btn';
    floatBtn.className = 'purchase-float-btn';
    floatBtn.textContent = '🔓 完全版を購入 ¥300';
    floatBtn.onclick = function() {
      floatBtn.style.display = 'none';
      document.getElementById('purchase-prompt').style.display = 'flex';
    };
    document.body.appendChild(floatBtn);
  }
  floatBtn.style.display = 'block';
}

function hidePurchaseFloat() {
  var floatBtn = document.getElementById('purchase-float-btn');
  if (floatBtn) floatBtn.style.display = 'none';
}

// ---- UI Helpers ----
function resetAll() {
  analysisData = null;
  currentArea = null;
  currentShigyoType = null;
  isPurchased = false;
  _analysisRunning = false;
  areaInput.value = '';
  var sel = document.getElementById('shigyo-type-select');
  if (sel) sel.value = '';
  hideResults();
  hideProgress();
  hideError();
  document.getElementById('purchase-prompt').style.display = 'none';
  hidePurchaseFloat();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setLoading(isLoading) {
  analyzeBtn.classList.toggle('is-loading', isLoading);
  analyzeBtn.disabled = isLoading;
  // 分析中は入力フィールドもロック
  areaInput.disabled = isLoading;
  areaInput.style.opacity = isLoading ? '0.5' : '';
  areaInput.style.cursor = isLoading ? 'not-allowed' : '';
  var sel = document.getElementById('shigyo-type-select');
  if (sel) {
    sel.disabled = isLoading;
    sel.style.opacity = isLoading ? '0.5' : '';
  }
}

function showProgress() { progressSection.classList.add('is-active'); }
function hideProgress() { progressSection.classList.remove('is-active'); }

function activateStep(id) {
  var el = document.getElementById(id);
  if (el) el.classList.add('is-active');
}

function completeStep(id) {
  var el = document.getElementById(id);
  if (el) { el.classList.remove('is-active'); el.classList.add('is-done'); }
}

function showResults() { resultsSection.classList.add('is-active'); }
function hideResults() { resultsSection.classList.remove('is-active'); }

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add('is-active');
}

function hideError() { errorMsg.classList.remove('is-active'); }

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlightMatch(text, query) {
  var escaped = escapeHtml(text);
  var escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp('(' + escapedQuery + ')', 'gi'), '<mark>$1</mark>');
}

function formatNumber(num) {
  if (num === null || num === undefined || num === '') return '—';
  var n = Number(num);
  if (isNaN(n)) return '—';
  return n.toLocaleString('ja-JP');
}

// ---- area-database.js の searchArea 関数（AREA_DATABASEを検索）----
function searchArea(input) {
  if (!input || typeof AREA_DATABASE === 'undefined') return [];
  var query = input.trim();
  var results = [];

  // 完全一致
  for (var i = 0; i < AREA_DATABASE.length; i++) {
    var a = AREA_DATABASE[i];
    if (a.fullLabel === query || a.name === query) {
      results.push(a);
    }
  }
  if (results.length > 0) return results;

  // 部分一致
  for (var j = 0; j < AREA_DATABASE.length; j++) {
    var b = AREA_DATABASE[j];
    if (b.fullLabel.indexOf(query) >= 0 || b.name.indexOf(query) >= 0) {
      results.push(b);
    }
  }

  return results;
}
