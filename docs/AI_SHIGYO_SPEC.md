# AI士業商圏レポート - 内部仕様書

**サービスURL**: https://ai-shigyo.bantex.jp/
**GitHub**: makoban/ai_shigyo
**バージョン**: v1.2
**最終更新**: 2026-02-27

---

## 1. サービス概要

士業（税理士・弁護士・社労士・行政書士・司法書士・公認会計士）の**開業エリア分析レポート**をAIが自動生成するサービス。ユーザーがエリアを入力すると、政府統計データ（e-Stat）+ Gemini AI分析により、6士業の競合密度・顧客層・開業適性スコアを一括比較したレポートを出力する。

### ビジネスモデル

| 項目 | 内容 |
|------|------|
| 無料範囲 | エリアの人口・世帯データ（e-Stat実データ） |
| 有料範囲 | 全6士業の競合密度・顧客層・開業適性スコア・経済プロフィール・集客チャネル・Excel/PDF出力 |
| 価格 | ¥300 / 1エリア（税込・買い切り） |
| 決済 | Stripe Checkout |
| 姉妹サービス | ai-fudosan（不動産市場レポート）、ai-shoken（出店商圏レポート） |

---

## 2. 技術スタック

| レイヤー | 技術 |
|----------|------|
| Frontend | GitHub Pages（静的HTML/CSS/JS） |
| Backend API | Cloudflare Workers（`house-search-proxy.ai-fudosan.workers.dev`）※3サービス共有 |
| AI | Gemini 2.0 Flash（Worker経由 `/api/gemini`） |
| 統計データ | e-Stat 政府統計API（Worker経由 `/api/estat/population`） |
| 認証 | Supabase Auth（メール+PW / Google OAuth） |
| DB | Supabase PostgreSQL（購入履歴・分析データ保存） |
| 決済 | Stripe Checkout（Worker経由 `/api/checkout`） |
| カスタムドメイン | CNAME → `ai-shigyo.bantex.jp` |

---

## 3. ファイル構成

```
士業レポート/
├── index.html          # メインHTML（LP + モーダル群）
├── app.js              # 全ロジック（認証・分析・決済・描画・エクスポート）
├── style.css           # デザインシステム（ダークテーマ・紫アクセント）
├── area-database.js    # 全国1,892エリアの地名DB（オートコンプリート用）
├── CNAME               # ai-shigyo.bantex.jp
├── hero-woman.png      # ヒーロー画像
├── sample_report_full.png  # サンプルレポート画像
└── docs/
    └── AI_SHIGYO_SPEC.md   # 本ファイル
```

---

## 4. デザインシステム

### テーマカラー（v1.2で緑→紫に変更）

| 変数名 | 値 | 用途 |
|--------|-----|------|
| `--accent` | `#8b5cf6` | メインアクセントカラー |
| `--accent-purple` | `#8b5cf6` | アクセント参照用 |
| `--accent-gradient` | `135deg, #8b5cf6, #7c3aed` | ボタン・バッジ等のグラデーション |
| `--accent-glow` | `rgba(139, 92, 246, 0.3)` | グロー効果 |
| `--bg-primary` | `#0a0e1a` | 背景色（ダークネイビー） |
| `--bg-secondary` | `#111827` | カード背景 |
| `--text-primary` | `#f1f5f9` | メインテキスト色 |

### フォント

- `Noto Sans JP`（日本語） + `Inter`（英数字）
- Google Fonts CDN経由

---

## 5. 分析対象 6士業

| # | 士業名 | 総務省業種コード | アイコン |
|---|--------|-----------------|---------|
| 1 | 税理士事務所 | 7242 | 📊 |
| 2 | 弁護士事務所 | 7211 | ⚖️ |
| 3 | 社会保険労務士事務所 | 7251 | 🏢 |
| 4 | 行政書士事務所 | 7231 | 📝 |
| 5 | 司法書士事務所 | 7221 | 🏛️ |
| 6 | 公認会計士事務所 | 7241 | 🔢 |

---

