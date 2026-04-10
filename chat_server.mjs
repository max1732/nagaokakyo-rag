import { config } from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env") });

import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import nodeFetch from "node-fetch";

// --- 設定 ---
const PORT = process.env.PORT || 3000;
const TOP_K = 3;
const MODEL = "claude-sonnet-4-20250514";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("エラー: ANTHROPIC_API_KEY が設定されていません。.env を確認してください。");
  process.exit(1);
}

// --- データ読み込み ---
const db = JSON.parse(readFileSync(join(__dirname, "spots_db.json"), "utf-8"));
console.log(`spots_db.json 読み込み完了: ${db.articles.length}件`);

// --- 検索インデックス構築 ---
const searchIndex = db.articles.map((a) => ({
  article: a,
  text: `${a.title} ${a.categories.join(" ")} ${a.spots.join(" ")} ${a.full_text}`.toLowerCase(),
}));

function search(query, topK = TOP_K) {
  const q = query.toLowerCase();
  const tokens = [];
  for (const word of q.split(/\s+/)) {
    if (word.length >= 2) tokens.push(word);
    if (/[^\x00-\x7F]/.test(word)) {
      for (let i = 0; i < word.length - 1; i++) {
        tokens.push(word.slice(i, i + 2));
      }
    }
  }
  if (q.length >= 2) tokens.push(q);

  const scored = searchIndex.map(({ article, text }) => {
    let score = 0;
    for (const token of tokens) {
      if (text.indexOf(token) !== -1) {
        score += 10;
        if (article.title.toLowerCase().includes(token)) score += 20;
        if (article.spots.join(" ").toLowerCase().includes(token)) score += 15;
        let count = 0, pos = 0;
        while ((pos = text.indexOf(token, pos)) !== -1) { count++; pos += token.length; }
        score += Math.min(count, 5) * 2;
      }
    }
    return { article, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.article);
}

// --- Claude API 呼び出し ---
async function callClaude(systemPrompt, userMessage) {
  const res = await nodeFetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

// --- モード別システムプロンプト ---
const SYSTEM_BASE = `あなたは京都府長岡京市の観光・グルメ情報に詳しいAIアシスタント「SENSE長岡京ナビ」です。
SENSE NAGAOKAKYO（長岡京市公式サブサイト）の記事データベースをもとに、正確で親しみやすい回答をしてください。

## ルール
- データベースにある情報を優先して回答する
- 情報が見つからない場合は正直に「データベースに該当する情報がありません」と伝える
- 店名・スポット名・住所などは正確に伝える
- 回答の最後に参考記事のURLを付ける`;

const MODE_PROMPTS = {
  line: `\n\n## 出力形式（LINEモード）
- 1回の返答は300文字以内に収める
- 絵文字を適度に使って親しみやすく
- 箇条書きで見やすく
- URLは1つだけ（最も関連性の高い記事）`,

  ig: `\n\n## 出力形式（Instagramモード）
- キャッチーで魅力的な文体
- ハッシュタグを3〜5個付ける（#長岡京 #京都グルメ など）
- 改行を多めに使って読みやすく
- 「保存してね」などのCTAを入れる`,
};

function buildSystemPrompt(mode, results) {
  let prompt = SYSTEM_BASE + (MODE_PROMPTS[mode] || MODE_PROMPTS.line);
  if (results.length > 0) {
    prompt += "\n\n## 参考データ（検索結果）\n";
    for (let i = 0; i < results.length; i++) {
      const a = results[i];
      prompt += `\n### ${i + 1}. ${a.title}\n`;
      prompt += `URL: ${a.url}\n`;
      prompt += `カテゴリ: ${a.categories.join(", ")}\n`;
      if (a.spots.length > 0) prompt += `スポット: ${a.spots.slice(0, 5).join(", ")}\n`;
      prompt += `内容: ${a.summary}\n`;
    }
  }
  return prompt;
}

// --- Express サーバー ---
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    message: "SENSE長岡京 RAG Chat Server",
    articles: db.articles.length,
    endpoints: {
      chat: "POST /api/chat { message, mode?: 'line'|'ig' }",
      search: "GET /api/search?q=キーワード",
    },
  });
});

app.get("/api/search", (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "q パラメータが必要です" });
  const results = search(q);
  res.json({
    query: q,
    count: results.length,
    results: results.map((a) => ({
      title: a.title, url: a.url, categories: a.categories,
      spots: a.spots.slice(0, 5), summary: a.summary.slice(0, 200),
    })),
  });
});

app.post("/api/chat", async (req, res) => {
  const { message, mode = "line" } = req.body;
  if (!message) return res.status(400).json({ error: "message が必要です" });
  if (!["line", "ig"].includes(mode)) return res.status(400).json({ error: "mode は 'line' または 'ig' を指定してください" });

  try {
    const results = search(message);
    console.log(`[${mode}] Q: "${message}" → ${results.length}件ヒット`);
    const systemPrompt = buildSystemPrompt(mode, results);
    const reply = await callClaude(systemPrompt, message);

    res.json({
      reply,
      mode,
      sources: results.map((a) => ({ title: a.title, url: a.url })),
    });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "AI応答の生成に失敗しました", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`SENSE長岡京 RAG Chat Server 起動: http://localhost:${PORT}`);
});
