// ACTION shop importer for logged-in WordPress admin pages.
//
// Usage:
// 1. Log in to aiwe.cc WordPress.
// 2. Open https://aiwe.cc/wp-admin/edit.php?post_type=linecard_21
//    or one linecard_21 edit page.
// 3. Paste this whole file into DevTools Console and press Enter.
//
// It uses your current WordPress login cookie to read wp-admin edit pages,
// then imports the selected products into ACTION Cloudflare Worker.
(async () => {
  const workerUrl = "https://hooktea.fangwl591021.workers.dev";
  const targetNames = [
    "Aura-soma平衡油",
    "Aura-soma大師噴霧",
    "Aura-soma大師精華",
    "超渡圓滿香",
    "淨化香",
  ];

  const adminPwd = prompt("請輸入 ACTION 後台管理密碼，用於匯入商城商品");
  if (!adminPwd) return;

  const mode = confirm("按確定：覆蓋 ACTION 目前商城商品；按取消：更新同代碼商品並保留其他商品")
    ? "replace"
    : "append";

  const normalizeText = value => String(value || "").replace(/\s+/g, " ").trim();
  const parseNumber = value => Number(String(value || "").replace(/[^0-9.-]/g, "")) || 0;
  const absoluteUrl = url => {
    try { return new URL(url, location.origin).href; } catch (_) { return ""; }
  };
  const getPostIdFromUrl = url => new URL(url, location.origin).searchParams.get("post") || "";

  const fetchDoc = async url => {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`讀取失敗 ${res.status}: ${url}`);
    const text = await res.text();
    if (/wp-login\.php|name="log"|id="loginform"/i.test(text)) {
      throw new Error(`WordPress 登入狀態失效，請重新登入後再跑：${url}`);
    }
    return new DOMParser().parseFromString(text, "text/html");
  };

  const fieldItems = doc => [...doc.querySelectorAll("input, textarea, select")].map(el => {
    const wrap = el.closest(".acf-field, .cmb-row, tr, .form-field, .rwmb-field, .postbox, .components-panel__row");
    const label = normalizeText(
      wrap?.querySelector("label, .acf-label, th, .rwmb-label")?.textContent ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      ""
    );
    const haystack = normalizeText([
      el.name,
      el.id,
      el.className,
      el.dataset?.name,
      el.dataset?.key,
      label,
      wrap?.textContent,
    ].join(" ")).toLowerCase();
    return { el, label, haystack, value: el.value };
  });

  const findField = (items, keywords) => {
    const keys = keywords.map(k => k.toLowerCase());
    const hit = items.find(item => keys.some(k => item.haystack.includes(k)) && normalizeText(item.value));
    return hit ? normalizeText(hit.value) : "";
  };

  const readJson = async url => {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  };

  const mediaImageUrl = async (doc, postId) => {
    const thumbnailId =
      doc.querySelector("input#_thumbnail_id, input[name='_thumbnail_id']")?.value ||
      doc.querySelector("[data-thumbnail-id]")?.dataset?.thumbnailId ||
      "";
    if (thumbnailId && thumbnailId !== "-1") {
      const media = await readJson(`${location.origin}/wp-json/wp/v2/media/${thumbnailId}`);
      const sizes = media?.media_details?.sizes || {};
      return (
        media?.source_url ||
        sizes.full?.source_url ||
        sizes.large?.source_url ||
        sizes.medium?.source_url ||
        ""
      );
    }

    const img =
      doc.querySelector("#set-post-thumbnail img[src]") ||
      doc.querySelector(".editor-post-featured-image img[src]") ||
      doc.querySelector(".inside img.attachment-post-thumbnail[src]") ||
      doc.querySelector("img[src*='uploads'][src]");
    if (img?.src) return absoluteUrl(img.src);

    const restPost = postId ? await readJson(`${location.origin}/wp-json/wp/v2/linecard_21/${postId}?_embed=1`) : null;
    return (
      restPost?._embedded?.["wp:featuredmedia"]?.[0]?.source_url ||
      restPost?.yoast_head_json?.og_image?.[0]?.url ||
      ""
    );
  };

  const extractDescription = doc => {
    const textarea =
      doc.querySelector("textarea#content") ||
      doc.querySelector("textarea[name='content']") ||
      doc.querySelector("textarea#excerpt") ||
      doc.querySelector("textarea[name='excerpt']");
    if (textarea?.value) return textarea.value.trim();

    const editorJson = [...doc.querySelectorAll("script[type='application/json']")]
      .map(s => s.textContent || "")
      .find(text => text.includes('"content"') || text.includes("linecard_21"));
    if (editorJson) {
      const stripped = editorJson
        .replace(/<[^>]*>/g, "")
        .replace(/\\u003c[^]*?\\u003e/g, "")
        .trim();
      if (stripped.length < 1000) return stripped;
    }
    return "";
  };

  const scrapeEditPage = async (url, rowData = {}) => {
    const doc = await fetchDoc(url);
    const items = fieldItems(doc);
    const postId = getPostIdFromUrl(url);
    const title =
      doc.querySelector("input#title, input[name='post_title']")?.value ||
      normalizeText(doc.querySelector(".editor-post-title__input, h1")?.textContent) ||
      rowData.name ||
      "";

    const code = findField(items, ["商品代碼", "product_code", "linecard_code", "sku", "code"]) || rowData.code;
    const storeName = findField(items, ["店家名稱", "shop_name", "store_name", "vendor", "merchant"]) || rowData.storeName;
    const status = findField(items, ["商品狀態", "product_status", "sell_status", "status"]) || rowData.status || "販賣中";
    const fieldPrice = parseNumber(findField(items, ["點數", "扣點", "價格", "售價", "price", "point"]));

    return {
      id: `PROD_wp_${postId || code || title}`.replace(/[^\w-]+/g, "_"),
      name: normalizeText(title),
      code: normalizeText(code),
      storeName: normalizeText(storeName || "人生進化ACTION"),
      status: normalizeText(status || "販賣中"),
      price: fieldPrice,
      pointsPrice: fieldPrice,
      image: await mediaImageUrl(doc, postId),
      description: extractDescription(doc),
      sourceUrl: absoluteUrl(url),
      isPublished: true,
    };
  };

  const rowDataFromList = row => {
    const cells = [...row.children].map(cell => normalizeText(cell.textContent));
    const titleLink = row.querySelector(".row-title");
    const editUrl =
      row.querySelector("a[href*='post.php?post='][href*='action=edit']")?.href ||
      titleLink?.href ||
      "";
    return {
      name: normalizeText(titleLink?.textContent || cells[1]),
      code:
        normalizeText(row.querySelector(".column-product_code, .column-linecard_code, .column-sku")?.textContent) ||
        cells.find(text => /^淨\d+/i.test(text)) ||
        "",
      storeName:
        normalizeText(row.querySelector(".column-store_name, .column-shop_name, .column-vendor")?.textContent) ||
        cells.find(text => text.includes("ACTION")) ||
        "",
      status:
        normalizeText(row.querySelector(".column-product_status, .column-status")?.textContent) ||
        cells.find(text => text.includes("販賣")) ||
        "販賣中",
      editUrl: absoluteUrl(editUrl),
    };
  };

  const collectEditTargets = () => {
    if (location.href.includes("post.php") && new URL(location.href).searchParams.get("post")) {
      return [{ editUrl: location.href }];
    }

    const rows = [...document.querySelectorAll("#the-list tr")].filter(row => row.querySelector(".row-title"));
    const picked = rows.map(rowDataFromList).filter(item => {
      if (!item.editUrl) return false;
      return targetNames.some(name => item.name.includes(name));
    });

    return picked.length ? picked : rows.map(rowDataFromList).filter(item => item.editUrl);
  };

  const targets = collectEditTargets();
  if (!targets.length) throw new Error("沒有找到商品編輯連結，請在 linecard_21 商品列表頁或商品編輯頁執行。");

  const products = [];
  for (const [index, target] of targets.entries()) {
    console.log(`讀取商品 ${index + 1}/${targets.length}`, target.editUrl);
    products.push(await scrapeEditPage(target.editUrl, target));
  }

  console.table(products.map(p => ({
    name: p.name,
    code: p.code,
    image: p.image ? "有" : "無",
    description: p.description ? "有" : "無",
    points: p.pointsPrice,
  })));

  const missingImages = products.filter(p => !p.image).map(p => p.name);
  const warning = missingImages.length ? `\n\n注意：以下商品沒有抓到圖片：\n${missingImages.join("\n")}` : "";
  if (!confirm(`已抓到 ${products.length} 筆商品，是否匯入 ACTION 商城？${warning}`)) return;

  const res = await fetch(workerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "ADMIN_IMPORT_PRODUCTS",
      payload: { adminPwd, mode, products },
      userProfile: { userId: "WP_LINECARD_IMPORTER" },
    }),
  });
  const json = await res.json();
  console.log("ACTION import result:", json);
  if (json.status !== "success") throw new Error(json.message || JSON.stringify(json));
  alert(`匯入完成：${json.data.count} 筆。請回 ACTION 商城重新整理確認圖片與資料。`);
})();