## 6. 処理フロー

### 6-1. 分析フロー

```
ユーザー入力（エリア名）
  ↓
オートコンプリート（area-database.js: 1,892エリア検索）
  ↓ 候補が複数 → エリア選択モーダル
  ↓ 購入済み＋DBにデータあり → 即表示（再分析なし）
  ↓
Step 1: e-Stat API → 人口・世帯数取得
  ↓ 取得失敗時 → AI推計に切り替え
Step 2: Gemini AI → 全6士業一括分析（1回のAPI呼び出し）
  ↓
Step 3: レポート生成・表示
  ↓ 無料ユーザー → 人口データのみ表示、有料セクションはぼかし+購入プロンプト
  ↓ 購入済み → 全セクション表示
```

### 6-2. 決済フロー

```
「購入してレポートを見る」クリック
  ↓ 未ログイン → ログインモーダル → ログイン完了後に自動で決済再開
  ↓
分析データをsessionStorageに一時保存
  ↓
Worker /api/checkout → Stripe Checkout Session作成
  ↓
Stripe決済ページへリダイレクト
  ↓ 決済完了
?session_id=xxx 付きでリダイレクト戻り
  ↓
Worker /api/purchases → 購入確認
  ↓
sessionStorageから分析データ復元 → 全セクション表示
  ↓
分析データをSupabase DBに永続保存
```

---

## 7. APIエンドポイント（共有Worker）

全て `house-search-proxy.ai-fudosan.workers.dev` 上。

| メソッド | パス | 認証 | 用途 |
|---------|------|------|------|
| POST | `/api/gemini` | 不要 | Gemini APIプロキシ（プロンプト → テキスト応答） |
| GET | `/api/estat/population` | 不要 | e-Stat人口統計プロキシ |
| POST | `/api/checkout` | JWT必須 | Stripe Checkout Session作成 |
| GET | `/api/purchases` | JWT必須 | 購入確認（session_idパラメータ） |

### Gemini AI プロンプト構成

1リクエストで全6士業を一括分析。レスポンスはJSON形式。

**主要フィールド**:
- `overall_summary`: エリア全体総評（1,500文字以上）
- `population`: 人口・世帯・密度・増減率
- `area_economic_profile`: 世帯年収・事業所数・高齢化率・住宅価格帯・主要産業・相続需要
- `professions[]`: 6士業それぞれの詳細分析
  - 推計事務所数、密度（/万人）、競合レベル
  - 市場規模、平均年商、開業費用、損益分岐点
  - 個人/法人顧客単価、顧客割合
  - 開業適性スコア（0-100）、成長ポテンシャル
  - 推奨集客チャネル、主要ニーズ、繁忙期
- `recommended_top6`: 開業適性ランキング（順位・スコア・理由）

---

## 8. レポート出力セクション

| # | セクション名 | 無料/有料 | 内容 |
|---|-------------|----------|------|
| ① | エリア人口・世帯 | 無料 | 総人口・世帯数・人口密度・増減率（e-Stat実データ） |
| ② | エリア全体総評 | 有料 | AI生成の1,500文字以上のエリア分析 |
| ③ | エリア経済プロフィール | 有料 | 世帯年収・事業所数・高齢化率・住宅価格帯等 |
| ④ | 開業適性ランキングTOP6 | 有料 | 6士業のスコア付き順位表 |
| ⑤ | 士業別詳細比較 | 有料 | 6士業グリッド（事務所数・競合・市場規模・適性スコア・顧客割合・集客チャネル） |
| ⑥ | 開業適性スコア詳細比較 | 有料 | 横棒グラフ + 主要ニーズタグ |

---

## 9. 認証

### Supabase Auth設定

| 項目 | 値 |
|------|-----|
| Supabase URL | `https://ypyrjsdotkeyvzequdez.supabase.co` |
| Anon Key | `sb_publishable_l5yNWlXOZAHABwlbEalGng_R8zioydf` |
| 認証方式 | Implicit Flow |
| プロバイダ | メール+PW / Google OAuth |
| パスワードリセット | `supabaseClient.auth.resetPasswordForEmail()` |

