// ========================================
// AI士業商圏分析レポート v1.1
// エリア入力 + 士業種別選択 → 政府統計 + AI分析 → プレビュー/課金
// ========================================

// ---- Config ----
var WORKER_BASE = 'https://house-search-proxy.ai-fudosan.workers.dev';
var SUPABASE_URL = 'https://ypyrjsdotkeyvzequdez.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_l5yNWlXOZAHABwlbEalGng_R8zioydf';
var supabaseClient = null;
var currentUser = null;

// ---- 士業 Types (参照用・履歴表示用に残す) ----
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

  // 購入チェック・DB読み込みを全体try-catchで囲む
  var purchaseKey = area.fullLabel;
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

  addLog('⚖️ 全士業商圏分析を開始します...', 'info');
  addLog('対象エリア: ' + area.fullLabel, 'info');
  addLog('分析対象: 税理士・弁護士・社労士・行政書士・司法書士・公認会計士 の6士業', 'info');

  try {
    // Step 1: 統計データ取得
    activateStep('step-data');

    addLog('  政府統計APIから人口データを取得中...', 'info');
    var estatPop = await fetchEstatPopulation(area.prefecture, area.city);

    completeStep('step-data');

    // Step 2: AI士業商圏分析（全6士業一括）
    activateStep('step-ai');
    addLog('AIが全6士業の商圏データを分析中...', 'info');

    var shigyoPrompt = buildShigyoPrompt(area, estatPop);
    var shigyoRaw = await callGemini(shigyoPrompt);
    var marketData = parseJSON(shigyoRaw);

    // e-Stat実データで上書き
    if (estatPop && estatPop.from_estat) {
      if (!marketData.population) marketData.population = {};
      marketData.population.total_population = estatPop.total_population;
      marketData.population.households = estatPop.households;
      marketData.population.source = estatPop.source;
    }

    addLog('→ ' + area.fullLabel + ' 全士業分析完了', 'success');
    completeStep('step-ai');

    // Step 3: レポート生成
    activateStep('step-report');
    addLog('レポート生成中...', 'info');

    analysisData = {
      area: area,
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

// ---- Build Shigyo Prompt (全6士業一括比較版) ----
function buildShigyoPrompt(area, estatPop) {
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
    '以下の地域における6種類の士業（税理士・弁護士・社会保険労務士・行政書士・司法書士・公認会計士）について、一括で商圏比較分析を提供してください。\n\n' +
    '対象エリア: ' + pref + ' ' + city + '\n' +
    estatInfo + '\n' +
    '各士業について以下を推定してください:\n' +
    '・推計事務所数、人口1万人あたりの事務所密度\n' +
    '・競合レベル（低/中/高/飽和）\n' +
    '・推定市場規模（万円）\n' +
    '・主要ターゲット顧客層\n' +
    '・開業適性スコア（100点満点）\n' +
    '・推奨集客チャネル\n' +
    '・1事務所あたり平均年商（万円）\n' +
    '・開業費用目安（万円）\n' +
    '・損益分岐点（月）\n' +
    '・個人案件平均単価（万円）\n' +
    '・法人顧問月額（万円）\n' +
    '・全国平均の事務所密度（件/万人）\n' +
    '・成長ポテンシャル（低/中/高）\n' +
    '・ターゲット個人像\n' +
    '・ターゲット法人像\n' +
    '・参入障壁（低/中/高）\n\n' +
    '重要ルール:\n' +
    '・各数値は可能な限り正確に。不明な場合は合理的な推計値を提供\n' +
    '・overall_summary は1500文字以上で記述。以下を含めること:\n' +
    '  - エリアの経済特性（産業構造、主要企業、商業集積度）\n' +
    '  - 住民の所得水準（推定世帯年収の中央値・平均値、全国比較）\n' +
    '  - 個人の生活水準（住宅価格帯、消費傾向、教育・医療支出）\n' +
    '  - 法人の特徴（事業所数、従業員規模の分布、業種構成）\n' +
    '  - 士業需要に影響する地域特性（高齢化率、世帯構成、相続発生率など）\n' +
    '  - 全国平均や近隣エリアとの比較数値\n' +
    '・各士業のsummaryは500文字以上で以下を含めること:\n' +
    '  - 当該エリアでの開業メリット・デメリット\n' +
    '  - 具体的なターゲット顧客層（個人: 年収帯・年齢層・ライフステージ、法人: 業種・規模）\n' +
    '  - 想定される顧客単価（個人案件の平均単価○万円、法人顧問料の月額○万円等）\n' +
    '  - 開業初期費用の目安（事務所賃料、設備、広告費等の合計○万円）\n' +
    '  - 損益分岐点の目安（開業後○ヶ月で黒字化見込み）\n' +
    '  - 全国平均との事務所密度比較（全国平均○件/万人 vs 当エリア○件/万人）\n' +
    '・recommended_top6 は開業に最も適した士業を上位6つ全て順位付けして理由付きで記述\n' +
    '・estimated_offices, market_size_estimate, avg_revenue_per_office は数値のみ（万円単位）\n' +
    '・offices_per_10000 は小数点1桁の数値\n' +
    '・suitability_score は0〜100の整数\n' +
    '・individual_client_pct + corporate_client_pct の合計は100になるようにしてください\n\n' +
    '以下のJSON形式で回答してください。マークダウンのコードブロックで囲まず、純粋なJSONのみ返してください:\n' +
    JSON.stringify({
      area_name: pref + ' ' + city,
      overall_summary: '（1500文字以上: 当該エリアの士業全体の商圏特性・経済特性・住民所得水準・法人特徴・士業需要に影響する地域特性・全国比較）',
      population: {
        total_population: 0,
        households: 0,
        population_density: 0,
        growth_rate: '+0.0%',
        source: 'データソース名'
      },
      professions: [
        {
          name: '税理士事務所',
          icon: '📊',
          estimated_offices: 0,
          offices_per_10000: 0,
          competition_level: '低/中/高/飽和',
          market_size_estimate: 0,
          avg_revenue_per_office: 0,
          startup_cost_estimate: 0,
          break_even_months: 0,
          avg_client_unit_price_individual: 0,
          avg_client_unit_price_corporate: 0,
          national_avg_offices_per_10000: 0,
          growth_potential: '低/中/高',
          target_individual_profile: 'ターゲット個人像',
          target_corporate_profile: 'ターゲット法人像',
          entry_barrier: '低/中/高',
          individual_client_pct: 0,
          corporate_client_pct: 0,
          primary_needs: ['ニーズ1', 'ニーズ2'],
          seasonal_demand: '繁忙期の説明',
          suitability_score: 0,
          summary: '（500文字以上の分析）',
          best_channel: '最も推奨する集客チャネル',
          channels: [
            { name: 'チャネル名', score: 0, detail: '具体策' }
          ]
        },
        {
          name: '弁護士事務所',
          icon: '⚖️',
          estimated_offices: 0,
          offices_per_10000: 0,
          competition_level: '低/中/高/飽和',
          market_size_estimate: 0,
          avg_revenue_per_office: 0,
          startup_cost_estimate: 0,
          break_even_months: 0,
          avg_client_unit_price_individual: 0,
          avg_client_unit_price_corporate: 0,
          national_avg_offices_per_10000: 0,
          growth_potential: '低/中/高',
          target_individual_profile: 'ターゲット個人像',
          target_corporate_profile: 'ターゲット法人像',
          entry_barrier: '低/中/高',
          individual_client_pct: 0,
          corporate_client_pct: 0,
          primary_needs: ['ニーズ1', 'ニーズ2'],
          seasonal_demand: '繁忙期の説明',
          suitability_score: 0,
          summary: '（500文字以上の分析）',
          best_channel: '最も推奨する集客チャネル',
          channels: [
            { name: 'チャネル名', score: 0, detail: '具体策' }
          ]
        },
        {
          name: '社会保険労務士事務所',
          icon: '🏢',
          estimated_offices: 0,
          offices_per_10000: 0,
          competition_level: '低/中/高/飽和',
          market_size_estimate: 0,
          avg_revenue_per_office: 0,
          startup_cost_estimate: 0,
          break_even_months: 0,
          avg_client_unit_price_individual: 0,
          avg_client_unit_price_corporate: 0,
          national_avg_offices_per_10000: 0,
          growth_potential: '低/中/高',
          target_individual_profile: 'ターゲット個人像',
          target_corporate_profile: 'ターゲット法人像',
          entry_barrier: '低/中/高',
          individual_client_pct: 0,
          corporate_client_pct: 0,
          primary_needs: ['ニーズ1', 'ニーズ2'],
          seasonal_demand: '繁忙期の説明',
          suitability_score: 0,
          summary: '（500文字以上の分析）',
          best_channel: '最も推奨する集客チャネル',
          channels: [
            { name: 'チャネル名', score: 0, detail: '具体策' }
          ]
        },
        {
          name: '行政書士事務所',
          icon: '📝',
          estimated_offices: 0,
          offices_per_10000: 0,
          competition_level: '低/中/高/飽和',
          market_size_estimate: 0,
          avg_revenue_per_office: 0,
          startup_cost_estimate: 0,
          break_even_months: 0,
          avg_client_unit_price_individual: 0,
          avg_client_unit_price_corporate: 0,
          national_avg_offices_per_10000: 0,
          growth_potential: '低/中/高',
          target_individual_profile: 'ターゲット個人像',
          target_corporate_profile: 'ターゲット法人像',
          entry_barrier: '低/中/高',
          individual_client_pct: 0,
          corporate_client_pct: 0,
          primary_needs: ['ニーズ1', 'ニーズ2'],
          seasonal_demand: '繁忙期の説明',
          suitability_score: 0,
          summary: '（500文字以上の分析）',
          best_channel: '最も推奨する集客チャネル',
          channels: [
            { name: 'チャネル名', score: 0, detail: '具体策' }
          ]
        },
        {
          name: '司法書士事務所',
          icon: '🏛️',
          estimated_offices: 0,
          offices_per_10000: 0,
          competition_level: '低/中/高/飽和',
          market_size_estimate: 0,
          avg_revenue_per_office: 0,
          startup_cost_estimate: 0,
          break_even_months: 0,
          avg_client_unit_price_individual: 0,
          avg_client_unit_price_corporate: 0,
          national_avg_offices_per_10000: 0,
          growth_potential: '低/中/高',
          target_individual_profile: 'ターゲット個人像',
          target_corporate_profile: 'ターゲット法人像',
          entry_barrier: '低/中/高',
          individual_client_pct: 0,
          corporate_client_pct: 0,
          primary_needs: ['ニーズ1', 'ニーズ2'],
          seasonal_demand: '繁忙期の説明',
          suitability_score: 0,
          summary: '（500文字以上の分析）',
          best_channel: '最も推奨する集客チャネル',
          channels: [
            { name: 'チャネル名', score: 0, detail: '具体策' }
          ]
        },
        {
          name: '公認会計士事務所',
          icon: '🔢',
          estimated_offices: 0,
          offices_per_10000: 0,
          competition_level: '低/中/高/飽和',
          market_size_estimate: 0,
          avg_revenue_per_office: 0,
          startup_cost_estimate: 0,
          break_even_months: 0,
          avg_client_unit_price_individual: 0,
          avg_client_unit_price_corporate: 0,
          national_avg_offices_per_10000: 0,
          growth_potential: '低/中/高',
          target_individual_profile: 'ターゲット個人像',
          target_corporate_profile: 'ターゲット法人像',
          entry_barrier: '低/中/高',
          individual_client_pct: 0,
          corporate_client_pct: 0,
          primary_needs: ['ニーズ1', 'ニーズ2'],
          seasonal_demand: '繁忙期の説明',
          suitability_score: 0,
          summary: '（500文字以上の分析）',
          best_channel: '最も推奨する集客チャネル',
          channels: [
            { name: 'チャネル名', score: 0, detail: '具体策' }
          ]
        }
      ],
      area_economic_profile: {
        estimated_avg_household_income: 0,
        national_income_comparison: '全国比較（例: 全国平均の1.2倍）',
        housing_price_range: '住宅価格帯（例: 3000-6000万円）',
        corporate_count: 0,
        corporate_per_1000_residents: 0,
        major_industries: '主要産業',
        aging_rate: '高齢化率',
        inheritance_demand_level: '低/中/高'
      },
      recommended_top6: [
        { rank: 1, name: '税理士事務所', score: 0, reason: '推奨理由（100文字程度）' },
        { rank: 2, name: '弁護士事務所', score: 0, reason: '推奨理由' },
        { rank: 3, name: '行政書士事務所', score: 0, reason: '推奨理由' },
        { rank: 4, name: '司法書士事務所', score: 0, reason: '推奨理由' },
        { rank: 5, name: '社会保険労務士事務所', score: 0, reason: '推奨理由' },
        { rank: 6, name: '公認会計士事務所', score: 0, reason: '推奨理由' }
      ]
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

// ---- Render Results (全6士業一括比較版) ----
function renderResults(data, purchased) {
  var m = data.shigyo;
  var area = data.area;
  var html = '';

  var sourceBadge = '<span style="background: linear-gradient(135deg, #6366f1, #8b5cf6); color:#fff; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">📊 実データ + AI分析</span>';

  // エリア情報カード
  html += '<div class="result-card result-card--company">' +
    '<div class="result-card__header">' +
    '<div class="result-card__icon">⚖️</div>' +
    '<div>' +
    '<div class="result-card__title">' + escapeHtml(area.fullLabel) + ' 士業商圏分析</div>' +
    '<div class="result-card__subtitle">全6士業 一括比較レポート ' + sourceBadge + '</div>' +
    '</div></div>' +
    '<div class="result-card__body">' +
    '<table class="data-table">' +
    '<tr><th>分析対象</th><td>' + escapeHtml(area.fullLabel) + '</td></tr>' +
    '<tr><th>対象士業</th><td>税理士・弁護士・社労士・行政書士・司法書士・公認会計士</td></tr>' +
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

  // ② エリア総評（有料）
  if (m.overall_summary) {
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🤖</div>' +
      '<div><div class="result-card__title">② エリア全体総評</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div class="market-summary">' + escapeHtml(m.overall_summary).replace(/\n/g, '<br>') + '</div>' +
      '</div></div>';
  }

  // ③ エリア経済プロフィール（有料）
  if (m.area_economic_profile) {
    var ep = m.area_economic_profile;
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">💰</div>' +
      '<div><div class="result-card__title">③ エリア経済プロフィール</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(ep.estimated_avg_household_income) + '<span style="font-size:11px;">万円</span></div><div class="stat-box__label">推定世帯年収中央値</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + escapeHtml(ep.national_income_comparison || '—') + '</div><div class="stat-box__label">全国比較</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(ep.corporate_count) + '</div><div class="stat-box__label">事業所数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + escapeHtml(ep.aging_rate || '—') + '</div><div class="stat-box__label">高齢化率</div></div>' +
      '</div>' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:12px; font-size:12px;">' +
      '<div style="padding:8px; background:rgba(15,23,42,0.3); border-radius:8px;"><strong>住宅価格帯:</strong> ' + escapeHtml(ep.housing_price_range || '—') + '</div>' +
      '<div style="padding:8px; background:rgba(15,23,42,0.3); border-radius:8px;"><strong>主要産業:</strong> ' + escapeHtml(ep.major_industries || '—') + '</div>' +
      '<div style="padding:8px; background:rgba(15,23,42,0.3); border-radius:8px;"><strong>相続需要:</strong> ' + escapeHtml(ep.inheritance_demand_level || '—') + '</div>' +
      '<div style="padding:8px; background:rgba(15,23,42,0.3); border-radius:8px;"><strong>事業所密度:</strong> ' + (ep.corporate_per_1000_residents || '—') + '件/千人</div>' +
      '</div>' +
      '</div></div>';
  }

  // ④ 開業適性ランキング TOP6（有料）
  var topRankData = m.recommended_top6 || m.recommended_top3;
  if (topRankData && topRankData.length > 0) {
    var rankMedals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣'];
    var rankColors = ['#f59e0b', '#94a3b8', '#cd7f32', '#6366f1', '#6366f1', '#6366f1'];
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🏆</div>' +
      '<div><div class="result-card__title">④ 開業適性ランキング TOP6</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay;

    topRankData.forEach(function(item, idx) {
      var rColor = rankColors[idx] || '#6366f1';
      var rMedal = rankMedals[idx] || (idx + 1) + '位';
      var rScore = item.score || 0;
      var isTop3 = (idx < 3);
      var cardPadding = isTop3 ? '14px' : '10px';
      html += '<div style="margin-bottom:12px; padding:' + cardPadding + '; border-radius:10px; background:rgba(15,23,42,0.5); border:1px solid rgba(99,102,241,0.2);">' +
        '<div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">' +
        '<span style="font-size:' + (isTop3 ? '24px' : '18px') + ';">' + rMedal + '</span>' +
        '<div style="flex:1;">' +
        '<div style="font-weight:700; font-size:' + (isTop3 ? '15px' : '13px') + '; color:var(--text-primary);">' + escapeHtml(item.name || '') + '</div>' +
        '<div style="font-size:11px; color:var(--text-muted);">開業適性スコア</div>' +
        '</div>' +
        '<div style="font-size:' + (isTop3 ? '28px' : '22px') + '; font-weight:900; color:' + rColor + ';">' + rScore + '<span style="font-size:12px; color:var(--text-muted);">点</span></div>' +
        '</div>' +
        '<div style="height:6px; background:rgba(255,255,255,0.1); border-radius:3px; overflow:hidden; margin-bottom:6px;">' +
        '<div style="height:100%; width:' + rScore + '%; background:linear-gradient(90deg,' + rColor + ',#6366f1); border-radius:3px;"></div>' +
        '</div>' +
        (item.reason ? '<div style="font-size:12px; color:var(--text-secondary);">💡 ' + escapeHtml(item.reason) + '</div>' : '') +
        '</div>';
    });
    html += '</div></div>';
  }

  // ⑤ 士業別詳細比較（有料）
  if (m.professions && m.professions.length > 0) {
    var compLevelColor = { '低': '#10b981', '中': '#f59e0b', '高': '#f97316', '飽和': '#ef4444' };

    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">📊</div>' +
      '<div><div class="result-card__title">⑤ 士業別詳細比較</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:16px;">';

    m.professions.forEach(function(prof) {
      var compColor = compLevelColor[prof.competition_level] || '#94a3b8';
      var indPct = prof.individual_client_pct || 0;
      var corpPct = prof.corporate_client_pct || 0;
      var score = prof.suitability_score || 0;

      html += '<div style="border:1px solid rgba(99,102,241,0.2); border-radius:12px; padding:16px; background:rgba(15,23,42,0.5);">';
      html += '<div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">';
      html += '<span style="font-size:22px;">' + (prof.icon || '⚖️') + '</span>';
      html += '<div style="font-weight:700; font-size:14px;">' + escapeHtml(prof.name || '') + '</div>';
      html += '</div>';
      html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:12px; margin-bottom:8px;">';
      html += '<div>事務所数: <strong>' + formatNumber(prof.estimated_offices) + '</strong></div>';
      html += '<div>競合: <span style="color:' + compColor + '; font-weight:700;">' + escapeHtml(prof.competition_level || '—') + '</span></div>';
      html += '<div>市場規模: <strong>' + formatMarketSize(prof.market_size_estimate) + '</strong></div>';
      html += '<div>適性: <strong style="color:#6366f1;">' + score + '点</strong></div>';
      if (prof.avg_revenue_per_office) {
        html += '<div>平均年商: <strong>' + formatMarketSize(prof.avg_revenue_per_office) + '</strong></div>';
      }
      if (prof.startup_cost_estimate) {
        html += '<div>開業費用: <strong>約' + formatNumber(prof.startup_cost_estimate) + '万円</strong></div>';
      }
      if (prof.break_even_months) {
        html += '<div>黒字化目安: <strong>約' + prof.break_even_months + 'ヶ月</strong></div>';
      }
      html += '</div>';
      // 顧客単価
      if (prof.avg_client_unit_price_individual || prof.avg_client_unit_price_corporate) {
        html += '<div style="font-size:11px; color:var(--text-secondary); margin-top:4px;">';
        if (prof.avg_client_unit_price_individual) html += '個人単価: 約' + formatNumber(prof.avg_client_unit_price_individual) + '万円 ';
        if (prof.avg_client_unit_price_corporate) html += '法人月額: 約' + formatNumber(prof.avg_client_unit_price_corporate) + '万円';
        html += '</div>';
      }
      // 全国平均密度比較
      if (prof.national_avg_offices_per_10000) {
        html += '<div style="font-size:11px; color:var(--text-muted); margin-top:4px;">📊 全国平均密度: ' + prof.national_avg_offices_per_10000 + '件/万人 vs 当エリア: ' + (prof.offices_per_10000 || '—') + '件/万人</div>';
      }
      // 適性スコアバー
      html += '<div style="margin-bottom:8px; margin-top:8px;">';
      html += '<div style="font-size:10px; color:var(--text-muted); margin-bottom:2px;">開業適性スコア</div>';
      html += '<div style="height:8px; background:rgba(255,255,255,0.1); border-radius:4px; overflow:hidden;">';
      html += '<div style="height:100%; width:' + score + '%; background:linear-gradient(90deg,#6366f1,#8b5cf6); border-radius:4px;"></div>';
      html += '</div></div>';
      // 顧客割合バー
      if (indPct > 0 || corpPct > 0) {
        html += '<div style="margin-bottom:8px;">';
        html += '<div style="font-size:10px; color:var(--text-muted); margin-bottom:2px;">顧客割合（個人/法人）</div>';
        html += '<div style="display:flex; height:14px; border-radius:4px; overflow:hidden; font-size:9px; font-weight:700;">';
        html += '<div style="width:' + indPct + '%; background:#6366f1; display:flex; align-items:center; justify-content:center; color:#fff;">' + (indPct >= 20 ? indPct + '%' : '') + '</div>';
        html += '<div style="width:' + corpPct + '%; background:#8b5cf6; display:flex; align-items:center; justify-content:center; color:#fff;">' + (corpPct >= 20 ? corpPct + '%' : '') + '</div>';
        html += '</div>';
        html += '<div style="display:flex; gap:8px; margin-top:2px; font-size:9px; color:var(--text-muted);"><span>個人 ' + indPct + '%</span><span>法人 ' + corpPct + '%</span></div>';
        html += '</div>';
      }
      // 推奨チャネル
      if (prof.best_channel) {
        html += '<div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">🏆 推奨: <span style="color:#6366f1; font-weight:600;">' + escapeHtml(prof.best_channel) + '</span></div>';
      }
      // サマリー
      if (prof.summary) {
        html += '<div style="font-size:11px; color:var(--text-secondary); line-height:1.5; border-top:1px solid rgba(99,102,241,0.1); padding-top:8px;">' + escapeHtml(prof.summary) + '</div>';
      }
      html += '</div>';
    });

    html += '</div></div></div>';
  }

  // ⑥ 開業適性スコア比較チャート（有料）
  if (m.professions && m.professions.length > 0) {
    var sortedProfs = m.professions.slice().sort(function(a, b) {
      return (b.suitability_score || 0) - (a.suitability_score || 0);
    });

    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🎯</div>' +
      '<div><div class="result-card__title">⑥ 開業適性スコア詳細比較</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay;

    sortedProfs.forEach(function(prof, idx) {
      var score = prof.suitability_score || 0;
      var isTop = (idx === 0);
      var barColor = isTop ? 'linear-gradient(90deg,#f59e0b,#f97316)' : 'linear-gradient(90deg,#6366f1,#8b5cf6)';
      html += '<div style="margin-bottom:10px;">';
      html += '<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">';
      html += '<span style="font-size:16px; width:24px; text-align:center;">' + (prof.icon || '⚖️') + '</span>';
      html += '<span style="font-size:13px; font-weight:' + (isTop ? '700' : '600') + '; flex:1; color:' + (isTop ? '#f59e0b' : 'var(--text-primary)') + ';">' + escapeHtml(prof.name || '') + '</span>';
      html += '<span style="font-size:16px; font-weight:800; color:' + (isTop ? '#f59e0b' : '#6366f1') + '; min-width:42px; text-align:right;">' + score + '<span style="font-size:10px; font-weight:400; color:var(--text-muted);">点</span></span>';
      html += '</div>';
      html += '<div style="height:10px; background:rgba(255,255,255,0.08); border-radius:5px; overflow:hidden;">';
      html += '<div style="height:100%; width:' + score + '%; background:' + barColor + '; border-radius:5px;"></div>';
      html += '</div>';
      // 主要ニーズタグ
      if (prof.primary_needs && prof.primary_needs.length > 0) {
        html += '<div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:4px;">';
        prof.primary_needs.slice(0, 3).forEach(function(need) {
          html += '<span style="font-size:10px; padding:1px 6px; border-radius:10px; background:rgba(99,102,241,0.1); color:#6366f1; border:1px solid rgba(99,102,241,0.2);">💡 ' + escapeHtml(need) + '</span>';
        });
        html += '</div>';
      }
      html += '</div>';
    });

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

    var purchaseKey = currentArea.fullLabel;

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
          var areaLabel = p.area_name;
          var btn = document.createElement('button');
          btn.className = 'area-select-btn';
          btn.innerHTML = '<span style="font-size:20px;">✅</span>' +
            '<div><div style="font-weight:700;">' + escapeHtml(areaLabel) + ' 全6士業比較</div>' +
            '<div style="font-size:11px; color:var(--text-muted);">購入日: ' + new Date(p.purchased_at).toLocaleDateString('ja-JP') + '</div></div>';
          btn.addEventListener('click', async function() {
            document.getElementById('history-modal').classList.remove('active');
            // DBから分析データを読み出し
            var dbData = await _loadAnalysisDataFromDB(p.area_name);
            if (dbData) {
              analysisData = dbData;
              currentArea = dbData.area;
              isPurchased = true;
              areaInput.value = dbData.area.fullLabel;
              document.getElementById('purchase-prompt').style.display = 'none';
              renderResults(analysisData, true);
              showResults();
            } else {
              // DBにデータがなければ再分析
              areaInput.value = areaLabel;
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
      var areaLabel = p.area;
      var btn = document.createElement('button');
      btn.className = 'area-select-btn';
      btn.innerHTML = '<span style="font-size:20px;">✅</span>' +
        '<div><div style="font-weight:700;">' + escapeHtml(areaLabel) + ' 全6士業比較</div>' +
        '<div style="font-size:11px; color:var(--text-muted);">購入日: ' + new Date(p.date).toLocaleDateString('ja-JP') + '</div></div>';
      btn.addEventListener('click', function() {
        document.getElementById('history-modal').classList.remove('active');
        areaInput.value = areaLabel;
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
  html += '<div style="font-size:16px; color:#6366f1; font-weight:700; margin-top:4px;">' + escapeHtml(area.fullLabel) + ' 全6士業 一括比較分析</div>';
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

  // ===== 2. エリア総評 =====
  if (m.overall_summary) {
    html += '<div style="' + S + '"><div style="' + T + '">2. エリア全体総評</div>';
    html += '<div style="font-size:11px; color:#1e293b; white-space:pre-wrap; line-height:1.7; padding:4px 2px;">' + escapeHtml(m.overall_summary) + '</div>';
    html += '</div>';
  }

  // ===== 3. エリア経済プロフィール =====
  if (m.area_economic_profile) {
    var ep = m.area_economic_profile;
    html += '<div style="' + S + '"><div style="' + T + '">3. エリア経済プロフィール</div>';
    html += '<table style="' + TBL + '">';
    html += r('推定世帯年収中央値', formatNumber(ep.estimated_avg_household_income) + '万円');
    html += r('全国比較', ep.national_income_comparison || '—');
    html += r('住宅価格帯', ep.housing_price_range || '—');
    html += r('事業所数', formatNumber(ep.corporate_count));
    html += r('事業所密度', (ep.corporate_per_1000_residents || '—') + '件/千人');
    html += r('主要産業', ep.major_industries || '—');
    html += r('高齢化率', ep.aging_rate || '—');
    html += r('相続関連需要レベル', ep.inheritance_demand_level || '—');
    html += '</table></div>';
  }

  // ===== 4. 開業適性ランキング TOP6 =====
  var pdfTopRank = m.recommended_top6 || m.recommended_top3;
  if (pdfTopRank && pdfTopRank.length > 0) {
    html += '<div style="' + S + '"><div style="' + T + '">4. 開業適性ランキング TOP6</div>';
    html += '<table style="' + TBL + '">';
    html += '<tr><th style="' + TH + 'width:8%;">順位</th><th style="' + TH + 'width:30%;">士業</th><th style="' + TH + 'width:12%;">スコア</th><th style="' + TH + 'width:50%;">推奨理由</th></tr>';
    pdfTopRank.forEach(function(item) {
      html += '<tr><td style="' + TD + 'text-align:center;">' + (item.rank || '') + '位</td>';
      html += '<td style="' + TD + 'font-weight:700;">' + escapeHtml(item.name || '') + '</td>';
      html += '<td style="' + TD + 'text-align:center; font-weight:700;">' + (item.score || '') + '点</td>';
      html += '<td style="' + TD + 'font-size:10px;">' + escapeHtml(item.reason || '') + '</td></tr>';
    });
    html += '</table></div>';
  }

  // ===== 5. 士業別詳細 =====
  if (m.professions && m.professions.length > 0) {
    html += '<div style="' + S + '"><div style="' + T + '">5. 士業別詳細比較</div>';
    html += '<table style="' + TBL + '">';
    html += '<tr>';
    html += '<th style="' + TH + 'width:20%;">士業</th>';
    html += '<th style="' + TH + 'width:12%;">事務所数</th>';
    html += '<th style="' + TH + 'width:10%;">競合</th>';
    html += '<th style="' + TH + 'width:15%;">市場規模</th>';
    html += '<th style="' + TH + 'width:10%;">適性スコア</th>';
    html += '<th style="' + TH + 'width:33%;">サマリー</th>';
    html += '</tr>';
    m.professions.forEach(function(prof) {
      html += '<tr>';
      html += '<td style="' + TD + 'font-weight:700;">' + (prof.icon || '') + ' ' + escapeHtml(prof.name || '') + '</td>';
      html += '<td style="' + TD + 'text-align:right;">' + formatNumber(prof.estimated_offices) + '</td>';
      html += '<td style="' + TD + 'text-align:center;">' + escapeHtml(prof.competition_level || '—') + '</td>';
      html += '<td style="' + TD + 'text-align:right;">' + formatMarketSize(prof.market_size_estimate) + '</td>';
      html += '<td style="' + TD + 'text-align:center; font-weight:700;">' + (prof.suitability_score || '—') + '</td>';
      html += '<td style="' + TD + 'font-size:10px;">' + escapeHtml(prof.summary || '') + '</td>';
      html += '</tr>';
    });
    html += '</table>';

    // 各士業の詳細（新フィールド含む）
    m.professions.forEach(function(prof) {
      html += '<div style="margin-top:8px; padding-top:6px; border-top:1px dashed #cbd5e1;">';
      html += '<div style="font-weight:700; font-size:12px; color:#1e293b; margin-bottom:4px;">' + (prof.icon || '') + ' ' + escapeHtml(prof.name || '') + ' 詳細</div>';
      html += '<table style="' + TBL + '">';
      if (prof.avg_revenue_per_office) html += r('1事務所あたり平均年商', formatMarketSize(prof.avg_revenue_per_office));
      if (prof.startup_cost_estimate) html += r('開業費用目安', formatNumber(prof.startup_cost_estimate) + '万円');
      if (prof.break_even_months) html += r('損益分岐点目安', '約' + prof.break_even_months + 'ヶ月');
      if (prof.avg_client_unit_price_individual) html += r('個人案件平均単価', '約' + formatNumber(prof.avg_client_unit_price_individual) + '万円');
      if (prof.avg_client_unit_price_corporate) html += r('法人顧問月額', '約' + formatNumber(prof.avg_client_unit_price_corporate) + '万円');
      if (prof.national_avg_offices_per_10000) html += r('全国平均事務所密度', prof.national_avg_offices_per_10000 + '件/万人 vs 当エリア: ' + (prof.offices_per_10000 || '—') + '件/万人');
      if (prof.growth_potential) html += r('成長ポテンシャル', prof.growth_potential);
      if (prof.entry_barrier) html += r('参入障壁', prof.entry_barrier);
      if (prof.target_individual_profile) html += r('ターゲット個人像', prof.target_individual_profile);
      if (prof.target_corporate_profile) html += r('ターゲット法人像', prof.target_corporate_profile);
      html += '</table></div>';
    });

    html += '</div>';
  }

  // ===== フッター =====
  html += '<div style="text-align:center; margin-top:10px; padding-top:6px; border-top:1px solid #e2e8f0;">';
  html += '<div style="font-size:9px; color:#94a3b8;">AI士業商圏レポート v1.1 | Powered by AI + 政府統計データ | ' + dateStr + '</div>';
  html += '</div>';
  html += '</div>'; // ルートdiv閉じ

  // 新しいウィンドウで印刷
  var printWin = window.open('', '_blank', 'width=800,height=1000');
  if (!printWin) { alert('ポップアップがブロックされました。ポップアップを許可してください。'); return; }

  printWin.document.write('<!DOCTYPE html><html><head><meta charset="utf-8">');
  printWin.document.write('<title>士業商圏分析_' + escapeHtml(area.fullLabel) + '_全6士業比較</title>');
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
  var wb = XLSX.utils.book_new();

  var merges = [];
  var rowHeights = [];
  var rows = [];

  function pushRow(cells) { rows.push(cells); }

  function pushSectionHeader(title) {
    pushRow(['', '', '', '', '', '']);
    var idx = rows.length;
    pushRow([title, '', '', '', '', '']);
    merges.push({ s: { r: idx, c: 0 }, e: { r: idx, c: 5 } });
  }

  function pushDataRow(label, val, unit) {
    var displayVal = (val === null || val === undefined || val === '') ? '—' : String(val);
    if (unit) displayVal = displayVal + unit;
    pushRow([label, displayVal, '', '', '', '']);
  }

  // ===== タイトル行 =====
  pushRow(['AI士業商圏レポート 全6士業 一括比較分析', '', '', '', '', '']);
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } });

  pushRow(['エリア', area.fullLabel, '', '', '', '']);
  pushRow(['分析対象士業', '税理士・弁護士・社労士・行政書士・司法書士・公認会計士', '', '', '', '']);
  pushRow(['分析日', new Date().toLocaleDateString('ja-JP'), '', '', '', '']);
  pushRow(['データソース', '政府統計(e-Stat) + AI分析(Gemini)', '', '', '', '']);

  // ===== ① 人口・世帯データ =====
  pushSectionHeader('① 人口・世帯データ');
  var pop = m.population || {};
  pushDataRow('総人口', pop.total_population ? formatNumber(pop.total_population) : '', '');
  pushDataRow('世帯数', pop.households ? formatNumber(pop.households) : '', '');
  pushDataRow('人口密度', pop.population_density ? formatNumber(pop.population_density) : '', '人/km²');
  pushDataRow('人口増減率', pop.growth_rate, '');
  if (pop.source) pushDataRow('データソース', pop.source, '');

  // ===== ② エリア総評 =====
  pushSectionHeader('② エリア全体総評');
  if (m.overall_summary) {
    var summaryText = m.overall_summary.replace(/\r\n|\r|\n/g, '\r\n');
    var summaryRowIdx = rows.length;
    pushRow([summaryText, '', '', '', '', '']);
    merges.push({ s: { r: summaryRowIdx, c: 0 }, e: { r: summaryRowIdx, c: 5 } });
    rowHeights.push({ idx: summaryRowIdx, hpx: 200 });
  }

  // ===== ③ エリア経済プロフィール =====
  pushSectionHeader('③ エリア経済プロフィール');
  if (m.area_economic_profile) {
    var xlsEp = m.area_economic_profile;
    pushDataRow('推定世帯年収中央値', xlsEp.estimated_avg_household_income ? formatNumber(xlsEp.estimated_avg_household_income) : '—', '万円');
    pushDataRow('全国比較', xlsEp.national_income_comparison || '—', '');
    pushDataRow('住宅価格帯', xlsEp.housing_price_range || '—', '');
    pushDataRow('事業所数', xlsEp.corporate_count ? formatNumber(xlsEp.corporate_count) : '—', '');
    pushDataRow('事業所密度', xlsEp.corporate_per_1000_residents || '—', '件/千人');
    pushDataRow('主要産業', xlsEp.major_industries || '—', '');
    pushDataRow('高齢化率', xlsEp.aging_rate || '—', '');
    pushDataRow('相続関連需要レベル', xlsEp.inheritance_demand_level || '—', '');
  }

  // ===== ④ 開業適性ランキング TOP6 =====
  var xlsTopRank = m.recommended_top6 || m.recommended_top3;
  pushSectionHeader('④ 開業適性ランキング TOP6');
  if (xlsTopRank && xlsTopRank.length > 0) {
    var rankHeaderIdx = rows.length;
    pushRow(['順位', '士業', 'スコア', '推奨理由', '', '']);
    merges.push({ s: { r: rankHeaderIdx, c: 3 }, e: { r: rankHeaderIdx, c: 5 } });
    xlsTopRank.forEach(function(item) {
      var reasonRow = rows.length;
      pushRow([(item.rank || '') + '位', item.name || '', (item.score || '') + '点', item.reason || '', '', '']);
      merges.push({ s: { r: reasonRow, c: 3 }, e: { r: reasonRow, c: 5 } });
    });
  }

  // ===== ⑤ 士業別詳細比較 =====
  pushSectionHeader('⑤ 士業別詳細比較');
  if (m.professions && m.professions.length > 0) {
    pushRow(['士業', '事務所数', '競合レベル', '市場規模', '開業適性スコア', '推奨集客チャネル']);
    m.professions.forEach(function(prof) {
      pushRow([
        (prof.icon || '') + ' ' + (prof.name || ''),
        prof.estimated_offices ? formatNumber(prof.estimated_offices) : '—',
        prof.competition_level || '—',
        prof.market_size_estimate ? formatMarketSize(prof.market_size_estimate) : '—',
        prof.suitability_score || '—',
        prof.best_channel || '—'
      ]);
    });

    // 各士業の詳細（新フィールド含む）
    m.professions.forEach(function(prof) {
      pushSectionHeader('   ' + (prof.icon || '') + ' ' + (prof.name || '') + ' 詳細');
      pushDataRow('推計事務所数', prof.estimated_offices ? formatNumber(prof.estimated_offices) : '—', '件');
      pushDataRow('1万人あたり事務所密度', prof.offices_per_10000 || '—', '');
      pushDataRow('競合レベル', prof.competition_level || '—', '');
      pushDataRow('推計市場規模', prof.market_size_estimate ? formatMarketSize(prof.market_size_estimate) : '—', '');
      pushDataRow('1事務所あたり平均年商', prof.avg_revenue_per_office ? formatMarketSize(prof.avg_revenue_per_office) : '—', '');
      pushDataRow('開業費用目安', prof.startup_cost_estimate ? formatNumber(prof.startup_cost_estimate) : '—', '万円');
      pushDataRow('損益分岐点目安', prof.break_even_months ? '約' + prof.break_even_months + 'ヶ月' : '—', '');
      pushDataRow('個人案件平均単価', prof.avg_client_unit_price_individual ? '約' + formatNumber(prof.avg_client_unit_price_individual) + '万円' : '—', '');
      pushDataRow('法人顧問月額', prof.avg_client_unit_price_corporate ? '約' + formatNumber(prof.avg_client_unit_price_corporate) + '万円' : '—', '');
      pushDataRow('全国平均事務所密度', prof.national_avg_offices_per_10000 ? prof.national_avg_offices_per_10000 + '件/万人 vs 当エリア: ' + (prof.offices_per_10000 || '—') + '件/万人' : '—', '');
      pushDataRow('成長ポテンシャル', prof.growth_potential || '—', '');
      pushDataRow('参入障壁', prof.entry_barrier || '—', '');
      pushDataRow('ターゲット個人像', prof.target_individual_profile || '—', '');
      pushDataRow('ターゲット法人像', prof.target_corporate_profile || '—', '');
      pushDataRow('開業適性スコア', prof.suitability_score || '—', '/100点');
      pushDataRow('個人顧客比率', prof.individual_client_pct || '—', '%');
      pushDataRow('法人顧客比率', prof.corporate_client_pct || '—', '%');
      pushDataRow('推奨集客チャネル', prof.best_channel || '—', '');
      if (prof.primary_needs && prof.primary_needs.length > 0) {
        pushDataRow('主要ニーズ', prof.primary_needs.join(' / '), '');
      }
      if (prof.seasonal_demand) pushDataRow('繁忙期・季節需要', prof.seasonal_demand, '');
      if (prof.summary) {
        var profSummaryIdx = rows.length;
        pushRow(['分析サマリー', prof.summary, '', '', '', '']);
        merges.push({ s: { r: profSummaryIdx, c: 1 }, e: { r: profSummaryIdx, c: 5 } });
        rowHeights.push({ idx: profSummaryIdx, hpx: 80 });
      }
    });
  }

  // ===== シート生成 =====
  var ws = XLSX.utils.aoa_to_sheet(rows);

  ws['!cols'] = [{ wch: 26 }, { wch: 20 }, { wch: 14 }, { wch: 20 }, { wch: 14 }, { wch: 36 }];
  ws['!merges'] = merges;

  var wsRows = [];
  rowHeights.forEach(function(rh) { wsRows[rh.idx] = { hpx: rh.hpx }; });
  ws['!rows'] = wsRows;

  var thinBorder = { style: 'thin', color: { rgb: 'CCCCCC' } };
  var borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
  var wrapAlign = { wrapText: true, vertical: 'top' };

  var range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (var R = range.s.r; R <= range.e.r; R++) {
    for (var C = range.s.c; C <= range.e.c; C++) {
      var addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[addr]) ws[addr] = { v: '', t: 's' };
      ws[addr].s = { alignment: wrapAlign, border: borders, font: { name: 'Yu Gothic', sz: 10 } };
    }
  }

  var titleAddr = XLSX.utils.encode_cell({ r: 0, c: 0 });
  if (ws[titleAddr]) {
    ws[titleAddr].s = { alignment: { horizontal: 'center', vertical: 'center' }, font: { name: 'Yu Gothic', sz: 13, bold: true }, border: borders };
  }

  merges.forEach(function(mg) {
    var hdrAddr = XLSX.utils.encode_cell({ r: mg.s.r, c: 0 });
    if (ws[hdrAddr] && ws[hdrAddr].v && typeof ws[hdrAddr].v === 'string') {
      var val = ws[hdrAddr].v;
      if (val.match(/^[①-⑥]/) || val.match(/^\s+[📊⚖️🏢📝🏛️🔢]/) || val === 'AI士業商圏レポート 全6士業 一括比較分析') {
        ws[hdrAddr].s = {
          alignment: wrapAlign,
          font: { name: 'Yu Gothic', sz: 11, bold: true, color: { rgb: '3730A3' } },
          fill: { fgColor: { rgb: 'EEF2FF' } },
          border: borders
        };
      }
    }
  });

  XLSX.utils.book_append_sheet(wb, ws, '全6士業比較レポート');

  var fileName = '士業商圏分析_' + area.fullLabel + '_全6士業比較_' + new Date().toISOString().slice(0, 10) + '.xlsx';
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
  isPurchased = false;
  _analysisRunning = false;
  areaInput.value = '';
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

function formatMarketSize(valueInManYen) {
  if (valueInManYen === null || valueInManYen === undefined) return '—';
  var n = Number(valueInManYen);
  if (isNaN(n)) return '—';
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '兆円';
  if (n >= 10000) return (n / 10000).toFixed(0) + '億円';
  if (n >= 1000) return (n / 10000).toFixed(1) + '億円';
  return n.toLocaleString('ja-JP') + '万円';
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
