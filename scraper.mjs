import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { writeFileSync } from "fs";

const BASE = "https://sense-nagaokakyo.city.nagaokakyo.lg.jp";
const DELAY = 1000; // 1秒待機

const CATEGORIES = {
  "グルメ": "/pages/4029175/blog",
  "観光・おでかけ": "/pages/4028932/blog",
  "イベント": "/pages/4028942/blog",
  "歴史・文化": "/pages/7157035/blog",
  "お土産・お買い物": "/pages/7157036/blog",
  "親子で楽しむ": "/pages/7157052/blog",
  "たけのこ": "/pages/7157054/blog",
  "あじさい": "/pages/4029061/blog",
  "紅葉": "/pages/7157058/blog",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

// カテゴリページからcategoryIdを抽出
function extractCategoryId(path) {
  // /pages/XXXXXXX/blog -> カテゴリページを取得してcategoryIdを見つける
  const match = path.match(/\/pages\/(\d+)\/blog/);
  return match ? match[1] : null;
}

// カテゴリページから記事URLを収集
async function collectArticleUrls(categoryName, categoryPath) {
  const articles = [];
  const pageId = extractCategoryId(categoryPath);

  // まずカテゴリページにアクセスしてcategoryIdを取得
  console.log(`  カテゴリページ取得中: ${categoryName}`);
  const html = await fetchPage(`${BASE}${categoryPath}`);
  await sleep(DELAY);
  const $ = cheerio.load(html);

  // 記事リンクを収集（/posts/数字 のパターン）
  const postLinks = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && /^\/posts\/\d+/.test(href)) {
      // URLからcategoryIdsパラメータを除去してクリーンなURLを取得
      const postId = href.match(/\/posts\/(\d+)/)?.[1];
      if (postId) postLinks.add(postId);
    }
  });

  // categoryIdをページから取得
  let catId = null;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && /\/posts\/categories\/\d+/.test(href)) {
      const m = href.match(/\/posts\/categories\/(\d+)/);
      if (m) catId = m[1];
    }
  });

  for (const id of postLinks) {
    articles.push({ postId: id, categories: [categoryName] });
  }

  // ページネーションで残りを取得
  if (catId) {
    let page = 2;
    while (true) {
      const pageUrl = `${BASE}/posts/categories/${catId}/page/${page}?type=grid`;
      console.log(`    ページ ${page} 取得中...`);
      try {
        const pageHtml = await fetchPage(pageUrl);
        await sleep(DELAY);
        const $p = cheerio.load(pageHtml);
        const newLinks = new Set();
        $p("a[href]").each((_, el) => {
          const href = $p(el).attr("href");
          if (href && /^\/posts\/\d+/.test(href)) {
            const postId = href.match(/\/posts\/(\d+)/)?.[1];
            if (postId) newLinks.add(postId);
          }
        });

        if (newLinks.size === 0) break;

        for (const id of newLinks) {
          articles.push({ postId: id, categories: [categoryName] });
        }
        page++;
      } catch (e) {
        console.log(`    ページ ${page} でエラー: ${e.message}`);
        break;
      }
    }
  }

  console.log(`  ${categoryName}: ${articles.length}件の記事を発見`);
  return articles;
}