### 認証フロー

- `onAuthStateChange` で全イベント管理
- `INITIAL_SESSION`: 初期セッション復元
- `SIGNED_IN`: モーダル閉じ → 保留中の決済フロー自動再開
- `PASSWORD_RECOVERY`: パスワードリセット処理

---

## 10. 決済（Stripe）

| 項目 | 値 |
|------|-----|
| 金額 | ¥300（税込） |
| 種別 | 買い切り（1エリア単位） |
| Checkout作成 | Worker `/api/checkout` で `service: 'ai-shigyo'` 指定 |
| 購入確認 | Worker `/api/purchases?session_id=xxx` |
| 領収書 | Stripe自動送信 |

---

## 11. データ永続化

### 購入履歴

- **localStorage**: `ai_shigyo_purchases` キーに購入エリア一覧を保存
- **Supabase DB**: Worker経由で購入レコード保存

### 分析データ

- **sessionStorage**: 決済リダイレクト中の一時保存（`ai_shigyo_pendingAnalysis`, `ai_shigyo_pendingArea`）
- **Supabase DB**: 購入済みエリアの分析データを永続保存（`_saveAnalysisDataToDB`）
- 購入済みエリアはDBから即時表示（再分析不要）

---

## 12. エクスポート機能

| 形式 | ライブラリ | 内容 |
|------|----------|------|
| Excel | xlsx-js-style v1.2.0 | 全6士業の詳細データ + スタイル付き |
| PDF | html2pdf.js v0.10.2 | レポート画面のPDF変換 |

※エクスポートは購入済みユーザーのみ利用可能。

---

## 13. 外部ライブラリ（CDN）

| ライブラリ | バージョン | 用途 |
|----------|----------|------|
| Supabase JS | v2 | 認証・DB操作 |
| xlsx-js-style | v1.2.0 | Excel出力 |
| Chart.js | v4.4.7 | チャート描画 |
| html2pdf.js | v0.10.2 | PDF出力 |

---

## 14. Gemini APIレート制限対策

- 最小呼び出し間隔: 6秒（`_geminiMinInterval = 6000`）
- 429エラー時: 最大5回リトライ（10秒 × attempt数の指数バックオフ）
- Worker経由でAPIキーを秘匿（フロントエンドにキー露出なし）

---

## 15. 姉妹サービスとの差異

| 項目 | ai-fudosan | ai-shoken | ai-shigyo |
|------|-----------|-----------|-----------|
| テーマカラー | 青系 `#3b82f6` | 緑系 `#10b981` | 紫系 `#8b5cf6` |
| 分析対象 | 不動産市場（賃貸/売買） | 出店商圏（業種別） | 士業開業（6士業） |
| データソース | e-Stat + AI | e-Stat + AI | e-Stat + AI |
| 共有Worker | 同一 | 同一 | 同一 |
| service識別子 | `ai-fudosan` | `ai-shoken` | `ai-shigyo` |
| アイコン | 🏠 | 🏪 | ⚖️ |

---

## 16. デプロイ手順

```bash
# 1. ローカルで変更
# 2. 3箇所のバージョン番号を更新
#    - index.html: <div class="header__badge">vX.Y</div>
#    - index.html: フッター &copy; 2026 ... vX.Y
#    - app.js: 2行目コメント // AI士業商圏分析レポート vX.Y
# 3. コミット＆プッシュ
git add -A
git commit -m "feat: ○○追加 vX.X → vX.Y"
git push origin master
# 4. GitHub Pages 自動反映（CNAME: ai-shigyo.bantex.jp）
```

---

## 17. バージョン履歴

| Ver | 日付 | 内容 |
|-----|------|------|
| v1.0 | 2026-02 | 初版リリース |
| v1.1 | 2026-02 | 機能改善 |
| v1.2 | 2026-02-27 | テーマカラーを緑(#10b981)→紫(#8b5cf6)に変更（ai-shokenとの差別化） |