// 記事ページからデータを抽出
function extractArticleData(html, url) {
  const $ = cheerio.load(html);

  // タイトル
  const title =
    $("h1").first().text().trim() ||
    $(".blog-title__text").first().text().trim() ||
    $("title").text().trim();

  // カテゴリ
  const categories = [];
  $(".blog-item-category-list__item, .blog-article-category-list__item").each(
    (_, el) => {
      const cat = $(el).text().trim();
      if (cat && cat !== "新着") categories.push(cat);
    }
  );

  // 本文テキスト抽出
  let fullText = "";

  // メインコンテンツエリアからテキストを取得
  const contentSelectors = [
    ".blog-article-outer",
    ".page__content",
    ".blog-content",
    "article",
    ".post-content",
  ];

  for (const sel of contentSelectors) {
    const el = $(sel);
    if (el.length) {
      // scriptとstyleを除去
      el.find("script, style, nav, header, footer").remove();
      fullText = el.text().replace(/\s+/g, " ").trim();
      if (fullText.length > 100) break;
    }
  }

  // fallback: bodyからテキスト
  if (fullText.length < 100) {
    $("script, style, nav, header, footer").remove();
    fullText = $("body").text().replace(/\s+/g, " ").trim();
  }

  // スポット名抽出（h2, h3の見出しや太字テキストから）
  const spots = [];
  const spotCandidates = new Set();

  // h2, h3 から抽出
  $("h2, h3").each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length > 1 && text.length < 50) {
      // 数字だけ、一般的な見出しは除外
      if (!/^[\d\s.。、]+$/.test(text) && !/^(まとめ|おわりに|はじめに|目次|関連|アクセス|基本情報|DATA|data|店舗情報)$/i.test(text)) {
        spotCandidates.add(text);
      }
    }
  });

  // strong/b タグから店名候補を抽出
  $("strong, b").each((_, el) => {
    const text = $(el).text().trim();
    if (
      text &&
      text.length > 1 &&
      text.length < 40 &&
      !text.includes("。") &&
      !text.includes("！！")
    ) {
      // 住所や電話番号は除外
      if (!/^\d|^〒|^TEL|^tel|^℡|^京都|^長岡京市/.test(text)) {
        spotCandidates.add(text);
      }
    }
  });

  spots.push(...[...spotCandidates].slice(0, 10));

  // full_textは3000文字まで
  const trimmedFull = fullText.slice(0, 3000);
  const summary = fullText.slice(0, 600);

  return {
    url,
    title,
    categories,
    spots,
    summary,
    full_text: trimmedFull,
  };
}

async function main() {
  const testMode = process.argv.includes("--test");
  const maxArticles = testMode ? 10 : Infinity;

  console.log(`=== SENSE NAGAOKAKYO スクレイパー ===`);
  console.log(`モード: ${testMode ? "テスト（10件）" : "全件"}\n`);

  // Step 1: 全カテゴリから記事URLを収集
  console.log("--- Step 1: 記事URL収集 ---");
  const allArticlesMap = new Map(); // postId -> { postId, categories }

  for (const [catName, catPath] of Object.entries(CATEGORIES)) {
    try {
      const articles = await collectArticleUrls(catName, catPath);
      for (const art of articles) {
        if (allArticlesMap.has(art.postId)) {
          // 既存記事にカテゴリを追加
          const existing = allArticlesMap.get(art.postId);
          for (const c of art.categories) {
            if (!existing.categories.includes(c)) {
              existing.categories.push(c);
            }
          }
        } else {
          allArticlesMap.set(art.postId, art);
        }
      }
    } catch (e) {
      console.error(`  ${catName} でエラー: ${e.message}`);
    }
  }

  const allArticles = [...allArticlesMap.values()];
  console.log(`\n合計: ${allArticles.length}件のユニーク記事\n`);

  // テストモードなら10件に制限
  const targetArticles = allArticles.slice(0, maxArticles);

  // Step 2: 各記事からデータを抽出
  console.log(`--- Step 2: 記事データ抽出（${targetArticles.length}件） ---`);
  const results = [];
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < targetArticles.length; i++) {
    const art = targetArticles[i];
    const articleUrl = `${BASE}/posts/${art.postId}`;
    console.log(
      `  [${i + 1}/${targetArticles.length}] ${articleUrl}`
    );

    try {
      const html = await fetchPage(articleUrl);
      const data = extractArticleData(html, articleUrl);

      // カテゴリ情報をマージ（ページから取得したものとURL収集時のもの）
      const mergedCategories = [...new Set([...art.categories, ...data.categories])];
      data.categories = mergedCategories;

      results.push(data);
      successCount++;
      console.log(`    ✓ ${data.title.slice(0, 50)}`);
    } catch (e) {
      errorCount++;
      console.log(`    ✗ エラー: ${e.message}`);
    }

    await sleep(DELAY);
  }

  // Step 3: JSON保存
  const output = {
    meta: {
      total: results.length,
      scraped_at: new Date().toISOString(),
    },
    articles: results,
  };

  writeFileSync("spots_db.json", JSON.stringify(output, null, 2), "utf-8");

  console.log(`\n=== 完了 ===`);
  console.log(`成功: ${successCount}件`);
  console.log(`エラー: ${errorCount}件`);
  console.log(`保存: spots_db.json`);
}

main().catch(console.error);
