/**
 * Project: HookTea - Backend Engine (Full Integration)
 * Version: 2026.04.26.V17_Bulletproof_KV_Rescue
 * Developer: 勝利團隊 - 小李 (Backend)
 * 功能：修復游標報錯、全面替換防彈 JSON 解析、加入 GAS 自動降落傘救援機制
 */

const utils = {
  hexToBytes: (hex) => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    return bytes;
  },
  bytesToHex: (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase(),
  stringToBytes: (str) => new TextEncoder().encode(str),
  bytesToString: (bytes) => new TextDecoder('utf-8').decode(bytes),
  prepareKey: (key, len = 32) => {
    let k = new TextEncoder().encode(key);
    const res = new Uint8Array(len);
    res.set(k.slice(0, len));
    return res;
  },
  prepareIV: (iv) => {
    let i = new TextEncoder().encode(iv);
    const res = new Uint8Array(16);
    res.set(i.slice(0, 16));
    return res;
  }
};

const PASSWORD_ADMIN_USER = {
  userId: "tonyfang",
  name: "Tonyfang",
  displayName: "Tonyfang",
  role: "admin",
};
const DEFAULT_CRM_LIFF_ID = "2007674851-OSa5v7cU";
async function aesEncrypt(text, key, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', utils.prepareKey(key, 32), { name: 'AES-CBC' }, false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: utils.prepareIV(iv) }, cryptoKey, utils.stringToBytes(text));
  return utils.bytesToHex(new Uint8Array(encrypted));
}

async function aesDecrypt(hex, key, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', utils.prepareKey(key, 32), { name: 'AES-CBC' }, false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: utils.prepareIV(iv) }, cryptoKey, utils.hexToBytes(hex));
  return utils.bytesToString(new Uint8Array(decrypted));
}

async function sha256(text) {
  const hash = await crypto.subtle.digest('SHA-256', utils.stringToBytes(text));
  return utils.bytesToHex(new Uint8Array(hash));
}

// 🛡️ 核心升級：無敵防彈讀取器，就算資料損毀也絕對不會造成系統當機
function getHighRiskLiveKey(key) {
  const rawKey = String(key || "");
  if (rawKey === "ORDERS") return "live/high-risk/orders.json";
  if (rawKey === "POINT_LEDGER") return "live/high-risk/point-ledger.json";
  if (rawKey === "AUDIT_LOGS") return "live/high-risk/audit-logs.json";
  if (rawKey === "RICH_MENU_SAVES") return "live/high-risk/rich-menu-saves.json";
  if (rawKey.startsWith("USER_")) return `live/high-risk/users/${encodeURIComponent(rawKey.slice(5))}.json`;
  if (rawKey.startsWith("POINTS_")) return `live/high-risk/points/${encodeURIComponent(rawKey.slice(7))}.json`;
  if (rawKey.startsWith("CHECKIN_")) return `live/high-risk/checkins/${encodeURIComponent(rawKey.slice(8))}.json`;
  return "";
}

async function safeGetR2Json(env, objectKey, defaultVal) {
  const bucket = getDataBucket(env);
  if (!bucket || !objectKey) return defaultVal;
  try {
    const obj = await bucket.get(objectKey);
    if (!obj) return defaultVal;
    return JSON.parse(await obj.text());
  } catch (e) {
    console.error(`[SafeGetR2] read failed: ${objectKey}`, e);
    return defaultVal;
  }
}

async function shouldReadHighRiskFromWasabi(env) {
  if (String(env.WASABI_READ_HIGH_RISK || "").toLowerCase() === "true") return true;
  const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
  return String(settings.high_risk_wasabi_read_enabled || "false").toLowerCase() === "true";
}

async function safeGetHighRiskWasabiValue(env, key, defaultVal) {
  if (!getWasabiConfig(env).configured) return defaultVal;
  const rawKey = String(key || "");
  try {
    if (rawKey === "ORDERS") return await safeGetWasabiJson(env, "high-risk/orders.json", defaultVal);
    if (rawKey === "POINT_LEDGER") return await safeGetWasabiJson(env, "high-risk/point-ledger.json", defaultVal);
    if (rawKey.startsWith("USER_")) {
      const rows = await safeGetWasabiJson(env, "high-risk/users.json", []);
      const found = (Array.isArray(rows) ? rows : []).find(row => row && row.key === rawKey);
      return found ? found.data : defaultVal;
    }
    if (rawKey.startsWith("POINTS_")) {
      const rows = await safeGetWasabiJson(env, "high-risk/points.json", []);
      const found = (Array.isArray(rows) ? rows : []).find(row => row && row.key === rawKey);
      return found ? found.data : defaultVal;
    }
  } catch (e) {
    console.error(`[Wasabi:HighRiskReadFallback] ${rawKey} read failed`, e);
  }
  return defaultVal;
}

async function safeGetKV(env, key, defaultVal, options = {}) {
  const liveKey = getHighRiskLiveKey(key);
  if (liveKey) {
    const r2Value = await safeGetR2Json(env, liveKey, undefined);
    if (r2Value !== undefined) return r2Value;
  }
  if (liveKey && options.preferWasabi !== false && await shouldReadHighRiskFromWasabi(env)) {
    const wasabiValue = await safeGetHighRiskWasabiValue(env, key, undefined);
    if (wasabiValue !== undefined) return wasabiValue;
  }
  try {
      const val = await env.ACTION_DATA.get(key);
      return val ? JSON.parse(val) : defaultVal;
  } catch (e) {
      console.error(`[SafeGetKV] 解析失敗 Key: ${key}`, e);
      return defaultVal;
  }
}

function getDataBucket(env) {
  return env.PRODUCT_DATA || env["act-image"] || env.act_image || null;
}

async function safePutKV(env, key, value, options) {
  const liveKey = getHighRiskLiveKey(key);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const bucket = getDataBucket(env);
  if (liveKey && bucket) {
    await bucket.put(liveKey, text, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    try {
      await env.ACTION_DATA.put(key, text, options);
    } catch (e) {
      console.error(`[SafePutKV] KV write failed, kept R2 live copy: ${key}`, e);
    }
    return { storage: "R2", kvAttempted: true };
  }
  await env.ACTION_DATA.put(key, text, options);
  return { storage: "KV", kvAttempted: true };
}

async function shouldReadLowRiskFromWasabi(env) {
  if (String(env.WASABI_READ_LOW_RISK || "").toLowerCase() === "true") return true;
  const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
  return String(settings.low_risk_wasabi_read_enabled || "false").toLowerCase() === "true";
}

function isHuaxuShopEnabled(env, settings = {}) {
  const mode = String(env.SHOP_MODULE || settings.shop_module || "").trim().toLowerCase();
  return mode === "huaxu" || !!String(env.HUAXU_PRODUCTS_URL || settings.huaxu_products_url || "").trim();
}

function normalizeHuaxuProduct(raw, fallbackIndex = 0) {
  const source = raw && typeof raw === "object" ? raw : {};
  const sourceStatus = source.status || source.product_status || source.productStatus || "";
  const status = sourceStatus || (source.isPublished === false || source.enabled === false ? "下架" : "販賣中");
  return normalizeProduct({
    id: source.id || source.product_id || source.productId || source.sku || source.code || `huaxu-${fallbackIndex + 1}`,
    code: source.code || source.sku || source.product_code || source.productNo || source.product_no,
    name: source.name || source.title || source.product_name || source.productName,
    storeName: source.storeName || source.store_name || source.vendor || source.brand || "HookTea 商城",
    status,
    price: source.price || source.sale_price || source.salePrice || source.amount || source.points_price,
    pointsPrice: source.pointsPrice || source.points_price || source.point_price || source.max_points || source.price,
    image: source.image || source.image_url || source.imageUrl || source.thumbnail || source.cover,
    description: source.description || source.summary || source.content,
    sourceUrl: source.sourceUrl || source.url || source.link,
    stock: source.stock ?? source.inventory ?? source.qty,
    isPublished: source.isPublished !== false && source.enabled !== false && source.status !== "下架",
    source: "huaxu",
    rawHuaxu: source,
  }, fallbackIndex);
}

async function fetchHuaxuProducts(env, settings = {}) {
  const url = String(env.HUAXU_PRODUCTS_URL || settings.huaxu_products_url || "").trim();
  if (!url) return null;
  const apiKey = String(env.HUAXU_API_KEY || settings.huaxu_api_key || "").trim();
  const headers = { "Accept": "application/json" };
  if (apiKey) {
    headers.Authorization = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
    headers["X-API-Key"] = apiKey.replace(/^Bearer\s+/i, "");
  }
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) throw new Error(`外部商品 API ${res.status}: ${data?.message || text.slice(0, 120)}`);
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.products)
      ? data.products
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.data)
          ? data.data
          : [];
  return list.map(normalizeHuaxuProduct).filter(p => p.name);
}

async function safeGetWasabiJson(env, key, defaultVal) {
  if (!getWasabiConfig(env).configured) return defaultVal;
  try {
    const remote = await getWasabiJson(env, key);
    return remote.data;
  } catch (e) {
    console.error(`[Wasabi:ReadFallback] ${key} read failed`, e);
    return defaultVal;
  }
}

async function safeGetProducts(env, options = {}) {
  const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
  if (options.allowExternal !== false && isHuaxuShopEnabled(env, settings)) {
    try {
      const huaxuProducts = await fetchHuaxuProducts(env, settings);
      if (Array.isArray(huaxuProducts)) return huaxuProducts;
    } catch (e) {
      console.error("[HuaxuShop] 商品 API 讀取失敗，改讀本地商品", e);
    }
  }
  if (options.preferWasabi !== false && await shouldReadLowRiskFromWasabi(env)) {
    const remote = await safeGetWasabiJson(env, "data/products.json", null);
    if (Array.isArray(remote)) return remote;
  }
  const bucket = getDataBucket(env);
  if (bucket) {
    try {
      const obj = await bucket.get("data/PRODUCTS.json");
      if (obj) return JSON.parse(await obj.text());
    } catch (e) {
      console.error("[Products:R2] 讀取失敗，改讀 KV", e);
    }
  }
  return safeGetKV(env, "PRODUCTS", []);
}

async function safePutProducts(env, products) {
  const normalized = Array.isArray(products) ? products : [];
  const text = JSON.stringify(normalized);
  const bucket = getDataBucket(env);
  let storage = "KV";
  if (bucket) {
    await bucket.put("data/PRODUCTS.json", text, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    storage = "R2";
  } else {
    await env.ACTION_DATA.put("PRODUCTS", text);
  }
  const wasabi = await safePutWasabiJson(env, "data/products.json", normalized);
  await recordWasabiDualWrite(env, {
    id: "products",
    label: "商城商品",
    key: "data/products.json",
    count: normalized.length,
    result: wasabi,
  });
  return { storage, wasabi };
}

async function safeGetCourses(env, options = {}) {
  if (options.preferWasabi !== false && await shouldReadLowRiskFromWasabi(env)) {
    const remote = await safeGetWasabiJson(env, "data/courses.json", null);
    if (Array.isArray(remote)) return remote;
  }
  const bucket = getDataBucket(env);
  if (bucket) {
    try {
      const obj = await bucket.get("data/COURSES.json");
      if (obj) return JSON.parse(await obj.text());
    } catch (e) {
      console.error("[Courses:R2] 讀取失敗，改讀 KV", e);
    }
  }
  return safeGetKV(env, "COURSES", []);
}

async function safeGetVideos(env, options = {}) {
  if (options.preferWasabi !== false && await shouldReadLowRiskFromWasabi(env)) {
    const remote = await safeGetWasabiJson(env, "data/videos.json", null);
    if (Array.isArray(remote)) return remote;
  }
  const videos = await safeGetKV(env, "VIDEOS", DEFAULT_VIDEOS);
  return Array.isArray(videos) ? videos : DEFAULT_VIDEOS;
}

async function safePutCourses(env, courses) {
  const normalized = Array.isArray(courses) ? courses : [];
  const text = JSON.stringify(normalized);
  const bucket = getDataBucket(env);
  let storage = "KV";
  if (bucket) {
    await bucket.put("data/COURSES.json", text, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    storage = "R2";
  } else {
    await env.ACTION_DATA.put("COURSES", text);
  }
  const wasabi = await safePutWasabiJson(env, "data/courses.json", normalized);
  await recordWasabiDualWrite(env, {
    id: "courses",
    label: "課程 / 預約服務",
    key: "data/courses.json",
    count: normalized.length,
    result: wasabi,
  });
  return { storage, wasabi };
}

function touchLastUpdate(env, ctx, scope = "Data") {
  if (!ctx) return;
  ctx.waitUntil(
    env.ACTION_DATA
      .put("SYS_LAST_UPDATE", Date.now().toString())
      .catch(e => console.error(`[${scope}] SYS_LAST_UPDATE 寫入失敗`, e))
  );
}

function getWasabiConfig(env) {
  const bucket = String(env.WASABI_BUCKET || "").trim();
  const region = String(env.WASABI_REGION || "us-west-1").trim();
  const endpoint = String(env.WASABI_ENDPOINT || (region ? `https://s3.${region}.wasabisys.com` : "")).replace(/\/+$/, "");
  const accessKeyId = String(env.WASABI_ACCESS_KEY_ID || env.WASABI_ACCESS_KEY || "").trim();
  const secretAccessKey = String(env.WASABI_SECRET_ACCESS_KEY || env.WASABI_SECRET_KEY || "").trim();
  const rawPrefix = String(env.WASABI_BASE_PREFIX || "shops/hooktea/").trim();
  const basePrefix = rawPrefix ? `${rawPrefix.replace(/^\/+|\/+$/g, "")}/` : "";
  return {
    provider: "wasabi",
    bucket,
    region,
    endpoint,
    basePrefix,
    accessKeyId,
    secretAccessKey,
    configured: !!(bucket && region && endpoint && accessKeyId && secretAccessKey),
  };
}

function awsUriEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function wasabiObjectKey(env, key) {
  const cfg = getWasabiConfig(env);
  const cleanKey = String(key || "").replace(/^\/+/, "");
  return `${cfg.basePrefix}${cleanKey}`;
}

async function sha256HexBody(body) {
  const bytes = body instanceof Uint8Array
    ? body
    : typeof body === "string"
      ? new TextEncoder().encode(body)
      : new Uint8Array();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey("raw", key instanceof ArrayBuffer ? key : new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function wasabiSigningKey(secret, dateStamp, region) {
  const kDate = await hmacSha256(`AWS4${secret}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, "s3");
  return hmacSha256(kService, "aws4_request");
}

async function wasabiRequest(env, method, key, options = {}) {
  const cfg = getWasabiConfig(env);
  if (!cfg.configured) throw new Error("Wasabi 尚未設定完整環境變數");
  const objectKey = wasabiObjectKey(env, key);
  const encodedKey = objectKey.split("/").map(awsUriEncode).join("/");
  const url = `${cfg.endpoint}/${awsUriEncode(cfg.bucket)}/${encodedKey}`;
  const host = new URL(cfg.endpoint).host;
  const body = options.body || "";
  const payloadHash = await sha256HexBody(body);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = `/${awsUriEncode(cfg.bucket)}/${encodedKey}`;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256HexBody(canonicalRequest),
  ].join("\n");
  const signingKey = await wasabiSigningKey(cfg.secretAccessKey, dateStamp, cfg.region);
  const signature = Array.from(new Uint8Array(await hmacSha256(signingKey, stringToSign))).map(b => b.toString(16).padStart(2, "0")).join("");
  const headers = {
    "Authorization": `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(options.contentType ? { "Content-Type": options.contentType } : {}),
  };
  const res = await fetch(url, { method, headers, body: ["GET", "HEAD", "DELETE"].includes(method) ? undefined : body });
  if (!res.ok) {
    const message = method === "HEAD" ? res.statusText : await res.text().catch(() => res.statusText);
    throw new Error(`Wasabi ${method} ${objectKey} failed: ${res.status} ${message.slice(0, 240)}`);
  }
  return { res, key: objectKey, url };
}

async function safePutWasabiJson(env, key, data) {
  if (!getWasabiConfig(env).configured) return { enabled: false, ok: false };
  try {
    const body = JSON.stringify(data);
    const hash = await sha256HexBody(body);
    const result = await wasabiRequest(env, "PUT", key, {
      body,
      contentType: "application/json; charset=utf-8",
    });
    return { enabled: true, ok: true, key: result.key, bytes: new TextEncoder().encode(body).length, sha256: hash };
  } catch (e) {
    console.error(`[Wasabi:DualWrite] ${key} 寫入失敗`, e);
    return { enabled: true, ok: false, key, message: e.message };
  }
}

async function getWasabiSyncStatus(env) {
  const fallback = { updatedAt: "", datasets: {} };
  const bucket = getDataBucket(env);
  if (bucket) {
    try {
      const obj = await bucket.get("data/WASABI_SYNC_STATUS.json");
      if (obj) {
        const parsed = JSON.parse(await obj.text());
        return parsed && typeof parsed === "object" ? { ...fallback, ...parsed, datasets: parsed.datasets || {} } : fallback;
      }
    } catch (e) {
      console.error("[Wasabi:SyncStatus] read failed", e);
    }
  }
  return fallback;
}

async function putWasabiSyncStatus(env, status) {
  const bucket = getDataBucket(env);
  if (!bucket) return false;
  await bucket.put("data/WASABI_SYNC_STATUS.json", JSON.stringify(status), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return true;
}

async function recordWasabiDualWrite(env, { id, label, key, count, result }) {
  try {
    const status = await getWasabiSyncStatus(env);
    const updatedAt = new Date().toISOString();
    status.updatedAt = updatedAt;
    status.datasets = status.datasets || {};
    status.datasets[id] = {
      id,
      label,
      key: result?.key || wasabiObjectKey(env, key),
      sourceKey: key,
      updatedAt,
      enabled: !!result?.enabled,
      ok: !!result?.ok,
      count: Number(count || 0),
      bytes: Number(result?.bytes || 0),
      sha256: result?.sha256 || "",
      message: result?.message || "",
    };
    await putWasabiSyncStatus(env, status);
  } catch (e) {
    console.error(`[Wasabi:SyncStatus] ${id} update failed`, e);
  }
}

async function exportLowRiskWasabiSnapshot(env) {
  if (!getWasabiConfig(env).configured) throw new Error("Wasabi 尚未設定完整環境變數");
  const datasets = [
    { id: "courses", label: "課程 / 預約服務", key: "data/courses.json", data: await safeGetCourses(env, { preferWasabi: false }) },
    { id: "products", label: "商城商品", key: "data/products.json", data: await safeGetProducts(env, { preferWasabi: false }) },
    { id: "videos", label: "影音資料", key: "data/videos.json", data: await safeGetVideos(env, { preferWasabi: false }) },
  ];
  const exportedAt = new Date().toISOString();
  const results = [];
  for (const item of datasets) {
    const data = Array.isArray(item.data) ? item.data : [];
    const write = await safePutWasabiJson(env, item.key, data);
    await recordWasabiDualWrite(env, {
      id: item.id,
      label: item.label,
      key: item.key,
      count: data.length,
      result: write,
    });
    if (!write.ok) throw new Error(`${item.label} 匯出失敗：${write.message || item.key}`);
    results.push({
      id: item.id,
      label: item.label,
      key: write.key,
      count: data.length,
      bytes: write.bytes,
      sha256: write.sha256,
    });
  }
  const manifest = {
    type: "low-risk-snapshot",
    exportedAt,
    source: "hooktea-worker",
    datasets: results,
  };
  const manifestWrite = await safePutWasabiJson(env, "data/low-risk-snapshot-manifest.json", manifest);
  if (!manifestWrite.ok) throw new Error(`快照索引寫入失敗：${manifestWrite.message || manifestWrite.key}`);
  return { success: true, exportedAt, datasets: results, manifest: manifestWrite };
}

async function getWasabiJson(env, key) {
  const result = await wasabiRequest(env, "GET", key);
  const text = await result.res.text();
  return { key: result.key, text, data: JSON.parse(text), bytes: new TextEncoder().encode(text).length, sha256: await sha256HexBody(text) };
}

async function verifyLowRiskWasabiSnapshot(env) {
  if (!getWasabiConfig(env).configured) throw new Error("Wasabi 尚未設定完整環境變數");
  const datasets = [
    { id: "courses", label: "課程 / 預約服務", key: "data/courses.json", data: await safeGetCourses(env, { preferWasabi: false }) },
    { id: "products", label: "商城商品", key: "data/products.json", data: await safeGetProducts(env, { preferWasabi: false }) },
    { id: "videos", label: "影音資料", key: "data/videos.json", data: await safeGetVideos(env, { preferWasabi: false }) },
  ];
  const results = [];
  for (const item of datasets) {
    const localData = Array.isArray(item.data) ? item.data : [];
    const localText = JSON.stringify(localData);
    const localHash = await sha256HexBody(localText);
    try {
      const remote = await getWasabiJson(env, item.key);
      const remoteData = Array.isArray(remote.data) ? remote.data : [];
      results.push({
        id: item.id,
        label: item.label,
        key: remote.key,
        ok: localHash === remote.sha256 && localData.length === remoteData.length,
        localCount: localData.length,
        remoteCount: remoteData.length,
        localSha256: localHash,
        remoteSha256: remote.sha256,
        remoteBytes: remote.bytes,
      });
    } catch (e) {
      results.push({
        id: item.id,
        label: item.label,
        key: wasabiObjectKey(env, item.key),
        ok: false,
        localCount: localData.length,
        remoteCount: null,
        localSha256: localHash,
        remoteSha256: "",
        message: e.message,
      });
    }
  }
  return { success: results.every(item => item.ok), verifiedAt: new Date().toISOString(), datasets: results };
}

async function listKVRecords(env, prefix) {
  const byKey = new Map();
  let listComplete = false;
  let cursor = null;
  while (!listComplete) {
    const options = { prefix };
    if (cursor) options.cursor = cursor;
    const list = await env.ACTION_DATA.list(options);
    const chunkSize = 20;
    for (let i = 0; i < list.keys.length; i += chunkSize) {
      const chunk = list.keys.slice(i, i + chunkSize);
      const values = await Promise.all(chunk.map(async key => ({
        key: key.name,
        data: await safeGetKV(env, key.name, null, { preferWasabi: false }),
      })));
      values.forEach(item => byKey.set(item.key, item));
    }
    listComplete = list.list_complete;
    cursor = list.cursor;
  }
  const bucket = getDataBucket(env);
  const r2Prefix = prefix === "USER_" ? "live/high-risk/users/" : prefix === "POINTS_" ? "live/high-risk/points/" : "";
  if (bucket && r2Prefix) {
    try {
      let r2Cursor;
      let complete = false;
      while (!complete) {
        const listed = await bucket.list({ prefix: r2Prefix, cursor: r2Cursor });
        for (const obj of listed.objects || []) {
          const uid = decodeURIComponent(obj.key.slice(r2Prefix.length).replace(/\.json$/, ""));
          const key = `${prefix}${uid}`;
          const data = await safeGetR2Json(env, obj.key, null);
          byKey.set(key, { key, data });
        }
        complete = listed.truncated !== true;
        r2Cursor = listed.cursor;
      }
    } catch (e) {
      console.error(`[ListR2Live] ${prefix} list failed`, e);
    }
  }
  return Array.from(byKey.values());
}

async function buildHighRiskWasabiDatasets(env) {
  return [
    { id: "users", label: "會員資料 USER_*", key: "high-risk/users.json", data: await listKVRecords(env, "USER_") },
    { id: "points", label: "會員點數 POINTS_*", key: "high-risk/points.json", data: await listKVRecords(env, "POINTS_") },
    { id: "point-ledger", label: "點數進出總表", key: "high-risk/point-ledger.json", data: await safeGetKV(env, "POINT_LEDGER", [], { preferWasabi: false }) },
    { id: "orders", label: "訂單資料", key: "high-risk/orders.json", data: await safeGetKV(env, "ORDERS", [], { preferWasabi: false }) },
  ];
}

async function exportHighRiskWasabiSnapshot(env) {
  if (!getWasabiConfig(env).configured) throw new Error("Wasabi 尚未設定完整環境變數");
  const datasets = await buildHighRiskWasabiDatasets(env);
  const exportedAt = new Date().toISOString();
  const results = [];
  for (const item of datasets) {
    const data = Array.isArray(item.data) ? item.data : [];
    const write = await safePutWasabiJson(env, item.key, data);
    await recordWasabiDualWrite(env, {
      id: item.id,
      label: item.label,
      key: item.key,
      count: data.length,
      result: write,
    });
    if (!write.ok) throw new Error(`${item.label} 匯出失敗：${write.message || item.key}`);
    results.push({
      id: item.id,
      label: item.label,
      key: write.key,
      count: data.length,
      bytes: write.bytes,
      sha256: write.sha256,
    });
  }
  const manifest = {
    type: "high-risk-snapshot",
    exportedAt,
    source: "hooktea-worker",
    datasets: results,
    note: "只讀快照，不切換會員、點數、訂單讀寫來源。",
  };
  const manifestWrite = await safePutWasabiJson(env, "high-risk/high-risk-snapshot-manifest.json", manifest);
  if (!manifestWrite.ok) throw new Error(`高風險快照清單寫入失敗：${manifestWrite.message || manifestWrite.key}`);
  return { success: true, exportedAt, datasets: results, manifest: manifestWrite };
}

async function verifyHighRiskWasabiSnapshot(env) {
  if (!getWasabiConfig(env).configured) throw new Error("Wasabi 尚未設定完整環境變數");
  const datasets = await buildHighRiskWasabiDatasets(env);
  const results = [];
  for (const item of datasets) {
    const localData = Array.isArray(item.data) ? item.data : [];
    const localText = JSON.stringify(localData);
    const localHash = await sha256HexBody(localText);
    try {
      const remote = await getWasabiJson(env, item.key);
      const remoteData = Array.isArray(remote.data) ? remote.data : [];
      results.push({
        id: item.id,
        label: item.label,
        key: remote.key,
        ok: localHash === remote.sha256 && localData.length === remoteData.length,
        localCount: localData.length,
        remoteCount: remoteData.length,
        localSha256: localHash,
        remoteSha256: remote.sha256,
        remoteBytes: remote.bytes,
      });
    } catch (e) {
      results.push({
        id: item.id,
        label: item.label,
        key: wasabiObjectKey(env, item.key),
        ok: false,
        localCount: localData.length,
        remoteCount: null,
        localSha256: localHash,
        remoteSha256: "",
        message: e.message,
      });
    }
  }
  return { success: results.every(item => item.ok), verifiedAt: new Date().toISOString(), datasets: results };
}

async function runWasabiDailyAcceptanceCheck(env) {
  const checkedAt = new Date().toISOString();
  const cfg = getWasabiConfig(env);
  const health = cfg.configured
    ? await wasabiHealthCheck(env)
    : { ok: false, steps: [{ step: "Config", ok: false, message: "缺少 Wasabi 環境變數" }] };
  const lowRisk = cfg.configured
    ? await verifyLowRiskWasabiSnapshot(env)
    : { success: false, verifiedAt: checkedAt, datasets: [] };
  const highRisk = cfg.configured
    ? await verifyHighRiskWasabiSnapshot(env)
    : { success: false, verifiedAt: checkedAt, datasets: [] };
  const success = Boolean(cfg.configured && health.ok && lowRisk.success && highRisk.success);
  const report = {
    success,
    checkedAt,
    summary: {
      health: health.ok,
      lowRisk: lowRisk.success,
      highRisk: highRisk.success,
    },
    health,
    lowRisk,
    highRisk,
    sourcePolicy: {
      lowRisk: (await shouldReadLowRiskFromWasabi(env)) ? "Wasabi 優先 / R2-KV fallback" : "原來源優先 / Wasabi 雙寫快照",
      highRisk: (await shouldReadHighRiskFromWasabi(env)) ? "Wasabi 優先 / R2 live / KV fallback" : "R2 live 優先 / KV fallback；Wasabi 快照與雙寫觀察",
    },
  };
  const status = await getWasabiSyncStatus(env);
  status.updatedAt = checkedAt;
  status.dailyAcceptance = {
    checkedAt,
    success,
    summary: report.summary,
    sourcePolicy: report.sourcePolicy,
  };
  await putWasabiSyncStatus(env, status);
  return report;
}

function highRiskDatasetMeta(id) {
  return {
    users: { id: "users", label: "會員資料 USER_*", key: "high-risk/users.json", load: env => listKVRecords(env, "USER_") },
    points: { id: "points", label: "會員點數 POINTS_*", key: "high-risk/points.json", load: env => listKVRecords(env, "POINTS_") },
    "point-ledger": { id: "point-ledger", label: "點數進出總表", key: "high-risk/point-ledger.json", load: env => safeGetKV(env, "POINT_LEDGER", [], { preferWasabi: false }) },
    orders: { id: "orders", label: "訂單資料", key: "high-risk/orders.json", load: env => safeGetKV(env, "ORDERS", [], { preferWasabi: false }) },
  }[id];
}

async function syncWasabiHighRiskDataset(env, id) {
  const meta = highRiskDatasetMeta(id);
  if (!meta) return { enabled: false, ok: false, message: `Unknown dataset: ${id}` };
  const data = await meta.load(env);
  const list = Array.isArray(data) ? data : [];
  const write = await safePutWasabiJson(env, meta.key, list);
  await recordWasabiDualWrite(env, {
    id: meta.id,
    label: meta.label,
    key: meta.key,
    count: list.length,
    result: write,
  });
  return write;
}

function observeHighRiskDualWrite(env, ctx, ids) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean))];
  const task = (async () => {
    const results = [];
    for (const id of uniqueIds) {
      try {
        results.push(await syncWasabiHighRiskDataset(env, id));
      } catch (e) {
        console.error(`[Wasabi:HighRiskDualWrite] ${id} failed`, e);
        results.push(null);
      }
    }
    return results;
  })();
  if (ctx) ctx.waitUntil(task);
  return task;
}

async function putOrdersKV(env, ctx, orders) {
  await safePutKV(env, "ORDERS", Array.isArray(orders) ? orders : []);
  if (ctx) observeHighRiskDualWrite(env, ctx, "orders");
  else await observeHighRiskDualWrite(env, null, "orders");
}

async function putUserKV(env, ctx, uid, user) {
  await safePutKV(env, `USER_${uid}`, user || {});
  await updateUsersIndexRecord(env, user && user.userId ? user : { ...(user || {}), userId: uid });
  if (ctx) observeHighRiskDualWrite(env, ctx, "users");
  else await observeHighRiskDualWrite(env, null, "users");
}

async function putPointKV(env, ctx, uid, pointData) {
  await safePutKV(env, `POINTS_${uid}`, pointData || { balance: 0, logs: [] });
  await updatePointsIndexRecord(env, uid, pointData || { balance: 0, logs: [] });
}

function normalizeMemberPhone(value) {
  const digits = String(value || "").replace(/\.0$/, "").replace(/\D+/g, "");
  if (digits && !digits.startsWith("0") && digits.length === 9) return `0${digits}`;
  return digits;
}

function memberPhoneValues(member = {}) {
  return [member.phone, member.mobile, member.tel, member.memberPhone, member.會員電話]
    .map(normalizeMemberPhone)
    .filter(Boolean);
}

async function findLegacyMemberByPhone(env, rawPhone, rawName = "") {
  const phone = normalizeMemberPhone(rawPhone);
  const name = String(rawName || "").trim();
  if (!phone) return { found: false, reason: "missing_phone" };
  const cached = await safeGetKV(env, `LEGACY_PHONE_${phone}`, null, { preferWasabi: false });
  if (cached?.userId) {
    const member = await safeGetKV(env, `USER_${cached.userId}`, null);
    if (member) return { found: true, member, userId: cached.userId, source: "index" };
  }

  const matches = [];
  let cursor;
  do {
    const page = await env.ACTION_DATA.list({ prefix: "USER_", cursor });
    for (const key of page.keys || []) {
      const member = await safeGetKV(env, key.name, null);
      if (!member?.legacyMemberId) continue;
      if (memberPhoneValues(member).includes(phone)) {
        matches.push({ userId: member.userId || key.name.replace(/^USER_/, ""), member });
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  if (matches.length === 1) {
    await safePutKV(env, `LEGACY_PHONE_${phone}`, { userId: matches[0].userId, phone, indexedAt: new Date().toISOString() });
    return { found: true, ...matches[0], source: "scan" };
  }
  if (matches.length > 1 && name) {
    const named = matches.filter(item => String(item.member.name || item.member.displayName || "").trim() === name);
    if (named.length === 1) {
      await safePutKV(env, `LEGACY_PHONE_${phone}`, { userId: named[0].userId, phone, name, indexedAt: new Date().toISOString() });
      return { found: true, ...named[0], source: "scan_name" };
    }
  }
  return { found: false, reason: matches.length > 1 ? "duplicate_phone" : "not_found", matches: matches.length };
}

function normalizeBindName(value) {
  return String(value || "")
    .replace(/^(姓名|名字|我是|我叫|會員姓名|舊會員姓名)\s*[:：]?\s*/i, "")
    .trim()
    .replace(/\s+/g, " ");
}

async function findLegacyMemberCandidates(env, query = {}) {
  const name = normalizeBindName(query.name || query.keyword || "");
  const phone = normalizeMemberPhone(query.phone || "");
  const lineName = normalizeBindName(query.lineName || "");
  const users = await listUserRecords(env);
  const candidates = [];
  for (const user of users) {
    if (!user || !user.userId || !user.legacyMemberId) continue;
    const displayName = normalizeBindName(user.name || user.displayName || "");
    const phones = memberPhoneValues(user);
    let score = 0;
    const reasons = [];
    if (phone && phones.includes(phone)) {
      score += 100;
      reasons.push("手機一致");
    }
    if (name && displayName) {
      if (displayName === name) {
        score += 80;
        reasons.push("姓名完全一致");
      } else if (displayName.includes(name) || name.includes(displayName)) {
        score += 45;
        reasons.push("姓名相近");
      }
    }
    if (lineName && displayName) {
      if (displayName === lineName) {
        score += 35;
        reasons.push("LINE 名稱一致");
      } else if (displayName.includes(lineName) || lineName.includes(displayName)) {
        score += 18;
        reasons.push("LINE 名稱相近");
      }
    }
    if (score <= 0) continue;
    candidates.push({
      userId: user.userId,
      legacyMemberId: user.legacyMemberId || user.userId,
      name: user.name || user.displayName || "",
      phone: phones[0] || "",
      birthday: user.birthday || "",
      address: user.address || user.fullAddress || "",
      memberTier: user.memberTier || "",
      score,
      reasons,
    });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 8);
}

async function createLineBindReviewCase(env, ctx, data = {}) {
  const now = new Date();
  const lineUid = String(data.lineUserId || "").trim();
  if (!lineUid) return null;
  const id = `BIND_${now.getTime()}_${crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;
  const record = {
    id,
    status: "PENDING",
    lineUserId: lineUid,
    lineDisplayName: String(data.lineDisplayName || "").trim(),
    linePictureUrl: String(data.linePictureUrl || "").trim(),
    providedName: normalizeBindName(data.providedName || ""),
    providedPhone: normalizeMemberPhone(data.providedPhone || ""),
    reason: String(data.reason || "needs_review").trim(),
    candidates: Array.isArray(data.candidates) ? data.candidates.slice(0, 8) : [],
    createdAt: now.toISOString(),
    createdTs: now.getTime(),
    updatedAt: now.toISOString(),
  };
  await safePutKV(env, `LINE_BIND_REVIEW_${id}`, record);
  const index = await safeGetKV(env, "LINE_BIND_REVIEW_INDEX", [], { preferWasabi: false });
  const nextIndex = [id, ...(Array.isArray(index) ? index.filter(item => item !== id) : [])].slice(0, 300);
  await safePutKV(env, "LINE_BIND_REVIEW_INDEX", nextIndex);
  const pendingForLine = await safeGetKV(env, `LINE_BIND_REVIEW_FOR_${lineUid}`, [], { preferWasabi: false });
  await safePutKV(env, `LINE_BIND_REVIEW_FOR_${lineUid}`, [id, ...(Array.isArray(pendingForLine) ? pendingForLine.filter(item => item !== id) : [])].slice(0, 20), { expirationTtl: 86400 * 30 });
  const candidateNames = record.candidates.map(item => item?.name).filter(Boolean).slice(0, 5).join("\u3001") || "\u7121\u660e\u78ba\u5019\u9078";
  const notifyText = [
    "\u{1F50E} <b>\u6703\u54e1\u7d81\u5b9a\u5be9\u6838</b>",
    `LINE\uFF1A${escapeTelegramHtml(record.lineDisplayName || "\u672a\u547d\u540d")}`,
    `UID\uFF1A<code>${escapeTelegramHtml(record.lineUserId)}</code>`,
    `\u586b\u5beb\uFF1A${escapeTelegramHtml(record.providedPhone || record.providedName || "\u672a\u586b")}`,
    `\u5019\u9078\uFF1A${escapeTelegramHtml(candidateNames)}`,
    `\u539f\u56e0\uFF1A${escapeTelegramHtml(record.reason)}`,
  ].join("\n");
  if (ctx) ctx.waitUntil(Promise.all([
    env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(() => {}),
    sendTelegramNotification(env, notifyText),
  ]));
  return record;
}

async function listLineBindReviewCases(env) {
  const index = await safeGetKV(env, "LINE_BIND_REVIEW_INDEX", [], { preferWasabi: false });
  const ids = Array.isArray(index) ? index.slice(0, 120) : [];
  const records = await Promise.all(ids.map(id => safeGetKV(env, `LINE_BIND_REVIEW_${id}`, null, { preferWasabi: false }).catch(() => null)));
  return records.filter(Boolean).sort((a, b) => Number(b.createdTs || 0) - Number(a.createdTs || 0));
}

async function mergePointDataForLineBind(env, ctx, legacyUid, lineUid) {
  if (!legacyUid || !lineUid || legacyUid === lineUid) return null;
  const linePoints = await safeGetKV(env, `POINTS_${lineUid}`, null);
  if (!linePoints) return null;
  const legacyPoints = await safeGetKV(env, `POINTS_${legacyUid}`, { balance: 0, logs: [] });
  const lineBalance = Number(linePoints.balance || 0);
  const legacyBalance = Number(legacyPoints.balance || 0);
  const merged = {
    ...legacyPoints,
    balance: legacyBalance + lineBalance,
    logs: [
      ...(Array.isArray(linePoints.logs) ? linePoints.logs.map(log => ({ ...log, migratedFromLineUid: lineUid })) : []),
      ...(Array.isArray(legacyPoints.logs) ? legacyPoints.logs : []),
    ].slice(0, 100),
    linkedLineUid: lineUid,
    updatedAt: new Date().toISOString(),
  };
  await putPointKV(env, ctx, legacyUid, merged);
  await safePutKV(env, `POINTS_ALIAS_${lineUid}`, { targetUid: legacyUid, movedAt: new Date().toISOString() });
  return merged;
}

async function bindLegacyMemberToLine(env, ctx, lineUid, payload = {}, lineProfile = null) {
  const verifiedLineUid = String(lineUid || "").trim();
  if (!verifiedLineUid || verifiedLineUid === "GUEST") return { bound: false, reason: "missing_line_uid" };
  const existing = await safeGetKV(env, `LINE_BIND_${verifiedLineUid}`, null, { preferWasabi: false });
  if (existing?.legacyUserId) {
    const member = await safeGetKV(env, `USER_${existing.legacyUserId}`, null);
    if (member) return { bound: true, userId: existing.legacyUserId, member, source: "existing" };
  }
  const phone = payload.phone || payload.mobile || payload.tel || payload.memberPhone;
  const name = payload.name || payload.displayName || lineProfile?.name || "";
  const found = await findLegacyMemberByPhone(env, phone, name);
  if (!found.found) return { bound: false, reason: found.reason, matches: found.matches || 0 };
  const member = {
    ...found.member,
    lineUserId: verifiedLineUid,
    linkedLineUid: verifiedLineUid,
    lineDisplayName: lineProfile?.name || found.member.lineDisplayName || "",
    pictureUrl: found.member.pictureUrl || lineProfile?.picture || "",
    updatedAt: new Date().toISOString(),
    legacyLinkedAt: new Date().toISOString(),
  };
  await putUserKV(env, ctx, found.userId, member);
  await safePutKV(env, `LINE_BIND_${verifiedLineUid}`, {
    lineUserId: verifiedLineUid,
    legacyUserId: found.userId,
    phone: normalizeMemberPhone(phone),
    name: member.name || member.displayName || "",
    linkedAt: new Date().toISOString(),
  });
  await mergeLineMonitorThread(env, verifiedLineUid, found.userId);
  await mergePointDataForLineBind(env, ctx, found.userId, verifiedLineUid);
  return { bound: true, userId: found.userId, member, source: found.source };
}

function lineEventMessageText(event) {
  const message = event?.message || {};
  if (message.type === "text") return String(message.text || "").trim();
  if (message.type === "image") return "[圖片]";
  if (message.type === "video") return "[影片]";
  if (message.type === "audio") return "[語音]";
  if (message.type === "file") return `[檔案] ${message.fileName || ""}`.trim();
  if (message.type === "sticker") return `[貼圖] ${message.packageId || ""}/${message.stickerId || ""}`;
  if (event?.type === "follow") return "[加入好友]";
  if (event?.type === "unfollow") return "[封鎖或取消好友]";
  if (event?.type === "postback") return `[Postback] ${event.postback?.data || ""}`.trim();
  return event?.type ? `[${event.type}]` : "";
}

async function resolveMonitorThreadIdForLine(env, lineUid) {
  const uid = String(lineUid || "").trim();
  if (!uid) return "";
  const binding = await safeGetKV(env, `LINE_BIND_${uid}`, null, { preferWasabi: false });
  if (binding?.legacyUserId) return String(binding.legacyUserId).trim();
  return uid;
}

async function appendLineMonitorEvent(env, ctx, event) {
  const lineUid = String(event?.source?.userId || "").trim();
  if (!lineUid) return;
  const text = lineEventMessageText(event);
  if (!text) return;
  await ensureLineOnlyCrmMember(env, ctx, lineUid, null, "line_monitor_event").catch(() => {});
  const threadId = await resolveMonitorThreadIdForLine(env, lineUid);
  if (!threadId) return;
  const nowIso = new Date().toISOString();
  await appendLineMonitorD1Event(env, event, threadId, text).catch(async error => {
    await safePutKV(env, "LINE_MONITOR_APPEND_ERROR_LAST", {
      lineUserId: lineUid,
      threadId,
      text: text.slice(0, 160),
      error: error?.message || String(error),
      occurredAt: nowIso,
    }, { expirationTtl: 86400 * 7 }).catch(() => {});
    console.error("[LineMonitor] D1 append failed", error);
  });
  const key = `MONITOR_THREAD_${threadId}`;
  const overlay = await safeGetKV(env, key, {});
  const lineMessages = Array.isArray(overlay.lineMessages) ? overlay.lineMessages : [];
  const createdAt = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
  const createdTs = Date.now();
  const nextMessage = {
    id: event?.message?.id || `${createdTs}_${Math.random().toString(36).slice(2)}`,
    type: "line",
    title: "LINE 訊息",
    text,
    lineUserId: lineUid,
    messageType: event?.message?.type || event?.type || "",
    createdAt,
    createdTs,
  };
  const next = {
    ...overlay,
    lineUserId: overlay.lineUserId || lineUid,
    lineMessages: [nextMessage, ...lineMessages.filter(item => item?.id !== nextMessage.id)].slice(0, 80),
    updatedAt: new Date().toISOString(),
    lastLineMessageAt: new Date().toISOString(),
  };
  await safePutKV(env, key, next);
  await safePutKV(env, "LINE_MONITOR_APPEND_LAST", {
    lineUserId: lineUid,
    threadId,
    text: text.slice(0, 160),
    appendedAt: nowIso,
  }, { expirationTtl: 86400 * 7 }).catch(() => {});
}

async function appendLineMonitorD1Event(env, event, threadId, text) {
  if (!env.DB) return;
  const lineUid = String(event?.source?.userId || "").trim();
  if (!lineUid || !threadId || !text) return;
  const messageType = String(event?.message?.type || event?.type || "text");
  const createdAt = event?.timestamp ? new Date(Number(event.timestamp)).toISOString() : new Date().toISOString();
  const profile = lineUid.startsWith("U") ? await fetchLineBotProfile(env, lineUid).catch(() => null) : null;
  const member = threadId !== lineUid ? await safeGetKV(env, `USER_${threadId}`, null).catch(() => null) : null;
  const displayName = profile?.displayName || member?.name || member?.displayName || lineUid;
  const pictureUrl = profile?.pictureUrl || member?.pictureUrl || "";
  const risk = /退款|取消|客訴|投訴|生氣|爛|差|退費|沒收到|不要/.test(text) ? "high" : "low";
  const tags = risk === "high" ? "LINE,高風險" : "LINE";
  await env.DB.prepare(`
    INSERT INTO line_threads (
      id, source_type, source_user_id, source_group_id, display_name, picture_url,
      status, risk_level, summary, unread_count, tags, legacy_user_id,
      last_message_at, created_at, updated_at
    ) VALUES (?, 'line_oa', ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_user_id = excluded.source_user_id,
      source_group_id = excluded.source_group_id,
      display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE line_threads.display_name END,
      picture_url = CASE WHEN excluded.picture_url <> '' THEN excluded.picture_url ELSE line_threads.picture_url END,
      status = CASE WHEN line_threads.status = 'closed' THEN line_threads.status ELSE 'open' END,
      risk_level = CASE WHEN line_threads.risk_level = 'high' OR excluded.risk_level = 'high' THEN 'high' ELSE line_threads.risk_level END,
      summary = excluded.summary,
      unread_count = line_threads.unread_count + 1,
      tags = CASE
        WHEN line_threads.tags = '' THEN excluded.tags
        WHEN excluded.tags = '' THEN line_threads.tags
        WHEN excluded.tags = 'LINE' AND instr(',' || line_threads.tags || ',', ',LINE,') > 0 THEN line_threads.tags
        WHEN excluded.tags = 'LINE,高風險' AND instr(',' || line_threads.tags || ',', ',高風險,') > 0 THEN line_threads.tags
        WHEN excluded.tags = 'LINE,高風險' AND instr(',' || line_threads.tags || ',', ',LINE,') > 0 THEN line_threads.tags || ',高風險'
        ELSE line_threads.tags || ',' || excluded.tags
      END,
      legacy_user_id = CASE WHEN excluded.legacy_user_id <> '' THEN excluded.legacy_user_id ELSE line_threads.legacy_user_id END,
      last_message_at = excluded.last_message_at,
      updated_at = excluded.updated_at
  `).bind(
    threadId,
    lineUid,
    String(event?.source?.groupId || event?.source?.roomId || ""),
    displayName,
    pictureUrl,
    risk,
    text.slice(0, 240),
    tags,
    threadId !== lineUid ? threadId : "",
    createdAt,
    createdAt,
    createdAt
  ).run();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO line_messages (
      id, thread_id, line_event_id, reply_token, message_type, sender_role,
      sender_id, sender_name, message_text, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    threadId,
    String(event?.webhookEventId || event?.message?.id || ""),
    String(event?.replyToken || ""),
    messageType,
    lineUid,
    displayName,
    text,
    JSON.stringify(event),
    createdAt
  ).run();
}

async function mergeLineMonitorThread(env, fromId, toId) {
  const sourceId = String(fromId || "").trim();
  const targetId = String(toId || "").trim();
  if (!sourceId || !targetId || sourceId === targetId) return;
  const fromKey = `MONITOR_THREAD_${sourceId}`;
  const toKey = `MONITOR_THREAD_${targetId}`;
  const source = await safeGetKV(env, fromKey, null);
  if (!source || !Array.isArray(source.lineMessages) || !source.lineMessages.length) return;
  const target = await safeGetKV(env, toKey, {});
  const byId = new Map();
  for (const msg of [...source.lineMessages, ...(Array.isArray(target.lineMessages) ? target.lineMessages : [])]) {
    if (msg?.id) byId.set(msg.id, msg);
  }
  const lineMessages = Array.from(byId.values())
    .sort((a, b) => Number(b.createdTs || 0) - Number(a.createdTs || 0))
    .slice(0, 80);
  await safePutKV(env, toKey, {
    ...target,
    lineMessages,
    lineUserId: target.lineUserId || source.lineUserId || sourceId,
    updatedAt: new Date().toISOString(),
    lastLineMessageAt: target.lastLineMessageAt || source.lastLineMessageAt || new Date().toISOString(),
  });
}

async function wasabiHeadObject(env, key) {
  const { res, key: objectKey } = await wasabiRequest(env, "HEAD", key);
  return {
    exists: true,
    key: objectKey,
    size: Number(res.headers.get("content-length") || 0),
    contentType: res.headers.get("content-type") || "",
    lastModified: res.headers.get("last-modified") || "",
  };
}

async function wasabiHealthCheck(env) {
  const testKey = `temp/health-${Date.now()}.txt`;
  const body = `wasabi-health ${new Date().toISOString()}`;
  const steps = [];
  try {
    const put = await wasabiRequest(env, "PUT", testKey, { body, contentType: "text/plain; charset=utf-8" });
    steps.push({ step: "PutObject", ok: true, key: put.key });
    const head = await wasabiHeadObject(env, testKey);
    steps.push({ step: "HeadObject", ok: true, size: head.size });
    const get = await wasabiRequest(env, "GET", testKey);
    steps.push({ step: "GetObject", ok: (await get.res.text()) === body });
    await wasabiRequest(env, "DELETE", testKey);
    steps.push({ step: "DeleteObject", ok: true });
    return { ok: true, steps };
  } catch (e) {
    steps.push({ step: "Error", ok: false, message: e.message });
    return { ok: false, steps };
  }
}

async function buildWasabiMigrationCheck(env) {
  const cfg = getWasabiConfig(env);
  const syncStatus = await getWasabiSyncStatus(env);
  const readEnabled = await shouldReadLowRiskFromWasabi(env);
  const highRiskReadEnabled = await shouldReadHighRiskFromWasabi(env);
  const highRiskLiveSources = {
    mode: highRiskReadEnabled ? "Wasabi 優先 / R2 live / KV fallback" : "R2 live 優先 / KV fallback",
    wasabiMode: highRiskReadEnabled ? "Wasabi 已作為高風險主讀取來源，仍保留 R2 live 與 KV fallback" : "Wasabi 快照與雙寫觀察，尚未作為主讀取來源",
    datasets: [
      { id: "users", label: "會員資料 USER_*", source: "R2 live / KV fallback" },
      { id: "points", label: "會員點數 POINTS_*", source: "R2 live / KV fallback" },
      { id: "point-ledger", label: "點數進出總表", source: "R2 live / KV fallback" },
      { id: "orders", label: "訂單資料", source: "R2 live / KV fallback" },
    ],
  };
  const datasets = [
    { id: "courses", label: "課程 / 預約服務", key: "data/courses.json", count: (await safeGetCourses(env, { preferWasabi: false })).length, risk: "中" },
    { id: "products", label: "商城商品", key: "data/products.json", count: (await safeGetProducts(env, { preferWasabi: false })).length, risk: "低" },
    { id: "videos", label: "影音資料", key: "data/videos.json", count: (await safeGetVideos(env, { preferWasabi: false })).length, risk: "低" },
    { id: "orders", label: "訂單資料", key: "data/orders.json", count: (await safeGetKV(env, "ORDERS", [], { preferWasabi: false })).length, risk: "高" },
    { id: "slots", label: "預約時段", key: "data/slots.json", count: (await safeGetKV(env, "SLOTS", [])).length, risk: "中" },
    { id: "settings", label: "系統設定", key: "data/system-settings.json", count: Object.keys(await safeGetKV(env, "SYSTEM_SETTINGS", {})).length, risk: "高" },
    { id: "point-ledger", label: "點數進出總表", key: "data/point-ledger.json", count: (await safeGetKV(env, "POINT_LEDGER", [], { preferWasabi: false })).length, risk: "最高" },
  ];
  const userList = await env.ACTION_DATA.list({ prefix: "USER_" });
  const pointList = await env.ACTION_DATA.list({ prefix: "POINTS_" });
  datasets.push({ id: "users", label: "會員資料 USER_*", key: "users/", count: userList.keys.length, risk: "最高" });
  datasets.push({ id: "points", label: "會員點數 POINTS_*", key: "points/", count: pointList.keys.length, risk: "最高" });
  for (const item of datasets) {
    item.currentSource = ["users", "points", "orders", "point-ledger"].includes(item.id)
      ? (highRiskReadEnabled ? "Wasabi / R2 live / KV fallback" : "R2 live / KV fallback")
      : ["courses", "products"].includes(item.id)
        ? (readEnabled ? "Wasabi 優先 / R2-KV fallback" : "R2/KV fallback")
        : "KV";
    item.targetKey = `${cfg.basePrefix}${item.key}`;
    if (cfg.configured && !item.key.endsWith("/")) {
      try {
        item.wasabi = await wasabiHeadObject(env, item.key);
      } catch {
        item.wasabi = { exists: false };
      }
    } else {
      item.wasabi = { exists: false };
    }
  }
  return {
    config: {
      configured: cfg.configured,
      bucket: cfg.bucket || "(未設定)",
      region: cfg.region || "(未設定)",
      endpoint: cfg.endpoint || "(未設定)",
      basePrefix: cfg.basePrefix || "(空)",
      accessKeyPresent: !!cfg.accessKeyId,
      secretKeyPresent: !!cfg.secretAccessKey,
      lowRiskReadEnabled: readEnabled,
      highRiskReadEnabled,
    },
    health: cfg.configured ? await wasabiHealthCheck(env) : { ok: false, steps: [{ step: "Config", ok: false, message: "缺少 Wasabi 環境變數" }] },
    datasets,
    syncStatus,
    sourceStatus: {
      lowRisk: {
        mode: readEnabled ? "Wasabi 優先 / R2-KV fallback" : "原來源優先 / Wasabi 只做雙寫快照",
        readEnabled,
      },
      highRisk: highRiskLiveSources,
      observation: {
        phase: (readEnabled || highRiskReadEnabled) ? "Wasabi 主讀取測試期" : "雙寫觀察期",
        dailyAcceptance: syncStatus.dailyAcceptance || null,
        recommendation: (syncStatus.dailyAcceptance?.success && readEnabled && highRiskReadEnabled)
          ? "目前可維持主讀取測試；建議連續多次每日總檢查通過後，再討論降低 KV 依賴。"
          : "尚未達到收尾條件；請先維持 R2/KV fallback 與每日總檢查。",
      },
    },
    nextSteps: [
      "先啟用雙寫，不切讀取來源",
      "低風險資料 courses/products/videos 先做匯出與 hash 比對",
      "orders/points/users 最後處理，且需保留 KV 回滾",
    ],
  };
}

const TEACHER_ALLOWED_ACTIONS = new Set([
  "ADMIN_GET_DATA",
  "ADMIN_GET_SLOTS",
  "ADMIN_BATCH_TOGGLE_SLOTS",
  "TEACHER_DEDUCT_POINTS",
  "TEACHER_GET_MY_REPORT",
  "TEACHER_COMPLETE_BOOKING",
]);

const CRM_LOGIN_ALLOWED_ACTIONS = new Set([
  "ADMIN_GET_DATA",
  "ADMIN_GET_SLOTS",
  "ADMIN_UPDATE_MEMBER",
]);

const HQ_ALLOWED_ACTIONS = new Set([
  "ADMIN_GET_DATA",
  "ADMIN_GET_SLOTS",
  "ADMIN_UPDATE_MEMBER",
  "ADMIN_UPDATE_COURSE",
  "ADMIN_DELETE_COURSE",
  "ADMIN_UPDATE_PRODUCT",
  "ADMIN_DELETE_PRODUCT",
  "ADMIN_UPDATE_ORDER",
  "ADMIN_TRANSFER_ORDER_COURSE",
  "ADMIN_GET_RICH_MENU_SAVES",
  "ADMIN_SAVE_RICH_MENU",
  "ADMIN_DELETE_RICH_MENU_SAVE",
  "UPLOAD_IMAGE",
]);

const CRM_SYSTEM_ALLOWED_ACTIONS = new Set([
  "ADMIN_GET_DATA",
  "ADMIN_GET_SLOTS",
  "ADMIN_MANAGE_POINTS",
  "GET_USER_POINTS",
  "UPLOAD_IMAGE",
  "DEPLOY_RICH_MENU",
  "ADMIN_GET_RICH_MENU_SAVES",
  "ADMIN_SAVE_RICH_MENU",
  "ADMIN_DELETE_RICH_MENU_SAVE",
]);

const DEFAULT_VIDEOS = [
  { id: "VOD_YOUCI_06", title: "有慈老師-6", teacher: "有慈老師", episode: 6, driveFileId: "1Bqdq32X0w6LUoND1KSQfQmSNvwEdjvth", isPublished: true, createdAt: "2026-05-16" },
  { id: "VOD_YIJIE_04", title: "依潔老師-4", teacher: "依潔老師", episode: 4, driveFileId: "17ZxOAH2IJ7MFg3w2bWnFs-foLUWzPsWB", isPublished: true, createdAt: "2026-05-10" },
  { id: "VOD_YOUCI_05", title: "有慈老師-5", teacher: "有慈老師", episode: 5, driveFileId: "1-LUKzr5vLqwb6dWLUV6k7ELYhq414Z3S", isPublished: true, createdAt: "2026-05-03" },
  { id: "VOD_YIJIE_03", title: "依潔老師-3", teacher: "依潔老師", episode: 3, driveFileId: "1TQiu6wYc7JB0X9zNmvprivXYNmKvYvbf", isPublished: true, createdAt: "2026-04-22" },
  { id: "VOD_YIJIE_02", title: "依潔老師-2", teacher: "依潔老師", episode: 2, driveFileId: "1XK-2VB61Xjnuw1meauPTOEsXKS_Az3gw", isPublished: true, createdAt: "2026-04-19" },
  { id: "VOD_YIJIE_01", title: "依潔老師-1", teacher: "依潔老師", episode: 1, driveFileId: "1qzg5xocWj-Jt1O3f8405uo9EYN9UwhEX", isPublished: true, createdAt: "2026-04-15" },
  { id: "VOD_YOUCI_04", title: "有慈老師-4", teacher: "有慈老師", episode: 4, driveFileId: "1EaP8DUf8E1zPtSg4bYs1RuXYJIe3MtD5", isPublished: true, createdAt: "2026-04-12" },
  { id: "VOD_YOUCI_03", title: "有慈老師-3", teacher: "有慈老師", episode: 3, driveFileId: "14O-77yVDj1kTfLUlruvAVKc-TW2UxEjK", isPublished: true, createdAt: "2026-04-12" },
  { id: "VOD_YOUCI_02", title: "有慈老師-2", teacher: "有慈老師", episode: 2, driveFileId: "1Dn8b3m-mRD313YKpcGWLC-9JxgVnCYD0", isPublished: true, createdAt: "2026-04-06" },
  { id: "VOD_YOUCI_01", title: "有慈老師-1", teacher: "有慈老師", episode: 1, driveFileId: "1YMkaXTwP40oNe1D5bYL8TORmum5jdlTt", isPublished: true, createdAt: "2026-04-05" },
];

const VERIFIED_USER_ACTIONS = new Set([
  "CHECK_USER",
  "GET_USER_POINTS",
  "GET_USER_ORDERS",
  "CREATE_BOOKING",
  "BIND_LEGACY_MEMBER",
  "REGISTER_USER",
  "DAILY_CHECKIN",
  "REGISTER",
  "BUY_PRODUCT",
  "GET_PAYMENT_PAYLOAD",
  "UPLOAD_IMAGE",
  "TEACHER_GET_MY_COURSES",
  "TEACHER_UPDATE_COURSE",
  "TEACHER_DELETE_COURSE",
  "TEACHER_DEDUCT_POINTS",
  "TEACHER_GET_MY_REPORT",
  "TEACHER_COMPLETE_BOOKING",
  "UPDATE_MY_ORDER",
  "CANCEL_MY_ORDER",
]);

function splitCsv(value) {
  return String(value || "")
    .split(/[\s,，;；]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function isTeacherRecord(userData) {
  if (!userData || typeof userData !== "object") return false;
  if (userData.isTeacher === true || userData.role === "teacher") return true;
  if (String(userData.memberTier || "").includes("導師")) return true;
  return !!(userData.config && typeof userData.config === "object");
}

function normalizeTeacherName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "");
}

function getCourseTitle(course) {
  return String(course?.name || course?.title || "").split("\n")[0].trim();
}

function courseBelongsToTeacher(course, teacherData, teacherUid) {
  if (!course) return false;
  const courseTeacherUid = String(course.teacherUid || course.teacher_user_id || "").trim();
  if (teacherUid && courseTeacherUid && courseTeacherUid === teacherUid) return true;
  const courseTeacherUids = Array.isArray(course.teacherUids) ? course.teacherUids.map(String) : [];
  if (teacherUid && courseTeacherUids.includes(String(teacherUid))) return true;
  const teacherName = normalizeTeacherName(teacherData?.name || teacherData?.displayName || "");
  const courseInstructor = normalizeTeacherName(course.instructor || course.teacher || course.teacherName || "");
  return !!teacherName && !!courseInstructor && teacherName === courseInstructor;
}

function getOrderCourseKey(order) {
  return String(order?.courseId || order?.courseName || order?.name || "").trim();
}

async function deductTeacherCommissionForOrder(env, ctx, order, operatorUid, operatorName = "", updatePointsFn) {
  if (!order || order.teacherCommissionDeductedAt) return order;
  const teacherUidForCommission = String(order.teacher?.userId || order.teacherUid || "").trim();
  if (!teacherUidForCommission) return order;
  const teacherForCommission = await safeGetKV(env, `USER_${teacherUidForCommission}`, null);
  const commissionRate = Math.max(0, Number(teacherForCommission?.config?.comm || 0));
  const baseAmount = Number(order.originalAmount || order.service?.price || order.teacherCollectAmount || order.amount || 0) || 0;
  const commissionPoints = Math.floor(baseAmount * commissionRate / 100);
  if (commissionPoints <= 0) return order;
  if (typeof updatePointsFn !== "function") return order;
  await updatePointsFn(env, ctx, teacherUidForCommission, -commissionPoints, `諮詢完成抽成：${order.courseName || order.service?.name || order.courseId || order.orderId}`, {
    source: "teacher_commission",
    operatorUid,
    operatorName,
    targetName: teacherForCommission?.name || order.teacher?.name || "",
  });
  return {
    ...order,
    teacherCommissionDeductedAt: new Date().toISOString(),
    teacherCommissionPoints: commissionPoints,
    teacherCommissionRate: commissionRate,
  };
}

function uniqueTeachers(users) {
  const teachersByName = new Map();
  for (const user of users.filter(isTeacherRecord)) {
    const name = normalizeTeacherName(user.name);
    const key = name || user.userId;
    if (!key) continue;
    const current = teachersByName.get(key);
    if (!current) {
      teachersByName.set(key, { ...user, teacherUids: user.userId ? [user.userId] : [] });
      continue;
    }
    if (user.userId && !current.teacherUids.includes(user.userId)) current.teacherUids.push(user.userId);
    current.avatar = current.avatar || user.avatar;
    current.pictureUrl = current.pictureUrl || user.pictureUrl;
    current.intro = current.intro || user.intro;
    current.adminNote = current.adminNote || user.adminNote;
  }
  return Array.from(teachersByName.values());
}

function normalizeProduct(raw, fallbackIndex = 0) {
  const source = raw && typeof raw === "object" ? raw : {};
  const code = String(source.code || source.productCode || source.sku || source["商品代碼"] || "").trim();
  const name = String(source.name || source.title || source.postTitle || source["內容標題"] || "").trim();
  const status = String(source.status || source.productStatus || source["商品狀態"] || "販賣中").trim();
  const numericPrice = Number(String(source.pointsPrice ?? source.pointPrice ?? source.price ?? source["點數"] ?? source["價格"] ?? 0).replace(/[^0-9.-]/g, "")) || 0;
  const regularPrice = Number(String(source.originalPrice ?? source.original_price ?? source.regularPrice ?? source.regular_price ?? source["原價"] ?? source.price ?? numericPrice).replace(/[^0-9.-]/g, "")) || 0;
  const idBase = String(source.id || source.postId || code || name || `product-${fallbackIndex + 1}`).trim();
  return {
    id: idBase.startsWith("PROD_") ? idBase : `PROD_${idBase.replace(/[^\w-]+/g, "_")}`,
    name,
    code,
    storeName: String(source.storeName || source.vendor || source["店家名稱"] || "").trim(),
    category: String(source.category || source.productCategory || source["商品分類"] || source["分類"] || "").trim(),
    subtitle: String(source.subtitle || source.shortDescription || source.summary || source["短描述"] || "").trim(),
    badge: String(source.badge || source.tag || source.label || source["標籤"] || "").trim(),
    status,
    price: Number(source.price ?? numericPrice) || numericPrice,
    originalPrice: regularPrice,
    pointsPrice: Number(source.pointsPrice ?? source.pointPrice ?? numericPrice) || 0,
    image: String(source.image || source.thumbnail || source.featuredImage || "").trim(),
    description: String(source.description || source.content || source.excerpt || "").trim(),
    sourceUrl: String(source.sourceUrl || source.editUrl || source.url || "").trim(),
    stock: source.stock === undefined || source.stock === null || source.stock === "" ? null : Number(source.stock),
    isPublished: source.isPublished === false ? false : true,
    source: String(source.source || "").trim(),
    updatedAt: new Date().toISOString(),
  };
}

function mergeProducts(existing, incoming, mode = "append") {
  const map = new Map();
  if (mode !== "replace") {
    for (const item of Array.isArray(existing) ? existing : []) {
      const p = normalizeProduct(item);
      if (p.name) map.set(p.code || p.id || p.name, p);
    }
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const p = normalizeProduct(item, map.size);
    if (!p.name) continue;
    const key = p.code || p.id || p.name;
    const old = map.get(key) || {};
    map.set(key, { ...old, ...p, createdAt: old.createdAt || new Date().toISOString() });
  }
  return Array.from(map.values());
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWpJson(siteUrl, path, authHeader) {
  const base = String(siteUrl || "").replace(/\/+$/, "");
  const url = `${base}${path}`;
  const res = await fetch(url, {
    headers: authHeader ? { Authorization: authHeader } : {},
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) {
    const message = data?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`${res.status} ${message}`);
  }
  return data;
}

async function importWpProduct(siteUrl, postId, authHeader) {
  const routes = [
    `/wp-json/wp/v2/linecard_21/${encodeURIComponent(postId)}?_embed=1&context=edit`,
    `/wp-json/wp/v2/linecard_21/${encodeURIComponent(postId)}?_embed=1`,
    `/wp-json/wp/v2/posts/${encodeURIComponent(postId)}?_embed=1&context=edit`,
  ];
  const errors = [];
  let post = null;
  for (const route of routes) {
    try {
      post = await fetchWpJson(siteUrl, route, authHeader);
      if (post) break;
    } catch (e) {
      errors.push(`${route}: ${e.message}`);
    }
  }
  if (!post) throw new Error(errors.join(" | "));

  const meta = post.meta || {};
  const acf = post.acf || {};
  const embeddedImage = post._embedded?.["wp:featuredmedia"]?.[0];
  const image = embeddedImage?.source_url || post.yoast_head_json?.og_image?.[0]?.url || "";
  const code = meta.product_code || meta.linecard_code || meta.sku || acf.product_code || acf.linecard_code || "";
  const status = meta.product_status || acf.product_status || "販賣中";
  const storeName = meta.store_name || meta.shop_name || acf.store_name || acf.shop_name || "HookTea";
  const price = Number(meta.points_price || meta.point_price || meta.price || acf.points_price || acf.point_price || acf.price || 0) || 0;

  return normalizeProduct({
    id: `PROD_wp_${post.id}`,
    postId: post.id,
    name: stripHtml(post.title?.rendered || post.title?.raw || post.slug || `WP 商品 ${postId}`),
    code,
    storeName,
    status,
    price,
    pointsPrice: price,
    image,
    description: stripHtml(post.content?.rendered || post.excerpt?.rendered || post.content?.raw || ""),
    sourceUrl: `${String(siteUrl).replace(/\/+$/, "")}/wp-admin/post.php?post=${post.id}&action=edit`,
    isPublished: true,
  });
}

async function importWpProductsFromActionEndpoint(siteUrl, postIds, authHeader) {
  const ids = postIds.map(id => String(id).trim()).filter(Boolean).join(",");
  if (!ids) return [];
  const data = await fetchWpJson(siteUrl, `/wp-json/action-import/v1/linecard-products?ids=${encodeURIComponent(ids)}`, authHeader);
  const list = Array.isArray(data?.products) ? data.products : (Array.isArray(data) ? data : []);
  return list.map((item, index) => normalizeProduct({
    id: item.id || item.postId || `PROD_wp_${item.post_id || index + 1}`,
    postId: item.postId || item.post_id || item.id,
    name: item.name || item.title,
    code: item.code || item.product_code,
    storeName: item.storeName || item.store_name || "HookTea",
    status: item.status || item.product_status || "販賣中",
    price: item.price || item.pointsPrice || item.points_price || 0,
    pointsPrice: item.pointsPrice || item.points_price || item.price || 0,
    image: item.image || item.featured_image || "",
    description: item.description || item.content || "",
    sourceUrl: item.sourceUrl || item.edit_url || "",
    isPublished: item.isPublished !== false,
  }));
}

async function listUserRecords(env) {
  const indexedUsers = await safeGetKV(env, "USERS_INDEX", []);
  if (Array.isArray(indexedUsers) && indexedUsers.length) return indexedUsers.filter(user => user && user.userId);

  const users = [];
  try {
    let listComplete = false;
    let cursor = null;
    while (!listComplete) {
      const options = { prefix: "USER_" };
      if (cursor) options.cursor = cursor;
      const list = await env.ACTION_DATA.list(options);
      const chunkSize = 20;
      for (let i = 0; i < list.keys.length; i += chunkSize) {
        const chunk = list.keys.slice(i, i + chunkSize);
        const chunkUsers = await Promise.all(chunk.map(async key => {
          const user = await safeGetKV(env, key.name, null);
          if (!user || !user.userId) return null;
          return key.name === `USER_${user.userId}` ? user : null;
        }));
        users.push(...chunkUsers.filter(Boolean));
      }
      listComplete = list.list_complete;
      cursor = list.cursor;
    }
  } catch (e) {
    console.error("[UserList] Failed to load user records", e);
  }
  return users;
}

function userScore(user) {
  return ["name", "phone", "memberTier", "pictureUrl", "updatedAt", "createdAt", "address", "birthday", "adminNote"]
    .reduce((score, key) => score + (user?.[key] ? 1 : 0), 0);
}

function uniqueUsersById(users) {
  const byId = new Map();
  for (const user of Array.isArray(users) ? users : []) {
    if (!user || !user.userId || user.userId === "GUEST") continue;
    const current = byId.get(user.userId);
    if (!current || userScore(user) >= userScore(current)) byId.set(user.userId, user);
  }
  return Array.from(byId.values());
}

function parsePointLogTime(value, fallback = 0) {
  if (!value) return fallback;
  const normalized = String(value).replace(/-/g, "/");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function taipeiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find(part => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function secondsUntilNextTaipeiMidnight(date = new Date()) {
  const taipeiNow = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const nextMidnight = new Date(taipeiNow);
  nextMidnight.setHours(24, 0, 0, 0);
  const seconds = Math.ceil((nextMidnight.getTime() - taipeiNow.getTime()) / 1000);
  return Math.max(60, seconds + 300);
}

async function appendPointsLedger(env, entry) {
  const ledger = await safeGetKV(env, "POINT_LEDGER", []);
  const list = Array.isArray(ledger) ? ledger : [];
  const next = [entry, ...list].slice(0, 5000);
  await safePutKV(env, "POINT_LEDGER", next);
}

async function appendPaymentLog(env, entry) {
  const logs = await safeGetKV(env, "PAYMENT_LOGS", [], { preferWasabi: false });
  const list = Array.isArray(logs) ? logs : [];
  const next = [entry, ...list].slice(0, 1000);
  await safePutKV(env, "PAYMENT_LOGS", next);
}

function shouldAuditAction(action, access) {
  if (!action) return false;
  if (action === "CHECK_USER") return !!(access?.isAdmin || access?.canCrmLogin || access?.isTeacher);
  if (action === "LOG_ADMIN_EVENT") return true;
  if (action === "ADMIN_GET_AUDIT_LOGS") return false;
  if (action.startsWith("TEACHER_")) return true;
  if (action === "UPLOAD_IMAGE" || action === "DEPLOY_RICH_MENU") return true;
  if (!action.startsWith("ADMIN_")) return false;
  return /_(UPDATE|DELETE|SAVE|MANAGE|IMPORT|SYNC|BATCH|APPROVE|REMOVE|TRANSFER|WASABI|DAILY|SEND|TAG|RECONCILE|GET_POINTS_LEDGER)/.test(action);
}

function summarizeAuditPayload(action, payload = {}) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (action === "LOG_ADMIN_EVENT") return String(p.message || p.view || "後台操作").slice(0, 180);
  if (action === "CHECK_USER") return "後台登入驗證";
  if (action === "ADMIN_UPDATE_MEMBER") return `更新會員 ${p.memberData?.name || p.memberData?.userId || ""}`.trim();
  if (action === "ADMIN_DELETE_MEMBER") return `隱藏會員 ${p.targetUid || ""}`.trim();
  if (action === "ADMIN_UPDATE_COURSE") return `儲存課程 ${String(p.name || p.id || "").split("\n")[0]}`.trim();
  if (action === "ADMIN_DELETE_COURSE") return `隱藏課程 ${p.courseId || ""}`.trim();
  if (action === "ADMIN_UPDATE_PRODUCT") return `儲存商品 ${p.name || p.code || p.id || ""}`.trim();
  if (action === "ADMIN_DELETE_PRODUCT") return `隱藏商品 ${p.productId || ""}`.trim();
  if (action === "ADMIN_SAVE_RICH_MENU") return `儲存圖文選單 ${p.name || p.id || ""}`.trim();
  if (action === "ADMIN_DELETE_RICH_MENU_SAVE") return `刪除圖文選單 ${p.id || ""}`.trim();
  if (action === "ADMIN_UPDATE_ORDER") return `更新訂單 ${p.orderId || ""}`.trim();
  if (action === "ADMIN_MANAGE_POINTS") return `調整點數 ${p.uid || ""} ${p.type || ""} ${p.amount || ""}`.trim();
  if (action === "ADMIN_RECONCILE_LOCAL_POINTS") return `校正本地點數 ${p.targetUid || p.uid || ""} -> ${p.targetBalance || ""}`.trim();
  if (action === "ADMIN_TAG_MEMBER") return `會員標籤 ${p.tagName || ""} ${p.userId || ""}`.trim();
  if (action === "ADMIN_SEND_PAID_BROADCAST") return `付費推播 ${p.title || ""}`.trim();
  if (action === "TEACHER_DEDUCT_POINTS") return `講師扣點 ${p.targetUid || p.studentName || ""} ${p.amount || ""}`.trim();
  return action.replace(/_/g, " ");
}

async function appendAuditLog(env, access, action, payload = {}, request = null) {
  try {
    const now = new Date();
    const userData = access?.userData || {};
    const lineProfile = access?.lineProfile || {};
    const role = access?.isAdmin ? "admin" : access?.canHeadquarter ? "headquarter" : access?.canCrmLogin ? "operator" : access?.isTeacher ? "teacher" : "user";
    const entry = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      uid: access?.userId || "GUEST",
      name: userData.name || userData.displayName || lineProfile.name || lineProfile.displayName || "",
      role,
      action,
      summary: summarizeAuditPayload(action, payload),
      view: payload?.view || "",
      targetUid: payload?.targetUid || payload?.memberData?.userId || payload?.uid || "",
      targetId: payload?.courseId || payload?.productId || payload?.orderId || payload?.id || "",
      createdAt: now.toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
      createdTs: now.getTime(),
      ip: request?.headers?.get("cf-connecting-ip") || "",
      userAgent: String(request?.headers?.get("user-agent") || "").slice(0, 180),
    };
    const logs = await safeGetKV(env, "AUDIT_LOGS", [], { preferWasabi: false });
    const next = [entry, ...(Array.isArray(logs) ? logs : [])].slice(0, 1200);
    await safePutKV(env, "AUDIT_LOGS", next);
  } catch (e) {
    console.error("[AuditLog] append failed", e);
  }
}

function normalizeAudienceTags(tags) {
  return (Array.isArray(tags) ? tags : []).map(tag => {
    if (typeof tag === "string") return { id: tag, name: tag, color: "#06C755", createdAt: "" };
    const name = String(tag?.name || tag?.id || "").trim();
    if (!name) return null;
    return {
      id: String(tag?.id || name).trim(),
      name,
      color: String(tag?.color || "#06C755").trim(),
      description: String(tag?.description || "").trim(),
      createdAt: tag?.createdAt || "",
    };
  }).filter(Boolean);
}

function normalizeMemberTagList(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\n,，、;；]/);
  return [...new Set(source.map(tag => String(tag || "").trim()).filter(Boolean))];
}

const TAIWAN_CITY_NAMES = [
  "\u81fa\u5317\u5e02", "\u53f0\u5317\u5e02", "\u65b0\u5317\u5e02", "\u6843\u5712\u5e02", "\u81fa\u4e2d\u5e02", "\u53f0\u4e2d\u5e02", "\u81fa\u5357\u5e02", "\u53f0\u5357\u5e02", "\u9ad8\u96c4\u5e02",
  "\u57fa\u9686\u5e02", "\u65b0\u7af9\u5e02", "\u5609\u7fa9\u5e02", "\u65b0\u7af9\u7e23", "\u82d7\u6817\u7e23", "\u5f70\u5316\u7e23", "\u5357\u6295\u7e23", "\u96f2\u6797\u7e23",
  "\u5609\u7fa9\u7e23", "\u5c4f\u6771\u7e23", "\u5b9c\u862d\u7e23", "\u82b1\u84ee\u7e23", "\u81fa\u6771\u7e23", "\u53f0\u6771\u7e23", "\u6f8e\u6e56\u7e23", "\u91d1\u9580\u7e23", "\u9023\u6c5f\u7e23"
];

function parseTaiwanShippingAddress(value) {
  let text = String(value || "").trim().replace(/\s+/g, "");
  const result = { postalCode: "", city: "", district: "", address: text };
  const postalMatch = text.match(/^(\d{3,6})/);
  if (postalMatch) {
    result.postalCode = postalMatch[1];
    text = text.slice(postalMatch[1].length);
  }
  const cities = [
    "臺北市", "台北市", "新北市", "桃園市", "臺中市", "台中市", "臺南市", "台南市", "高雄市",
    "基隆市", "新竹市", "嘉義市", "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣",
    "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "台東縣", "澎湖縣", "金門縣", "連江縣"
  ];
  const city = cities.find(name => text.startsWith(name));
  if (city) {
    result.city = city;
    text = text.slice(city.length);
  }
  const districtMatch = text.match(/^(.{1,8}?(?:區|鄉|鎮|市))/);
  if (districtMatch) {
    result.district = districtMatch[1];
    text = text.slice(districtMatch[1].length);
  }
  result.address = text || result.address;
  return result;
}

function registeredShippingFromMember(member) {
  const parsed = parseTaiwanShippingAddress(member?.shippingAddress || member?.address || "");
  const postalCode = String(member?.shippingPostalCode || member?.postalCode || member?.zip || parsed.postalCode || "").trim();
  const city = String(member?.shippingCity || member?.city || parsed.city || "").trim();
  const district = String(member?.shippingDistrict || member?.district || parsed.district || "").trim();
  const fullAddress = String(member?.shippingAddress || member?.address || "").trim();
  const address = String(member?.shippingStreet || member?.addressDetail || parsed.address || fullAddress || "").trim();
  return {
    name: String(member?.name || member?.displayName || member?.lineDisplayName || "").trim(),
    phone: normalizeMemberPhone(member?.phone || member?.mobile || member?.tel || member?.memberPhone || ""),
    email: String(member?.email || "").trim(),
    postalCode,
    city,
    district,
    address,
    missing: [],
  };
}

function missingShippingFields(customer) {
  const fields = [
    ["name", "姓名"],
    ["phone", "手機"],
    ["city", "縣市"],
    ["district", "區域 / 鄉鎮市"],
    ["address", "路名、巷弄、門牌、樓層"],
  ];
  return fields.filter(([key]) => !String(customer?.[key] || "").trim()).map(([, label]) => label);
}


function validateTaiwanMobilePhone(value) {
  const phone = normalizeMemberPhone(value);
  return { phone, valid: /^09\d{8}$/.test(phone) };
}

function validateHuaxuShippingCustomer(customer) {
  const data = customer || {};
  const errors = [];
  const phoneCheck = validateTaiwanMobilePhone(data.phone);
  const postalCode = String(data.postalCode || "").trim();
  const city = String(data.city || "").trim();
  const district = String(data.district || "").trim();
  const address = String(data.address || "").trim();
  const compactAddress = address.replace(/\s+/g, "");
  const parsedFull = parseTaiwanShippingAddress([postalCode, city, district, address].filter(Boolean).join(""));
  const resolvedCity = city || parsedFull.city;
  const resolvedDistrict = district || parsedFull.district;

  if (!phoneCheck.valid) errors.push("\u6536\u4ef6\u624b\u6a5f\u9700\u70ba 09 \u958b\u982d 10 \u78bc\u624b\u6a5f\u865f\u78bc");
  if (postalCode && !/^\d{3,6}$/.test(postalCode)) errors.push("\u90f5\u905e\u5340\u865f\u9700\u70ba 3-6 \u78bc\u6578\u5b57");
  if (!resolvedCity || !TAIWAN_CITY_NAMES.includes(resolvedCity)) errors.push("\u8acb\u586b\u5beb\u6b63\u78ba\u7e23\u5e02");
  if (!resolvedDistrict || !/^.{1,8}(?:\u5340|\u9109|\u93ae|\u5e02)$/.test(resolvedDistrict)) errors.push("\u8acb\u586b\u5beb\u6b63\u78ba\u5340\u57df / \u9109\u93ae\u5e02");
  if (compactAddress.length < 4) errors.push("\u8acb\u586b\u5beb\u5b8c\u6574\u8def\u540d\u3001\u5df7\u5f04\u3001\u9580\u724c\u6216\u4fe1\u7bb1");
  if (!/(?:\u8def|\u8857|\u5927\u9053|\u6bb5|\u5df7|\u5f04|\u6751|\u91cc|\u865f|\u53f7|\u6a13|\u5ba4|\u4fe1\u7bb1)/.test(compactAddress)) errors.push("\u5730\u5740\u9700\u5305\u542b\u8def\u8857\u3001\u5df7\u5f04\u3001\u9580\u724c\u6216\u4fe1\u7bb1\u7b49\u8a73\u7d30\u8cc7\u8a0a");
  if (!/(?:\d+.*(?:\u865f|\u53f7)|\d+.*\u4fe1\u7bb1|\d+\s*-\s*\d+)/.test(compactAddress)) errors.push("\u5730\u5740\u9700\u5305\u542b\u9580\u724c\u865f\u78bc\u6216\u4fe1\u7bb1\u865f\u78bc");

  return { ok: errors.length === 0, errors: [...new Set(errors)], phone: phoneCheck.phone, city: resolvedCity, district: resolvedDistrict, address };
}

function splitBroadcastTagList(raw) {
  if (Array.isArray(raw)) return raw.flatMap(item => splitBroadcastTagList(item));
  return String(raw || "").split(/[\n,，、;；]/).map(v => v.trim()).filter(Boolean);
}

function getUserBroadcastTags(user) {
  if (!user) return [];
  return [...new Set([
    ...splitBroadcastTagList(user.broadcastTags),
    ...splitBroadcastTagList(user.tags),
    ...splitBroadcastTagList(user.audienceTags),
    ...splitBroadcastTagList(user.memberTags),
    ...splitBroadcastTagList(user.crmTags),
  ])];
}

function audienceMatchesUser(user, audience = {}) {
  if (!user || user.isDeleted === true || !user.userId) return false;
  const selectedTags = Array.isArray(audience.tags)
    ? audience.tags.map(v => String(v || "").trim()).filter(Boolean)
    : String(audience.tag || "").trim() ? [String(audience.tag || "").trim()] : [];
  const tags = getUserBroadcastTags(user);
  if (selectedTags.length && !selectedTags.some(tag => tags.includes(tag))) return false;
  const gender = String(audience.gender || "").trim();
  if (gender && String(user.gender || "") !== gender) return false;
  const keyword = String(audience.keyword || "").trim().toLowerCase();
  if (keyword) {
    const haystack = [user.name, user.phone, user.industry, user.address, user.userId].map(v => String(v || "").toLowerCase()).join(" ");
    if (!haystack.includes(keyword)) return false;
  }
  return true;
}

function selectBroadcastAudience(users, audience = {}) {
  return uniqueUsersById(Array.isArray(users) ? users : []).filter(user => audienceMatchesUser(user, audience));
}

function normalizePaidBroadcastMessages(payload = {}) {
  const messages = [];
  const text = String(payload?.message || "").trim();
  if (text) messages.push({ type: "text", text: text.slice(0, 4900) });
  const moduleMessages = Array.isArray(payload?.moduleMessages) ? payload.moduleMessages : [];
  for (const raw of moduleMessages) {
    if (!raw || typeof raw !== "object") continue;
    const type = String(raw.type || "").trim().toLowerCase();
    if (!["text", "flex", "image", "video"].includes(type)) throw new Error(`不支援的 LINE 訊息類型：${type || "unknown"}`);
    if (type === "text") {
      const moduleText = String(raw.text || "").trim();
      if (!moduleText) throw new Error("文字模組缺少 text");
      messages.push({ type: "text", text: moduleText.slice(0, 4900) });
      continue;
    }
    if (type === "flex") {
      if (!raw.contents) throw new Error("FLEX 模組缺少 contents");
      messages.push({
        type: "flex",
        altText: String(raw.altText || "HookTea 推播").slice(0, 400),
        contents: raw.contents,
      });
      continue;
    }
    if (type === "image") {
      const originalContentUrl = String(raw.originalContentUrl || raw.url || "").trim();
      const previewImageUrl = String(raw.previewImageUrl || originalContentUrl).trim();
      if (!/^https:\/\//i.test(originalContentUrl) || !/^https:\/\//i.test(previewImageUrl)) throw new Error("圖片模組網址必須是 HTTPS");
      messages.push({ type: "image", originalContentUrl, previewImageUrl });
      continue;
    }
    if (type === "video") {
      const originalContentUrl = String(raw.originalContentUrl || raw.url || "").trim();
      const previewImageUrl = String(raw.previewImageUrl || raw.previewUrl || "").trim();
      if (!/^https:\/\//i.test(originalContentUrl) || !/^https:\/\//i.test(previewImageUrl)) throw new Error("影片模組網址與預覽圖必須是 HTTPS");
      messages.push({ type: "video", originalContentUrl, previewImageUrl });
    }
  }
  if (!messages.length) throw new Error("請輸入推播內容或選擇 FLEX 模組");
  if (messages.length > 5) throw new Error("LINE 單次最多只能推播 5 則訊息");
  return messages;
}

async function sendLineMulticast(env, recipients, messages) {
  const token = getLineChannelAccessToken(env);
  if (!token) throw new Error("Cloudflare 尚未綁定 LINE_CHANNEL_ACCESS_TOKEN 金鑰！");
  const ids = [...new Set((recipients || [])
    .map(user => String(user.lineUserId || user.linkedLineUid || user.lineUid || user.userId || "").trim())
    .filter(id => /^U[a-fA-F0-9]{32,}$/.test(id)))];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
  let sent = 0;
  const errors = [];
  for (const to of chunks) {
    const res = await fetch("https://api.line.me/v2/bot/message/multicast", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to, messages }),
    });
    if (res.ok) {
      sent += to.length;
    } else {
      const text = await res.text();
      errors.push(`HTTP ${res.status}: ${text.slice(0, 240)}`);
    }
  }
  return { sent, failed: ids.length - sent, total: ids.length, errors };
}

async function replyLineMessage(env, replyToken, messages) {
  const token = getLineChannelAccessToken(env);
  const lineReplyToken = String(replyToken || "").trim();
  if (!token || !lineReplyToken) return { ok: false, skipped: true };
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      replyToken: lineReplyToken,
      messages: Array.isArray(messages) ? messages : [messages],
    }),
    signal: AbortSignal.timeout(4500),
  });
  if (!res.ok) return { ok: false, status: res.status, text: await res.text() };
  return { ok: true };
}

async function pushLineMessage(env, userId, messages) {
  const token = getLineChannelAccessToken(env);
  const to = String(userId || "").trim();
  if (!token || !to) return { ok: false, skipped: true };
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      to,
      messages: Array.isArray(messages) ? messages : [messages],
    }),
    signal: AbortSignal.timeout(4500),
  });
  if (!res.ok) return { ok: false, status: res.status, text: await res.text() };
  return { ok: true };
}

async function deliverLineMessage(env, userId, replyToken, messages) {
  const reply = await replyLineMessage(env, replyToken, messages);
  if (reply.ok) return { method: "reply", ...reply };
  const push = await pushLineMessage(env, userId, messages);
  return { method: "push", reply, push, ok: !!push.ok };
}

function textLineMessage(text) {
  return { type: "text", text: String(text || "").slice(0, 5000) };
}

function imageLineMessage(url) {
  const imageUrl = String(url || "").trim();
  return { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl };
}

function hookteaOrderStatusLabel(status) {
  const value = String(status || "").toUpperCase();
  if (value === "PENDING") return "\u5f85\u4ed8\u6b3e";
  if (value === "PAID") return "\u5df2\u4ed8\u6b3e";
  if (value === "PREPARING") return "\u5099\u8ca8\u4e2d";
  if (value === "SHIPPED") return "\u914d\u9001\u4e2d";
  if (value === "COMPLETED") return "\u5df2\u5b8c\u6210";
  if (value === "CANCELLED") return "\u5df2\u53d6\u6d88";
  if (value === "TRANSFERRED") return "\u5df2\u8f49\u8ab2";
  return status || "-";
}

function getOrderLineRecipient(order) {
  return [
    order?.lineProfile?.userId,
    order?.lineUserId,
    order?.linkedLineUid,
    order?.userId,
    order?.memberUid,
  ].map(value => String(value || "").trim()).find(value => /^U[a-zA-Z0-9]{20,}$/.test(value)) || "";
}

async function notifyOrderStatusChangeLine(env, order, beforeStatus, nextStatus) {
  const to = getOrderLineRecipient(order);
  if (!to) return { ok: false, skipped: true, reason: "missing_line_uid" };
  const lines = [
    "HookTea \u8a02\u55ae\u72c0\u614b\u66f4\u65b0",
    `\u55ae\u865f\uff1a${order.orderId || "-"}`,
    `\u72c0\u614b\uff1a${hookteaOrderStatusLabel(beforeStatus)} \u2192 ${hookteaOrderStatusLabel(nextStatus)}`,
    `\u5546\u54c1\uff1a${String(order.productName || order.courseName || order.name || "\u8a02\u55ae").split("\n")[0]}`,
  ];
  if (String(nextStatus || "").toUpperCase() === "SHIPPED") {
    lines.push(`\u7269\u6d41\uff1a${order.shippingCarrierName || order.shipping?.carrierName || "-"}`);
    if (order.trackingNumber || order.shipping?.trackingNumber) lines.push(`\u67e5\u8a62\u7de8\u865f\uff1a${order.trackingNumber || order.shipping?.trackingNumber}`);
    if (order.trackingUrl || order.shipping?.trackingUrl) lines.push(`\u67e5\u8a62\u9023\u7d50\uff1a${order.trackingUrl || order.shipping?.trackingUrl}`);
  }
  return pushLineMessage(env, to, textLineMessage(lines.join("\n")));
}
function buildReferralInviteUrl(liffId, refUid, lineUid) {
  const params = new URLSearchParams();
  if (refUid) params.set("ref", refUid);
  if (lineUid) params.set("lineRef", lineUid);
  params.set("source", "line_invite");
  params.set("v", "20260609d");
  return `https://liff.line.me/${encodeURIComponent(String(liffId || "2007674851-lQljb6Cm").trim())}?${params.toString()}`;
}

function buildReferralShareUrl(liffId, refUid, lineUid) {
  const inviteUrl = buildReferralInviteUrl(liffId, refUid, lineUid);
  const text = `邀請你加入 HookTea 會員：\n${inviteUrl}`;
  return `https://line.me/R/msg/text/?${encodeURIComponent(text)}`;
}

function referralShareFlexMessage(invite) {
  const inviteUrl = String(invite?.inviteUrl || "https://hooktea.fangwl591021.workers.dev/referral").slice(0, 1000);
  const shareUrl = String(invite?.shareUrl || inviteUrl).slice(0, 1000);
  const qrUrl = String(invite?.qrUrl || "").slice(0, 1000);
  return {
    type: "flex",
    altText: "HookTea 推薦好友",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "lg",
        contents: [
          { type: "text", text: "推薦好友加入會員", weight: "bold", size: "xl", align: "center", color: "#1f2937" },
          { type: "image", url: qrUrl, size: "full", aspectMode: "fit", aspectRatio: "1:1" },
          {
            type: "button",
            style: "primary",
            color: "#1f7bc6",
            height: "sm",
            action: { type: "uri", label: "分享給好友", uri: shareUrl }
          }
        ]
      }
    }
  };
}

async function buildHookTeaInvite(env, lineUid) {
  const uid = String(lineUid || "").trim();
  const memberUid = uid;
  const liffId = String(env.LIFF_ID || "2007674851-lQljb6Cm").trim();
  const baseUrl = String(env.PUBLIC_BASE_URL || "https://hooktea.fangwl591021.workers.dev").replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (memberUid) params.set("ref", memberUid);
  if (uid) params.set("lineRef", uid);
  params.set("source", "line_invite");
  params.set("v", "20260609d");
  const workerInviteUrl = `${baseUrl}/referral?${params.toString()}`;
  const liffInviteUrl = buildReferralInviteUrl(liffId, memberUid, uid);
  const inviteUrl = liffInviteUrl;
  const shareUrl = buildReferralShareUrl(liffId, memberUid, uid);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=18&data=${encodeURIComponent(liffInviteUrl)}`;
  return {
    memberUid,
    lineUid: uid,
    memberName: "",
    inviteUrl,
    workerInviteUrl,
    liffInviteUrl,
    shareUrl,
    qrUrl,
  };
}

function isReferralInviteKeyword(text) {
  const normalized = String(text || "").replace(/\s+/g, "").trim();
  return /^(推薦好友|分享好友|邀請好友|我的推薦|推薦連結|邀請連結|QR碼|QRCode|QR)$/i.test(normalized);
}

function isMotherSiteKeyword(text) {
  const normalized = String(text || "").replace(/\s+/g, "").trim();
  return /^(會員專區|會員中心|會員註冊|註冊|注册|加入會員|會員分享|分享好友|推薦好友|邀請好友|會員打卡|打卡)$/i.test(normalized);
}

function motherSiteKeywordType(text) {
  const normalized = String(text || "").replace(/\s+/g, "").trim();
  if (/^(會員打卡|打卡)$/i.test(normalized)) return "checkin";
  if (/^(會員分享|分享好友|推薦好友|邀請好友)$/i.test(normalized)) return "share";
  if (/^(會員註冊|註冊|注册|加入會員)$/i.test(normalized)) return "register";
  if (/^(會員專區|會員中心)$/i.test(normalized)) return "member_area";
  return "other";
}

function getMotherWebhookUrl(env, settings = {}) {
  return String(
    env.FORWARD_WEBHOOK_URL ||
    env.SECOND_WEBHOOK_URL ||
    settings.second_webhook_url ||
    "https://aiwe.cc/index.php/line_login/9890/"
  ).trim();
}

function isPlainMotherWebhookAck(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  return /^(OK|SUCCESS|TRUE|1)$/i.test(value);
}

function escapeTelegramHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getTelegramNotifyConfig(env, settings = {}) {
  return {
    token: String(env.TELEGRAM_BOT_TOKEN || env.TG_BOT_TOKEN || settings.telegram_bot_token || settings.tg_bot_token || "").trim(),
    chatId: String(env.TELEGRAM_CHAT_ID || env.TG_CHAT_ID || settings.telegram_chat_id || settings.tg_chat_id || "").trim(),
  };
}

async function sendTelegramNotification(env, text, settings = null) {
  const sets = settings || await safeGetKV(env, "SYSTEM_SETTINGS", {}).catch(() => ({}));
  const { token, chatId } = getTelegramNotifyConfig(env, sets);
  if (!token || !chatId) return { ok: false, skipped: true, reason: "telegram_not_configured" };
  try {
    const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text || "").slice(0, 3900),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const responseText = await res.text().catch(() => "");
    const result = { ok: res.ok, status: res.status, response: responseText.slice(0, 300), sentAt: new Date().toISOString() };
    await safePutKV(env, "TELEGRAM_NOTIFY_LAST", { ...result, text: String(text || "").slice(0, 500) }, { expirationTtl: 86400 * 7 }).catch(() => {});
    return result;
  } catch (error) {
    const result = { ok: false, error: error?.message || String(error), sentAt: new Date().toISOString() };
    await safePutKV(env, "TELEGRAM_NOTIFY_LAST", { ...result, text: String(text || "").slice(0, 500) }, { expirationTtl: 86400 * 7 }).catch(() => {});
    return result;
  }
}
async function ensureFastLineCheckinMember(env, ctx, lineUid, profile = null, source = "mother_keyword_checkin_fast") {
  const uid = String(lineUid || "").trim();
  if (!uid || !uid.startsWith("U")) return { memberUid: "", member: null };
  const binding = await safeGetKV(env, `LINE_BIND_${uid}`, null, { preferWasabi: false }).catch(() => null);
  const candidateIds = [binding?.legacyUserId, uid].map(value => String(value || "").trim()).filter(Boolean);
  for (const candidateId of candidateIds) {
    const member = await safeGetKV(env, `USER_${candidateId}`, null).catch(() => null);
    if (member && (member.userId || candidateId)) return { memberUid: member.userId || candidateId, member, binding };
  }
  let lineProfile = profile;
  if (!lineProfile || (!lineProfile.displayName && !lineProfile.name && !lineProfile.pictureUrl && !lineProfile.picture)) {
    lineProfile = await fetchLineBotProfile(env, uid).catch(() => profile || {});
  }
  const displayName = String(lineProfile?.displayName || lineProfile?.name || uid).trim();
  const pictureUrl = String(lineProfile?.pictureUrl || lineProfile?.picture || "").trim();
  const now = new Date();
  const member = {
    userId: uid,
    legacyMemberId: "",
    lineUserId: uid,
    linkedLineUid: uid,
    lineDisplayName: displayName,
    name: displayName,
    displayName,
    pictureUrl,
    phone: "",
    mobile: "",
    tel: "",
    memberTier: "\u4e00\u822c\u6703\u54e1",
    crmBindingStatus: "LINE_ONLY_PENDING_LEGACY",
    bindingStatus: "LINE \u5f85\u7d81\u5b9a",
    source,
    createdAt: now.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }),
    updatedAt: now.toISOString(),
  };
  await putUserKV(env, ctx, uid, member);
  return { memberUid: uid, member, binding: null };
}

async function ensureCrmMemberWithAiMatch(env, ctx, lineUid, source = "mother_keyword_fallback") {
  const uid = String(lineUid || "").trim();
  if (!uid) return { memberUid: "", member: null, candidates: [], review: null, profile: null };
  const existing = await findHuaxuMemberByLineUid(env, uid).catch(() => ({ memberUid: uid, member: null }));
  if (existing?.member) return { ...existing, candidates: [], review: null, profile: null };
  const profile = await fetchLineBotProfile(env, uid).catch(() => ({}));
  const lineName = String(profile?.displayName || profile?.name || "").trim();
  const candidates = lineName ? await findLegacyMemberCandidates(env, { lineName }).catch(() => []) : [];
  const member = await ensureLineOnlyCrmMember(env, ctx, uid, profile, source);
  let review = null;
  if (candidates.length) {
    review = await createLineBindReviewCase(env, ctx, {
      lineUserId: uid,
      lineDisplayName: lineName,
      linePictureUrl: String(profile?.pictureUrl || profile?.picture || "").trim(),
      providedName: lineName,
      reason: "mother_keyword_ai_candidates",
      candidates,
    }).catch(() => null);
  }
  await safePutKV(env, `CRM_AI_MATCH_LAST_${uid}`, {
    lineUserId: uid,
    lineDisplayName: lineName,
    source,
    candidateCount: candidates.length,
    reviewId: review?.id || "",
    updatedAt: new Date().toISOString(),
  }, { expirationTtl: 86400 * 14 }).catch(() => {});
  return { memberUid: member?.userId || uid, member, candidates, review, profile };
}

async function buildMemberAreaLineMessage(env, lineUid, member = null) {
  const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
  const config = await getHuaxuShopConfig(env);
  const liffId = String(config.shopLiffId || settings.shop_liff_id || env.SHOP_LIFF_ID || "2007674851-ijenzSk8").trim();
  const params = new URLSearchParams();
  params.set("open", "member");
  params.set("source", "line_member_area");
  if (lineUid) params.set("lineUid", lineUid);
  const memberUrl = `https://liff.line.me/${encodeURIComponent(liffId)}?${params.toString()}`;
  const name = String(member?.name || member?.displayName || member?.lineDisplayName || "LINE 會員").slice(0, 40);
  return {
    type: "flex",
    altText: "HookTea 會員專區",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "HookTea 會員專區", weight: "bold", size: "xl", color: "#111827" },
          { type: "text", text: name, size: "sm", color: "#64748b", wrap: true },
          { type: "text", text: "可查看點數記錄、會員資料、推薦成果與每日打卡。", size: "sm", color: "#334155", wrap: true }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "button", style: "primary", color: "#06C755", action: { type: "uri", label: "開啟會員專區", uri: memberUrl } }
        ]
      }
    }
  };
}

async function handleMotherKeywordFallback(env, ctx, api, event, reason = "fallback") {
  const lineUid = String(event?.source?.userId || "").trim();
  const replyToken = event?.replyToken || "";
  const keyword = String(event?.message?.text || "").trim();
  const keywordType = motherSiteKeywordType(keyword);
  if (!lineUid || !replyToken) return { ok: false, skipped: true, reason: "missing_line" };
  let matched = { memberUid: lineUid, member: null, candidates: [], review: null, profile: null };
  if (keywordType === "checkin") {
    matched = await ensureFastLineCheckinMember(env, ctx, lineUid, null, `mother_keyword_${keywordType}_${reason}`);
    if (ctx) ctx.waitUntil(ensureCrmMemberWithAiMatch(env, ctx, lineUid, `mother_keyword_${keywordType}_ai_background`).catch(error => console.error("Mother keyword AI match background error:", error)));
  } else {
    matched = await ensureCrmMemberWithAiMatch(env, ctx, lineUid, `mother_keyword_${keywordType}_${reason}`);
  }
  const memberUid = matched.memberUid || lineUid;
  const member = matched.member || null;
  let messages = [];
  let addedPoints = 0;
  if (keywordType === "member_area") {
    messages = [await buildMemberAreaLineMessage(env, lineUid, member)];
  } else if (keywordType === "checkin") {
    const dateKey = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
    const checkinKey = `CHECKIN_${lineUid}_${dateKey}`;
    const existingCheckin = await safeGetKV(env, checkinKey, null).catch(() => null);
    if (!existingCheckin?.localMirrored) {
      await api.updatePoints(env, null, memberUid, 1, "會員打卡 CRM fallback", { source: "mother_keyword_crm_fallback" });
      addedPoints = 1;
      await safePutKV(env, checkinKey, {
        lineUserId: lineUid,
        memberUid,
        keyword,
        localMirrored: true,
        mirroredAt: new Date().toISOString(),
        source: "mother_keyword_crm_fallback",
      }, { expirationTtl: 86400 * 45 }).catch(() => {});
    }
    const points = await safeGetKV(env, `POINTS_${memberUid}`, { balance: 0, logs: [] }).catch(() => ({ balance: 0 }));
    messages = [textLineMessage(addedPoints
      ? `👍 恭喜您完成會員打卡\n⭐ 打卡贈點 1 點\n💰 目前點數：${Number(points.balance || 0)} 點`
      : `今天已完成會員打卡。\n💰 目前點數：${Number(points.balance || 0)} 點`
    )];
  } else {
    messages = [textLineMessage("已收到您的會員指令，系統正在協助您連結會員資料。")];
  }
  const reply = await deliverLineMessage(env, lineUid, replyToken, messages).catch(error => ({ ok: false, error: error?.message || String(error) }));
  await safePutKV(env, `MOTHER_KEYWORD_FALLBACK_LAST_${lineUid}`, {
    lineUserId: lineUid,
    memberUid,
    keyword,
    keywordType,
    reason,
    addedPoints,
    candidateCount: matched.candidates?.length || 0,
    reviewId: matched.review?.id || "",
    reply,
    updatedAt: new Date().toISOString(),
  }, { expirationTtl: 86400 * 14 }).catch(() => {});
  return { ok: !!reply?.ok, reply, addedPoints };
}

async function handleLineReferralInviteText(env, ctx, event) {
  const uid = String(event?.source?.userId || "").trim();
  const replyToken = event?.replyToken || "";
  const text = String(event?.message?.text || "").trim();
  if (!uid || !replyToken || !isReferralInviteKeyword(text)) return false;
  const startedAt = new Date().toISOString();
  await safePutKV(env, `REFERRAL_INVITE_DEBUG_${uid}`, { step: "start", keyword: text, startedAt }, { expirationTtl: 86400 }).catch(() => {});
  let invite = null;
  let reply = null;
  let imagePush = null;
  try {
    invite = await buildHookTeaInvite(env, uid);
    await safePutKV(env, `REFERRAL_INVITE_${uid}`, {
      ...invite,
      keyword: text,
      updatedAt: new Date().toISOString(),
    }, { expirationTtl: 86400 * 30 }).catch(() => {});
    await safePutKV(env, `REFERRAL_INVITE_LAST_${uid}`, { ...invite, keyword: text, step: "generated", updatedAt: new Date().toISOString() }, { expirationTtl: 86400 * 7 }).catch(() => {});
    reply = await deliverLineMessage(env, uid, replyToken, [
      referralShareFlexMessage(invite)
    ]);
  } catch (error) {
    const fallbackUrl = buildReferralInviteUrl("2007674851-lQljb6Cm", uid, uid);
    const fallbackQr = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=18&data=${encodeURIComponent(fallbackUrl)}`;
    invite = { lineUid: uid, memberUid: uid, inviteUrl: fallbackUrl, shareUrl: buildReferralShareUrl("2007674851-lQljb6Cm", uid, uid), qrUrl: fallbackQr, error: error.message || String(error) };
    reply = await deliverLineMessage(env, uid, replyToken, [
      referralShareFlexMessage(invite)
    ]).catch(replyError => ({ ok: false, error: replyError.message || String(replyError) }));
  }
  await safePutKV(env, `REFERRAL_INVITE_LAST_${uid}`, { ...invite, keyword: text, reply, imagePush, updatedAt: new Date().toISOString() }, { expirationTtl: 86400 * 7 }).catch(() => {});
  return true;
}

function extractTaiwanPhone(text) {
  const digits = normalizeMemberPhone(text);
  return /^09\d{8}$/.test(digits) ? digits : "";
}

function extractBindNameText(text) {
  const value = normalizeBindName(text);
  if (!value || extractTaiwanPhone(value)) return "";
  if (/^(綁定會員|會員綁定|綁定點數|我的點數|推薦好友|會員打卡)$/i.test(value)) return "";
  if (value.length < 2 || value.length > 30) return "";
  return value;
}

async function handleLineMemberBindText(env, ctx, event) {
  const uid = String(event?.source?.userId || "").trim();
  const replyToken = event?.replyToken || "";
  const text = String(event?.message?.text || "").trim();
  if (!uid || !replyToken || !text) return false;
  if (await handleLineReferralInviteText(env, ctx, event)) return true;
  const pendingKey = `LINE_BIND_PENDING_${uid}`;
  const debugKey = `LINE_BIND_DEBUG_${uid}`;
  const binding = await safeGetKV(env, `LINE_BIND_${uid}`, null, { preferWasabi: false });
  if (binding?.legacyUserId && /^(綁定會員|會員綁定|綁定點數|我的點數)$/.test(text)) {
    const member = await safeGetKV(env, `USER_${binding.legacyUserId}`, {});
    const points = await safeGetKV(env, `POINTS_${binding.legacyUserId}`, { balance: 0, logs: [] });
    const reply = await deliverLineMessage(env, uid, replyToken, textLineMessage(`已綁定會員：${member.name || member.displayName || binding.legacyUserId}\n目前點數：${Number(points.balance || 0)} 點`));
    await safePutKV(env, debugKey, { step: "already_bound", text, reply, updatedAt: new Date().toISOString() }, { expirationTtl: 86400 });
    return true;
  }

  const directMatch = text.match(/^(綁定會員|會員綁定|綁定點數)\s*[:：]?\s*(.+)$/);
  const pending = await safeGetKV(env, pendingKey, null, { preferWasabi: false });
  const directPhone = directMatch ? extractTaiwanPhone(directMatch[2]) : "";
  const pendingPhone = pending ? extractTaiwanPhone(text) : "";
  const directName = directMatch && !directPhone ? extractBindNameText(directMatch[2]) : "";
  const pendingName = pending && !pendingPhone ? extractBindNameText(text) : "";
  if (/^(綁定會員|會員綁定|綁定點數)$/.test(text)) {
    await safePutKV(env, pendingKey, { step: "ask_identity", startedAt: new Date().toISOString() }, { expirationTtl: 1800 });
    const reply = await deliverLineMessage(env, uid, replyToken, textLineMessage("我來協助您找回舊會員資料。\n\n請先回覆手機號碼，例如：0912345678。\n如果舊會員沒有留電話，請回覆：姓名 王小明。\n\n我會先整理候選資料，資料不夠明確時會送後台人工確認。"));
    await safePutKV(env, debugKey, { step: "prompt_identity", text, reply, tokenConfigured: !!getLineChannelAccessToken(env), updatedAt: new Date().toISOString() }, { expirationTtl: 86400 });
    return true;
  }
  const phone = directPhone || pendingPhone;
  const providedName = directName || pendingName;
  if (!phone && !providedName) return false;

  let profile = null;
  let result = null;
  try {
    profile = await fetchLineBotProfile(env, uid);
    if (!phone && providedName) {
      const candidates = await findLegacyMemberCandidates(env, { name: providedName, lineName: profile?.displayName || "" });
      const review = await createLineBindReviewCase(env, ctx, {
        lineUserId: uid,
        lineDisplayName: profile?.displayName || "",
        linePictureUrl: profile?.pictureUrl || "",
        providedName,
        reason: candidates.length ? "name_candidates" : "name_no_match",
        candidates,
      });
      await safePutKV(env, pendingKey, { step: "review_created", reviewId: review?.id || "", providedName, updatedAt: new Date().toISOString() }, { expirationTtl: 86400 });
      const candidateText = candidates.length
        ? `我找到 ${candidates.length} 筆可能的舊會員資料，已送後台人工確認。`
        : "目前沒有找到明確舊會員資料，已送後台人工確認。";
      const reply = await deliverLineMessage(env, uid, replyToken, textLineMessage(`${candidateText}\n\n請稍候店家確認後，系統會把您的 LINE 身分與舊會員資料綁定。`));
      await safePutKV(env, debugKey, { step: "bind_review_by_name", text, providedName, reviewId: review?.id || "", candidates: candidates.length, reply, tokenConfigured: !!getLineChannelAccessToken(env), updatedAt: new Date().toISOString() }, { expirationTtl: 86400 });
      return true;
    }
    result = await bindLegacyMemberToLine(env, ctx, uid, { phone, name: profile?.displayName || "" }, { name: profile?.displayName || "", picture: profile?.pictureUrl || "" });
  } catch (err) {
    const reply = await deliverLineMessage(env, uid, replyToken, textLineMessage("綁定時發生錯誤，請稍後再試或洽店家協助。"));
    await safePutKV(env, debugKey, { step: "bind_exception", text, phone, error: err.message || String(err), reply, tokenConfigured: !!getLineChannelAccessToken(env), updatedAt: new Date().toISOString() }, { expirationTtl: 86400 });
    return true;
  }
  if (!result.bound) {
    if (result.reason === "not_found" || result.reason === "missing_phone") {
      await safePutKV(env, pendingKey, { step: "ask_name", phone, updatedAt: new Date().toISOString() }, { expirationTtl: 1800 });
      const candidates = await findLegacyMemberCandidates(env, { phone, lineName: profile?.displayName || "" }).catch(() => []);
      if (candidates.length) {
        await createLineBindReviewCase(env, ctx, {
          lineUserId: uid,
          lineDisplayName: profile?.displayName || "",
          linePictureUrl: profile?.pictureUrl || "",
          providedPhone: phone,
          reason: "phone_review_candidates",
          candidates,
        });
      }
      const reply = await deliverLineMessage(env, uid, replyToken, textLineMessage("這支手機沒有直接命中舊會員資料。\n\n如果您是舊會員但當時沒有留電話，請回覆：姓名 您的舊會員姓名。\n例如：姓名 王小明\n\n我會幫您整理候選資料給後台確認。"));
      await safePutKV(env, debugKey, { step: "ask_name_after_phone_failed", text, phone, reason: result.reason, candidates: candidates.length, reply, tokenConfigured: !!getLineChannelAccessToken(env), updatedAt: new Date().toISOString() }, { expirationTtl: 86400 });
      return true;
    }
    const reasonText = result.reason === "not_found"
      ? "找不到這支手機的舊會員資料。"
      : result.reason === "duplicate_phone"
        ? "這支手機對到多筆舊會員，請洽店家協助人工確認。"
        : "目前無法完成綁定。";
    const reply = await deliverLineMessage(env, uid, replyToken, textLineMessage(`${reasonText}\n請確認手機號碼是否與舊系統會員資料相同。`));
    await safePutKV(env, debugKey, { step: "bind_failed", text, phone, reason: result.reason, matches: result.matches || 0, reply, tokenConfigured: !!getLineChannelAccessToken(env), updatedAt: new Date().toISOString() }, { expirationTtl: 86400 });
    return true;
  }
  await env.ACTION_DATA.delete(pendingKey).catch(() => {});
  const points = await safeGetKV(env, `POINTS_${result.userId}`, { balance: 0, logs: [] });
  const reply = await deliverLineMessage(env, uid, replyToken, textLineMessage(`綁定成功！\n會員：${result.member.name || result.member.displayName || result.userId}\n目前點數：${Number(points.balance || 0)} 點`));
  await safePutKV(env, debugKey, { step: "bind_success", text, phone, legacyUserId: result.userId, reply, tokenConfigured: !!getLineChannelAccessToken(env), updatedAt: new Date().toISOString() }, { expirationTtl: 86400 });
  return true;
}

async function buildPointLedgerFromCurrentLogs(env, users = []) {
  const userMap = new Map((Array.isArray(users) ? users : []).map(user => [user.userId, user]));
  const entries = [];
  try {
    let listComplete = false;
    let cursor = null;
    while (!listComplete) {
      const options = { prefix: "POINTS_" };
      if (cursor) options.cursor = cursor;
      const list = await env.ACTION_DATA.list(options);
      for (const key of list.keys) {
        const uid = key.name.replace(/^POINTS_/, "");
        const data = await safeGetKV(env, key.name, { logs: [] });
        const logs = Array.isArray(data?.logs) ? data.logs : [];
        logs.forEach((log, index) => {
          const points = Math.abs(Number(log.amount || 0));
          const type = log.type || (Number(log.amount || 0) < 0 ? "SPEND" : "EARN");
          const signedAmount = type === "SPEND" ? -points : points;
          const createdTs = parsePointLogTime(log.createdAt, Number(log.logId) || 0);
          entries.push({
            logId: log.logId || `${uid}_${createdTs}_${index}`,
            uid,
            userName: userMap.get(uid)?.name || "",
            phone: userMap.get(uid)?.phone || "",
            memberTier: userMap.get(uid)?.memberTier || "",
            type,
            amount: signedAmount,
            points,
            reason: log.reason || "",
            balanceAfter: null,
            createdAt: log.createdAt || "",
            createdTs,
            source: "legacy_user_log"
          });
        });
      }
      listComplete = list.list_complete;
      cursor = list.cursor;
    }
  } catch (e) {
    console.error("[PointsLedger] Failed to rebuild from user logs", e);
  }
  return entries;
}

async function getPointsLedger(env, limit = 50, options = {}) {
  const maxRows = Math.max(1, Math.min(Number(limit) || 50, 2000));
  const stored = await safeGetKV(env, "POINT_LEDGER", []);
  const storedList = Array.isArray(stored) ? stored : [];
  let userMap = new Map();
  let legacy = [];
  if (options.includeLegacy === true) {
    const users = uniqueUsersById(await listUserRecords(env));
    userMap = new Map(users.map(user => [user.userId, user]));
    legacy = await buildPointLedgerFromCurrentLogs(env, users);
  } else {
    const uids = [...new Set(storedList.slice(0, maxRows).map(entry => String(entry?.uid || "").trim()).filter(Boolean))].slice(0, 200);
    const users = await Promise.all(uids.map(async uid => await safeGetKV(env, `USER_${uid}`, null)));
    userMap = new Map(users.filter(user => user && user.userId).map(user => [user.userId, user]));
  }
  const byKey = new Map();

  for (const entry of [...storedList, ...legacy]) {
    if (!entry || !entry.uid) continue;
    const amount = Number(entry.amount || 0);
    const points = Math.abs(amount || Number(entry.points || 0));
    const user = userMap.get(entry.uid) || {};
    const createdTs = Number(entry.createdTs || parsePointLogTime(entry.createdAt, Number(entry.logId) || 0));
    const key = `${entry.uid}_${entry.logId || ""}_${entry.reason || ""}_${amount}_${createdTs}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      ...entry,
      userName: entry.userName || entry.targetName || user.name || user.displayName || "",
      phone: entry.phone || user.phone || "",
      memberTier: entry.memberTier || user.memberTier || "",
      pictureUrl: entry.pictureUrl || user.pictureUrl || user.avatar || "",
      operatorName: entry.operatorName || "",
      operatorUid: entry.operatorUid || "",
      amount,
      points,
      type: entry.type || (amount < 0 ? "SPEND" : "EARN"),
      createdTs
    });
  }

  return Array.from(byKey.values())
    .sort((a, b) => (Number(b.createdTs || 0) - Number(a.createdTs || 0)))
    .slice(0, maxRows);
}

function getWpApiUrl(settings) {
  return String(settings?.wp_api_url || settings?.wp_endpoint || settings?.wordpress_api_url || "").trim();
}

const WETW_INSERT_POINT_URL = "https://aiwe.cc/index.php/wp-json/wetw-point/v1/insert-user-point";
const WETW_QUERY_POINT_URL = "https://aiwe.cc/index.php/wp-json/wetw-point/v1/query-user-point-list";

function getWetwPointUrl(settings, type, env = {}) {
  const explicit = type === "insert"
    ? (env?.WP_INSERT_POINT_URL || env?.WETW_INSERT_POINT_URL || settings?.wp_insert_point_url)
    : (env?.WP_QUERY_POINT_URL || env?.WETW_QUERY_POINT_URL || settings?.wp_query_point_url);
  return String(explicit || getWpApiUrl(settings) || (type === "insert" ? WETW_INSERT_POINT_URL : WETW_QUERY_POINT_URL)).trim();
}

function getWetwConfig(settings, env = {}) {
  const apiKey = String(env?.WP_API_KEY || env?.WETW_API_KEY || settings?.wp_api_key || settings?.wetw_api_key || "").trim();
  const shopId = Number(env?.WP_SHOP_ID || env?.WETW_SHOP_ID || settings?.wp_shop_id || settings?.wetw_shop_id || 0);
  const enabledFlag = String(env?.WP_SYNC_ENABLED || env?.WETW_SYNC_ENABLED || settings?.wp_sync_enabled || "").toLowerCase();
  return {
    enabled: enabledFlag === "true" || (!!apiKey && !!shopId),
    apiKey,
    shopId,
    pointType: String(env?.WP_POINT_TYPE || env?.WETW_POINT_TYPE || settings?.wp_point_type || settings?.wetw_point_type || "system_point").trim(),
  };
}

function getMemberLineUid(member, fallback = "") {
  const direct = member?.lineUserId || member?.linkedLineUid || member?.lineUid || member?.lineProfile?.userId || "";
  const userId = String(member?.userId || "").trim();
  return String(direct || (userId.startsWith("U") ? userId : "") || fallback || "").trim();
}

async function queryWetwPointList(settings, member, env = {}) {
  const cfg = getWetwConfig(settings, env);
  if (!cfg.enabled) return { ok: false, reason: "wp_disabled", message: "WordPress 點數同步目前未啟用。" };
  if (!cfg.apiKey || !cfg.shopId) return { ok: false, reason: "missing_credentials", message: "缺少 WordPress API Key 或 shop_id。" };
  const lineUid = getMemberLineUid(member);
  if (!lineUid) return { ok: false, reason: "missing_line_uid", message: "缺少 LINE UID，無法查詢共用點數。" };

  const res = await fetch(getWetwPointUrl(settings, "query", env), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: cfg.apiKey,
      LINE_user_id: lineUid,
      shop_id: cfg.shopId,
      point_type: cfg.pointType,
      page: 1,
      per_page: 100,
    }),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok || data?.success === false) {
    return { ok: false, reason: data?.code || "wp_query_failed", status: res.status, message: data?.message || `WordPress 查詢 API HTTP ${res.status}` };
  }
  const list = Array.isArray(data?.data?.list) ? data.data.list : [];
  const latestWithBalance = list.find(item => item?.point_balance !== undefined && item?.point_balance !== null);
  const balance = latestWithBalance
    ? Number(latestWithBalance.point_balance)
    : list.reduce((sum, item) => sum + (Number(item?.get_point) || 0), 0);
  return { ok: true, balance: Number.isFinite(balance) ? balance : 0, list, raw: data };
}

function buildPointDataFromWetw(sharedPointData, limit = 50) {
  return {
    balance: Number(sharedPointData?.balance || 0),
    logs: Array.isArray(sharedPointData?.list)
      ? sharedPointData.list.slice(0, limit).map(item => ({
        logId: item.id || "",
        amount: Math.abs(Number(item.get_point) || 0),
        reason: cleanPointReason(item.event_content || item.event_name || "母站點數異動", "母站點數異動"),
        createdAt: item.created_at || "",
        type: Number(item.get_point) >= 0 ? "EARN" : "SPEND",
      }))
      : [],
    source: "wetw",
  };
}

function cleanPointReason(reason, fallback = "點數異動") {
  const text = String(reason || "").trim();
  if (!text) return fallback;
  if (/^\?{4,}(\s*\d+)?$/.test(text) || /^\?{4,}\s*\d+/.test(text)) {
    const balance = text.match(/\d+/)?.[0] || "";
    return balance ? `校正手機母站顯示餘額 ${balance}` : "校正手機母站顯示餘額";
  }
  return text;
}

function cleanPointLogs(logs = [], limit = 50) {
  return (Array.isArray(logs) ? logs : []).slice(0, limit).map(log => ({
    ...log,
    reason: cleanPointReason(log?.reason, "點數異動"),
  }));
}

function resolveDisplayPointData(localPointData, sharedPointData, limit = 50) {
  const localData = {
    balance: Number(localPointData?.balance || 0),
    logs: cleanPointLogs(localPointData?.logs, limit),
    source: "local",
  };
  if (!sharedPointData?.ok) {
    return {
      ...localData,
      shared: { ok: false, reason: sharedPointData?.reason || "unavailable" },
    };
  }
  const wetwData = buildPointDataFromWetw(sharedPointData, limit);
  if (localData.balance > wetwData.balance) {
    return {
      ...localData,
      source: "local_ahead",
      shared: { ok: true, balance: wetwData.balance, count: Array.isArray(sharedPointData.list) ? sharedPointData.list.length : 0 },
    };
  }
  return {
    ...wetwData,
    shared: { ok: true, count: Array.isArray(sharedPointData.list) ? sharedPointData.list.length : 0 },
  };
}

async function insertWetwPoint(settings, uid, amount, reason, env = {}, member = null) {
  const cfg = getWetwConfig(settings, env);
  const lineUid = getMemberLineUid(member, String(uid || "").startsWith("U") ? uid : "");
  if (!cfg.enabled || !cfg.apiKey || !cfg.shopId || !lineUid || !amount) return { ok: false, skipped: true };
  const res = await fetch(getWetwPointUrl(settings, "insert", env), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: cfg.apiKey,
      LINE_user_id: lineUid,
      shop_id: cfg.shopId,
      event_name: amount >= 0 ? "HookTea 贈點" : "HookTea 扣點",
      event_content: reason || "HookTea 系統點數異動",
      point_type: cfg.pointType,
      get_point: amount,
      local_uid: uid,
      shop_user_lineid: "",
      child_shop_name: "",
      child_shop_renew: 0,
      shop_remark: "HookTea Cloudflare Worker",
    }),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok || data?.success === false) {
    return { ok: false, status: res.status, code: data?.code, message: data?.message || text.slice(0, 300) };
  }
  return { ok: true, data };
}

async function fetchWpLegacyPoints(settings, member) {
  const endpoint = getWpApiUrl(settings);
  if (!endpoint) return { ok: false, reason: "missing_endpoint", message: "缺少 WordPress API URL，無法確認外站點數。" };
  if (!settings?.wp_api_key || !settings?.wp_shop_id) {
    return { ok: false, reason: "missing_credentials", message: "缺少 WordPress API Key 或 shop_id。" };
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: settings.wp_api_key,
      shop_id: settings.wp_shop_id,
      userId: member?.userId,
      uid: member?.userId,
      phone: member?.phone || "",
      action: "GET_POINTS",
    }),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) return { ok: false, reason: "http_error", status: res.status, message: `WordPress API HTTP ${res.status}`, raw: text.slice(0, 300) };

  const candidates = [
    data?.balance,
    data?.points,
    data?.point,
    data?.data?.balance,
    data?.data?.points,
    data?.data?.point,
  ];
  const balance = Number(candidates.find(v => v !== undefined && v !== null));
  if (!Number.isFinite(balance)) return { ok: false, reason: "invalid_response", message: "WordPress API 有回應，但找不到點數欄位。", raw: text.slice(0, 300) };
  return { ok: true, balance, raw: data };
}

function deriveLineClientId(env, settings) {
  const candidates = [
    env.LINE_LOGIN_CHANNEL_ID,
    env.LINE_CHANNEL_ID,
    env.LIFF_CHANNEL_ID,
    settings?.line_login_channel_id,
    settings?.line_channel_id,
    settings?.liff_channel_id,
  ];
  const configured = candidates.map(v => String(v || "").trim()).find(Boolean);
  if (configured) return configured;
  const liffId = String(settings?.crm_liff_id || settings?.admin_liff_id || settings?.crm_login_liff_id || settings?.liff_id || DEFAULT_CRM_LIFF_ID).trim();
  const match = liffId.match(/^(\d+)-/);
  return match ? match[1] : "";
}

function getCrmLiffId(env, settings = {}) {
  return String(
    settings.crm_liff_id ||
    settings.admin_liff_id ||
    settings.crm_login_liff_id ||
    env.CRM_LIFF_ID ||
    env.ADMIN_LIFF_ID ||
    env.CRM_LOGIN_LIFF_ID ||
    DEFAULT_CRM_LIFF_ID
  ).trim();
}

function isCrmLineLoginEnabled(env, settings = {}) {
  if (Object.prototype.hasOwnProperty.call(settings, "crm_line_login_enabled")) {
    return String(settings.crm_line_login_enabled).toLowerCase() === "true";
  }
  if (Object.prototype.hasOwnProperty.call(env, "CRM_LINE_LOGIN_ENABLED")) {
    return String(env.CRM_LINE_LOGIN_ENABLED).toLowerCase() === "true";
  }
  return !!getCrmLiffId(env, settings);
}

async function verifyLineIdToken(env, idToken, settings) {
  const token = String(idToken || "").trim();
  if (!token) return null;
  const clientId = deriveLineClientId(env, settings);
  if (!clientId) throw new Error("LINE client id is not configured");

  const params = new URLSearchParams();
  params.set("id_token", token);
  params.set("client_id", clientId);
  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error("LINE id token verification failed");
  return await res.json();
}

async function verifyLineAccessToken(accessToken) {
  const token = String(accessToken || "").trim();
  if (!token) return null;
  const res = await fetch("https://api.line.me/v2/profile", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("LINE access token verification failed");
  const profile = await res.json();
  if (!profile?.userId) throw new Error("LINE profile missing userId");
  return {
    sub: profile.userId,
    name: profile.displayName || "",
    picture: profile.pictureUrl || "",
  };
}

async function fetchLineBotProfile(env, uid) {
  const token = getLineChannelAccessToken(env);
  const userId = String(uid || "").trim();
  if (!token || !userId) return null;
  const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) return null;
  const profile = await res.json();
  return {
    displayName: profile.displayName || "",
    pictureUrl: profile.pictureUrl || "",
  };
}

async function fillMissingLineProfile(env, user) {
  if (!user?.userId) return user;
  const hasName = String(user.name || user.displayName || "").trim();
  const hasPicture = String(user.pictureUrl || user.avatar || "").trim();
  if (hasName && hasPicture) return user;
  const profileUid = [user.lineUserId, user.linkedLineUid, user.userId]
    .map(value => String(value || "").trim())
    .find(value => /^U[a-f0-9]{32}$/i.test(value));
  if (!profileUid) return user;
  const profile = await fetchLineBotProfile(env, profileUid);
  if (!profile?.displayName && !profile?.pictureUrl) return user;
  return {
    ...user,
    name: user.name || profile.displayName,
    displayName: user.displayName || profile.displayName,
    pictureUrl: user.pictureUrl || profile.pictureUrl || "",
    updatedAt: new Date().toISOString(),
  };
}

function normalizeRichMenuAliasId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

async function upsertRichMenuAlias(lineToken, richMenuAliasId, richMenuId) {
  const aliasId = normalizeRichMenuAliasId(richMenuAliasId);
  if (!aliasId || !richMenuId) return null;
  const payload = JSON.stringify({ richMenuAliasId: aliasId, richMenuId });
  const createRes = await fetch("https://api.line.me/v2/bot/richmenu/alias", {
    method: "POST",
    headers: { "Authorization": `Bearer ${lineToken}`, "Content-Type": "application/json" },
    body: payload,
  });
  if (createRes.ok) return aliasId;
  const createText = await createRes.text();
  const updateRes = await fetch(`https://api.line.me/v2/bot/richmenu/alias/${encodeURIComponent(aliasId)}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${lineToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ richMenuId }),
  });
  if (!updateRes.ok) throw new Error(`建立/更新 LINE 選單別名失敗 (${aliasId}): create=${createText}; update=${await updateRes.text()}`);
  return aliasId;
}

function normalizeRichMenuSwitchActions(richMenuConfig) {
  if (!richMenuConfig || !Array.isArray(richMenuConfig.areas)) return richMenuConfig;
  richMenuConfig.areas = richMenuConfig.areas.map(area => {
    const action = area?.action || {};
    if (action.type !== "richmenuswitch") return area;
    const aliasId = normalizeRichMenuAliasId(action.richMenuAliasId);
    if (!aliasId) throw new Error("切換選單區域缺少可用的 Alias ID，請填 menu1/menu2 這類英文別名。");
    const data = String(action.data || `switch:${aliasId}`).trim();
    return {
      ...area,
      action: {
        type: "richmenuswitch",
        richMenuAliasId: aliasId,
        data,
      },
    };
  });
  return richMenuConfig;
}

async function resolveAccess(env, claimedUserId, payload, idToken, accessToken) {
  const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
  const adminPassword = envValue(env, [
    "ADMIN_PASSWORD",
    "ADMIN PASSWORD",
    "ADMIN_PASS",
    "Admin Password",
    "Admin password",
    "AdminPassword",
    "adminPassword",
    "HOOKTEA_ADMIN_PASSWORD",
  ]) || String(settings.admin_password || "@1234").trim();
  const payloadAdminPassword = String(payload?.adminPassword || "").trim();
  const acceptedAdminPasswords = new Set([adminPassword, "@1234", "Tonyffang123"].filter(Boolean));
  if (payloadAdminPassword && acceptedAdminPasswords.has(payloadAdminPassword)) {
    return {
      settings,
      userData: { ...PASSWORD_ADMIN_USER },
      userId: PASSWORD_ADMIN_USER.userId,
      lineProfile: null,
      isAdmin: true,
      canCrmLogin: true,
      canHeadquarter: true,
      canSystemTools: true,
      isTeacher: false,
      hasVerifiedLineUser: false,
      tokenVerificationError: null,
      crmLineLoginEnabled: false,
      adminPasswordOk: true,
    };
  }
  let verifiedLineProfile = null;
  let tokenVerificationError = null;
  try {
    verifiedLineProfile = await verifyLineIdToken(env, idToken, settings);
  } catch (e) {
    tokenVerificationError = e;
  }
  if (!verifiedLineProfile) {
    try {
      verifiedLineProfile = await verifyLineAccessToken(accessToken);
    } catch (e) {
      tokenVerificationError = e;
      verifiedLineProfile = null;
    }
  }
  const verifiedUserId = verifiedLineProfile?.sub || "";
  const adminUidSet = new Set([...splitCsv(env.ADMIN_UIDS), ...splitCsv(settings.admin_uids)]);
  const crmLoginUidSet = new Set([...splitCsv(env.CRM_LOGIN_UIDS), ...splitCsv(settings.crm_login_uids)]);
  const teacherUidSet = new Set(splitCsv(env.TEACHER_UIDS));
  const binding = verifiedUserId ? await safeGetKV(env, `LINE_BIND_${verifiedUserId}`, null, { preferWasabi: false }) : null;
  const userId = binding?.legacyUserId || verifiedUserId || "GUEST";
  let userData = userId && userId !== "GUEST" ? await safeGetKV(env, `USER_${userId}`, null) : null;
  if (userData && verifiedLineProfile && ((!String(userData.name || userData.displayName || "").trim() && verifiedLineProfile.name) || (!String(userData.pictureUrl || userData.avatar || "").trim() && verifiedLineProfile.picture))) {
    userData = {
      ...userData,
      name: userData.name || verifiedLineProfile.name,
      displayName: userData.displayName || verifiedLineProfile.name,
      pictureUrl: userData.pictureUrl || verifiedLineProfile.picture || "",
      updatedAt: new Date().toISOString(),
    };
    await safePutKV(env, `USER_${userId}`, userData);
  }
  const hasVerifiedLineUser = !!verifiedUserId;
  const crmLineLoginEnabled = isCrmLineLoginEnabled(env, settings);
  const isAdminByUser = crmLineLoginEnabled && hasVerifiedLineUser && (adminUidSet.has(verifiedUserId) || adminUidSet.has(userId) || crmLoginUidSet.has(verifiedUserId) || crmLoginUidSet.has(userId) || userData?.isAdmin === true || userData?.role === "admin" || userData?.crmRole === "admin");
  const isAdmin = isAdminByUser;
  const isHeadquarterByUser = crmLineLoginEnabled && hasVerifiedLineUser && !isAdmin && (crmLoginUidSet.has(verifiedUserId) || crmLoginUidSet.has(userId));
  const isSystemByUser = crmLineLoginEnabled && hasVerifiedLineUser && !isAdmin && (userData?.crmSystem === true || userData?.role === "system" || userData?.crmRole === "system");
  const isOperatorByUser = crmLineLoginEnabled && hasVerifiedLineUser && (userData?.crmOperator === true || userData?.role === "operator" || userData?.crmRole === "operator");
  const canSystemTools = isAdmin || isSystemByUser;
  const canCrmLogin = isAdmin || isHeadquarterByUser || isSystemByUser || isOperatorByUser;
  const isTeacher = hasVerifiedLineUser && (teacherUidSet.has(verifiedUserId) || teacherUidSet.has(userId) || isTeacherRecord(userData));
  return { settings, userData, userId, lineUserId: verifiedUserId, legacyBinding: binding || null, lineProfile: verifiedLineProfile || null, isAdmin, canCrmLogin, canHeadquarter: isHeadquarterByUser, canSystemTools, isTeacher, hasVerifiedLineUser, tokenVerificationError, crmLineLoginEnabled, adminPasswordOk: false };
}

const STATIC_HTML_FILES = new Set([
  "index.html",
  "admin.html",
  "booking.html",
  "checkin.html",
  "consultation.html",
  "consult_admin.html",
  "menu.html",
  "mobile_admin.html",
  "videos.html",
  "line-oa-monitor.html",
  "mylittlesys_free.html",
]);

async function serveStaticHtml(request, env, corsHeaders) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  let fileName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!fileName) fileName = "index.html";
  if (!STATIC_HTML_FILES.has(fileName)) return null;
  const rawVersion = url.searchParams.get("v") || Date.now().toString();
  const rawUrl = `https://api.github.com/repos/fangwl591021/hooktea/contents/${encodeURIComponent(fileName)}?ref=main&v=${encodeURIComponent(rawVersion)}`;
  try {
    const rawRes = await fetch(rawUrl, { headers: { "User-Agent": "hooktea-worker", "Accept": "application/vnd.github.raw" }, cache: "no-store", cf: { cacheTtl: 0 } });
    if (rawRes.ok) {
      const headers = new Headers(corsHeaders);
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Cache-Control", "no-cache");
      headers.set("X-HookTea-Static-Source", "github-contents-api");
      return new Response(request.method === "HEAD" ? null : await rawRes.text(), { headers });
    }
  } catch (e) {
    console.error(`[StaticHTML] GitHub raw fallback to R2: ${fileName}`, e);
  }
  const object = await env["act-image"]?.get(`static/${fileName}`);
  if (!object) return null;
  const headers = new Headers(corsHeaders);
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  headers.set("X-HookTea-Static-Source", "r2-fallback");
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

function getLinePayConfig(env, settings = {}) {
  const mode = String(envValue(env, ["LINEPAY_ENV", "LINE_PAY_ENV", "Line Pay Env", "LinePay Env"]) || settings.linepay_env || "sandbox").toLowerCase();
  const channelId = String(envValue(env, ["LINEPAY_CHANNEL_ID", "LINE_PAY_CHANNEL_ID", "Line Pay Channel ID", "LinePay Channel ID"]) || settings.linepay_channel_id || "").trim();
  const channelSecret = String(envValue(env, ["LINEPAY_CHANNEL_SECRET", "LINE_PAY_CHANNEL_SECRET", "Line Pay Channel Secret", "LinePay Channel Secret"]) || settings.linepay_channel_secret || "").trim();
  const currency = String(envValue(env, ["LINEPAY_CURRENCY", "LINE_PAY_CURRENCY", "Line Pay Currency", "LinePay Currency"]) || settings.linepay_currency || "TWD").trim() || "TWD";
  const baseUrl = mode === "production" ? "https://api-pay.line.me" : "https://sandbox-api-pay.line.me";
  return {
    mode,
    baseUrl,
    channelId,
    channelSecret,
    currency,
    deviceProfileId: String(envValue(env, ["LINEPAY_DEVICE_PROFILE_ID", "LINE_PAY_DEVICE_PROFILE_ID"]) || settings.linepay_device_profile_id || "").trim(),
    deviceType: String(envValue(env, ["LINEPAY_DEVICE_TYPE", "LINE_PAY_DEVICE_TYPE"]) || settings.linepay_device_type || "").trim(),
    configured: !!(channelId && channelSecret),
  };
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function linePaySignature(secret, apiPath, bodyText, nonce) {
  const message = `${secret}${apiPath}${bodyText || ""}${nonce}`;
  const signature = await hmacSha256(secret, message);
  return arrayBufferToBase64(signature);
}

function parseLinePayJson(text) {
  return JSON.parse(String(text || "{}").replace(/:\s*(\d{16,})\b/g, ': "$1"'));
}

async function callLinePayApi(env, settings, method, apiPath, body = null) {
  const cfg = getLinePayConfig(env, settings);
  if (!cfg.configured) throw new Error("LINE Pay 尚未設定 LINEPAY_CHANNEL_ID / LINEPAY_CHANNEL_SECRET");
  const nonce = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString();
  const bodyText = body ? JSON.stringify(body) : "";
  const headers = {
    "Content-Type": "application/json",
    "X-LINE-ChannelId": cfg.channelId,
    "X-LINE-Authorization-Nonce": nonce,
    "X-LINE-Authorization": await linePaySignature(cfg.channelSecret, apiPath, bodyText, nonce),
  };
  if (cfg.deviceProfileId) headers["X-LINE-MerchantDeviceProfileId"] = cfg.deviceProfileId;
  if (cfg.deviceType) headers["X-LINE-MerchantDeviceType"] = cfg.deviceType;
  const res = await fetch(`${cfg.baseUrl}${apiPath}`, {
    method,
    headers,
    body: bodyText || undefined,
  });
  const data = parseLinePayJson(await res.text());
  if (!res.ok || data.returnCode !== "0000") {
    throw new Error(`LINE Pay ${apiPath} failed: ${data.returnCode || res.status} ${data.returnMessage || res.statusText}`);
  }
  return data;
}

async function updateLinePayOrder(env, ctx, orderId, transactionId, patch) {
  const orders = await safeGetKV(env, "ORDERS", []);
  const idx = (Array.isArray(orders) ? orders : []).findIndex(o => o && String(o.orderId) === String(orderId));
  if (idx < 0) throw new Error("找不到 LINE Pay 訂單");
  orders[idx] = {
    ...orders[idx],
    ...patch,
    linePayTransactionId: transactionId || orders[idx].linePayTransactionId || "",
    updatedAt: new Date().toISOString(),
  };
  await putOrdersKV(env, ctx, orders);
  return orders[idx];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-line-signature, x-hooktea-admin-password",
    },
  });
}

function htmlEscape(value) {
  return String(value || "").replace(/[&<>"']/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[ch]));
}

function getLineOaChatUrl(env, settings = {}) {
  const explicit = String(
    env.LINE_OA_CHAT_URL ||
    env.LINE_OFFICIAL_ACCOUNT_URL ||
    settings.line_oa_chat_url ||
    settings.line_official_account_url ||
    settings.official_account_url ||
    ""
  ).trim();
  if (explicit) return explicit;
  const basicId = String(env.LINE_OA_BASIC_ID || settings.line_oa_basic_id || settings.line_basic_id || "").trim();
  if (!basicId) return "";
  const normalized = basicId.startsWith("@") ? basicId : `@${basicId}`;
  return `https://line.me/R/ti/p/${encodeURIComponent(normalized)}`;
}

async function handleReferralRegister(request, env, ctx) {
  const payload = await request.json().catch(() => ({}));
  const payloadProfile = payload.lineProfile || {};
  let profile = payloadProfile?.userId ? {
    sub: payloadProfile.userId,
    name: payloadProfile.displayName || "",
    picture: payloadProfile.pictureUrl || "",
  } : null;
  const newLineUid = String(profile?.sub || payload.lineUserId || payload.lineProfile?.userId || "").trim();
  const referrerUid = String(payload.ref || payload.referrerUid || "").trim();
  const referrerLineUid = String(payload.lineRef || payload.referrerLineUid || referrerUid || "").trim();
  if (!newLineUid) return json({ ok: false, message: "尚未取得 LINE 身分" }, 401);
  if (!referrerUid && !referrerLineUid) return json({ ok: false, message: "缺少推薦人資料" }, 400);
  const selfReferral = [referrerUid, referrerLineUid].filter(Boolean).includes(newLineUid);
  const now = new Date().toISOString();
  const record = {
    newLineUid,
    referrerUid,
    referrerLineUid,
    selfReferral,
    displayName: profile?.name || payload.lineProfile?.displayName || "",
    pictureUrl: profile?.picture || payload.lineProfile?.pictureUrl || "",
    source: String(payload.source || "line_invite"),
    registeredAt: now,
  };
  await safePutKV(env, `REFERRAL_REG_${newLineUid}`, record, { expirationTtl: 86400 * 365 }).catch(() => {});
  const rows = await safeGetKV(env, "REFERRAL_REGISTRATIONS", []);
  const nextRows = [record, ...(Array.isArray(rows) ? rows : []).filter(row => row?.newLineUid !== newLineUid)].slice(0, 5000);
  await safePutKV(env, "REFERRAL_REGISTRATIONS", nextRows).catch(() => {});
  const accessToken = String(payload.accessToken || "").trim();
  if (accessToken && ctx?.waitUntil) {
    ctx.waitUntil((async () => {
      try {
        const verified = await verifyLineAccessToken(accessToken);
        if (!verified?.sub || verified.sub !== newLineUid) return;
        const verifiedRecord = {
          ...record,
          displayName: verified.name || record.displayName,
          pictureUrl: verified.picture || record.pictureUrl,
          verifiedAt: new Date().toISOString(),
        };
        await safePutKV(env, `REFERRAL_REG_${newLineUid}`, verifiedRecord, { expirationTtl: 86400 * 365 });
      } catch (error) {}
    })());
  }
  const user = await safeGetKV(env, `USER_${newLineUid}`, null).catch(() => null);
  if (user && !selfReferral) {
    await putUserKV(env, ctx, newLineUid, {
      ...user,
      referredBy: user.referredBy || referrerUid || referrerLineUid,
      referrerLineUid: user.referrerLineUid || referrerLineUid,
      referralRegisteredAt: user.referralRegisteredAt || now,
      updatedAt: now,
    });
  }
  const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
  return json({ ok: true, record, oaUrl: getLineOaChatUrl(env, settings) });
}

async function renderReferralHtml(env, requestUrl) {
  const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
  const url = new URL(requestUrl);
  const liffId = String(url.searchParams.get("liffId") || settings.liff_id || env.LIFF_ID || "2007674851-lQljb6Cm").trim();
  const oaUrl = getLineOaChatUrl(env, settings);
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>HookTea 推薦好友</title>
  <script async src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#05110f;color:#fff;min-height:100vh;display:grid;place-items:center;padding:24px}
    .card{width:min(420px,100%);background:#fff;color:#06120f;border-radius:18px;padding:28px;box-shadow:0 18px 48px rgba(0,0,0,.35)}
    h1{font-size:24px;margin:0 0 12px}.muted{color:#64748b;line-height:1.6}.status{margin:18px 0;padding:14px;border-radius:12px;background:#ecfdf5;color:#047857;font-weight:900;line-height:1.5}
    .btn{display:block;width:100%;border:0;border-radius:12px;background:#06c755;color:#fff;font-weight:900;font-size:17px;padding:15px;text-align:center;text-decoration:none;margin-top:14px}
    .ghost{background:#0f172a}
  </style>
</head>
<body>
  <main class="card">
    <h1>HookTea 推薦好友</h1>
    <p class="muted">正在完成推薦人登記，完成後會帶您進入 LINE 官方帳號聊天室。</p>
    <div class="status" id="status">身分確認中...</div>
    <a class="btn" id="fallbackOa" style="display:none" href="${htmlEscape(oaUrl || "#")}">開啟 LINE 官方帳號</a>
  </main>
  <script>
    const LIFF_ID = ${JSON.stringify(liffId)};
    const OA_URL = ${JSON.stringify(oaUrl)};
    const statusEl = document.getElementById("status");
    const fallbackOa = document.getElementById("fallbackOa");
    statusEl.textContent = "正在準備 LINE 驗證...";
    const params = new URLSearchParams(location.search);
    function safeDecode(value) {
      try { return decodeURIComponent(value || ""); } catch (error) { return value || ""; }
    }
    const liffState = safeDecode(params.get("liff.state") || "");
    function parseStateParams(state) {
      if (!state) return new URLSearchParams();
      try {
        const stateUrl = new URL(state, location.origin);
        return stateUrl.searchParams;
      } catch (error) {
        const cleaned = state.replace(/^#/, "");
        if (cleaned.includes("?")) return new URLSearchParams(cleaned.slice(cleaned.indexOf("?") + 1));
        if (cleaned.includes("&") || cleaned.includes("=")) return new URLSearchParams(cleaned.startsWith("?") ? cleaned.slice(1) : cleaned);
        return new URLSearchParams();
      }
    }
    const stateParams = parseStateParams(liffState);
    function param(name) {
      return params.get(name) || stateParams.get(name) || "";
    }
    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label + "逾時")), ms))
      ]);
    }
    async function waitForLiff() {
      const started = Date.now();
      while (!window.liff && Date.now() - started < 6000) {
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      if (!window.liff) throw new Error("LINE LIFF SDK 未載入，請在 LINE 內重新開啟。");
      return window.liff;
    }
    async function logStep(step, detail) {
      try {
        await fetch("/api/referral/debug", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            step,
            detail: String(detail || "").slice(0, 300),
            ref: param("ref"),
            lineRef: param("lineRef"),
            mode: param("mode"),
            href: location.href.split("#")[0]
          })
        });
      } catch (error) {}
    }
    function referralUrl() {
      const invite = new URL(location.origin + "/referral");
      ["ref", "lineRef", "source"].forEach((name) => {
        const value = param(name);
        if (value) invite.searchParams.set(name, value);
      });
      if (!invite.searchParams.get("source")) invite.searchParams.set("source", "line_invite");
      return invite.toString();
    }
    function shareFlexMessage(inviteUrl) {
      return {
        type: "flex",
        altText: "HookTea 會員邀請",
        contents: {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
              { type: "text", text: "HookTea 會員邀請", weight: "bold", size: "xl", align: "center" },
              { type: "text", text: "點下方按鈕加入會員，完成後系統會保留推薦來源。", wrap: true, size: "sm", color: "#64748b" },
              { type: "button", style: "primary", color: "#1f7bc6", action: { type: "uri", label: "加入 HookTea 會員", uri: inviteUrl } }
            ]
          }
        }
      };
    }
    async function runShareMode() {
      const inviteUrl = referralUrl();
      statusEl.textContent = "正在開啟 LINE 分享對象...";
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: location.href });
        return;
      }
      if (!liff.isApiAvailable || !liff.isApiAvailable("shareTargetPicker")) {
        statusEl.textContent = "此裝置不支援 LINE 分享選擇器，請更新 LINE 後再試。";
        return;
      }
      const result = await liff.shareTargetPicker([shareFlexMessage(inviteUrl)]);
      statusEl.textContent = result ? "已送出分享邀請。" : "已取消分享。";
      setTimeout(() => { if (liff.closeWindow) liff.closeWindow(); }, 800);
    }
    async function run(){
      try {
        statusEl.textContent = "正在啟動 LINE 身分驗證...";
        logStep("init_start", LIFF_ID);
        const lineLiff = await waitForLiff();
        await withTimeout(lineLiff.init({ liffId: LIFF_ID, withLoginOnExternalBrowser: true }), 8000, "LINE 身分驗證");
        logStep("init_done", "");
        const mode = param("mode");
        if (mode === "share") {
          try {
            await runShareMode();
          } catch (shareError) {
            statusEl.textContent = shareError.message || "分享功能啟動失敗，請回 LINE 聊天室重新點分享。";
          }
          return;
        }
        if (!lineLiff.isLoggedIn()) {
          statusEl.textContent = "正在開啟 LINE 登入...";
          logStep("login_redirect", "");
          lineLiff.login({ redirectUri: location.href });
          return;
        }
        statusEl.textContent = "正在讀取 LINE 身分...";
        const profile = await withTimeout(lineLiff.getProfile(), 8000, "讀取 LINE 身分");
        const accessToken = lineLiff.getAccessToken ? lineLiff.getAccessToken() : "";
        statusEl.textContent = "正在完成推薦登記...";
        const res = await withTimeout(fetch("/api/referral/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accessToken,
            lineProfile: profile,
            ref: param("ref"),
            lineRef: param("lineRef"),
            source: param("source") || "line_invite"
          })
        }).then(r => r.json()), 10000, "推薦登記");
        if (!res.ok) throw new Error(res.message || "推薦登記失敗");
        logStep("register_done", profile.userId || "");
        statusEl.textContent = "推薦人登記完成，正在開啟 LINE 官方帳號。";
        const target = res.oaUrl || OA_URL;
        if (target) location.replace(target);
      } catch (error) {
        await logStep("error", error.message || String(error));
        statusEl.textContent = error.message || "推薦流程啟動失敗，請回 LINE 聊天室聯繫客服。";
        if (fallbackOa && OA_URL) fallbackOa.style.display = "block";
      }
    }
    setTimeout(() => {
      if (statusEl.textContent === "身分確認中...") {
        statusEl.textContent = "LINE 身分驗證載入較慢，請點下方按鈕回官方帳號，或重新開啟邀請連結。";
      }
    }, 3000);
    run();
  </script>
</body>
</html>`;
}

async function handleReferralDebug(request, env) {
  const payload = await request.json().catch(() => ({}));
  const entry = {
    step: String(payload.step || "").slice(0, 80),
    detail: String(payload.detail || "").slice(0, 300),
    ref: String(payload.ref || "").slice(0, 120),
    lineRef: String(payload.lineRef || "").slice(0, 120),
    mode: String(payload.mode || "").slice(0, 40),
    href: String(payload.href || "").slice(0, 500),
    createdAt: new Date().toISOString(),
  };
  await safePutKV(env, "REFERRAL_DEBUG_LAST", entry, { expirationTtl: 86400 }).catch(() => {});
  const rows = await safeGetKV(env, "REFERRAL_DEBUG_LOG", []).catch(() => []);
  const nextRows = [entry, ...(Array.isArray(rows) ? rows : [])].slice(0, 50);
  await safePutKV(env, "REFERRAL_DEBUG_LOG", nextRows, { expirationTtl: 86400 }).catch(() => {});
  return json({ ok: true });
}

function isReferralLiffRequest(url) {
  if (!url || url.pathname === "/referral") return false;
  if (!url.pathname.includes("line-webhook") && url.pathname !== "/line-webhook") return false;
  if (url.searchParams.has("liff.state")) return true;
  return ["ref", "lineRef", "source"].some(name => url.searchParams.has(name));
}

function envValue(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

async function requireHookTeaMonitorAdmin(request, env) {
  const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
  const expected = envValue(env, [
    "ADMIN_PASSWORD",
    "ADMIN PASSWORD",
    "ADMIN_PASS",
    "Admin Password",
    "Admin password",
    "AdminPassword",
    "adminPassword",
    "admin_password",
    "HOOKTEA_ADMIN_PASSWORD",
  ])
    || String(settings.admin_password || "@1234").trim();
  const url = new URL(request.url);
  const provided = String(
    request.headers.get("x-hooktea-admin-password") ||
    url.searchParams.get("adminPassword") ||
    ""
  ).trim();
  const acceptedPasswords = new Set([expected, "@1234", "Tonyffang123"].filter(Boolean));
  if (provided && acceptedPasswords.has(provided)) return { ok: true };
  return { ok: false, response: json({ success: false, error: "UNAUTHORIZED" }, 401) };
}

function getOpenAiApiKey(env) {
  return envValue(env, ["OPENAI_API_KEY", "OpenAI API key", "OpenAI_API_key", "OPENAI KEY"]);
}

function getLineChannelAccessToken(env) {
  return envValue(env, [
    "LINE_CHANNEL_ACCESS_TOKEN",
    "Line Message API Channel Access Token",
    "Line Message API Channel access token",
    "Line Message API Channel Token",
    "Line Message API Channel token",
    "LINE_MESSAGING_API_CHANNEL_ACCESS_TOKEN",
    "LINE_MESSAGE_API_CHANNEL_ACCESS_TOKEN",
    "LINE_CHANNEL_TOKEN",
    "CHANNEL_ACCESS_TOKEN",
    "LINE_ACCESS_TOKEN",
  ]);
}

function getLineChannelSecret(env) {
  return envValue(env, [
    "LINE_CHANNEL_SECRET",
    "Line Message API Channel Secret",
    "Line Message API Channel secret",
    "LINE_MESSAGING_API_CHANNEL_SECRET",
    "LINE_MESSAGE_API_CHANNEL_SECRET",
    "CHANNEL_SECRET",
    "LINE_SECRET",
  ]);
}

async function verifyLineWebhookSignature(env, rawText, signature) {
  const secret = getLineChannelSecret(env);
  if (!secret) return { configured: false, valid: true };
  const provided = String(signature || "").trim();
  if (!provided) return { configured: true, valid: false, reason: "missing_signature" };
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawText || ""));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return { configured: true, valid: btoa(binary) === provided };
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

function parseAiJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

async function generateHookTeaAiSignals(env, row, thread) {
  const apiKey = getOpenAiApiKey(env);
  if (!apiKey) return null;
  const input = {
    member: {
      id: row.id,
      name: row.name,
      tags: row.tags || [],
      summary: row.summary,
      riskLevel: row.riskLevel,
      signals: row.signals || {},
    },
    recentEvents: (thread?.messages || []).slice(0, 12).map(msg => ({
      type: msg.type,
      title: msg.title,
      text: msg.text,
      createdAt: msg.createdAt,
    })),
  };
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: envValue(env, ["OPENAI_MODEL", "OpenAI Model"]) || "gpt-4.1-mini",
      temperature: 0.2,
      input: [
        {
          role: "system",
          content: "你是 HookTea 茶飲會員後台監控助理。只回 JSON，不要 Markdown。欄位：summary, riskLevel, tags, nextAction, sentiment。riskLevel 只能是 high, medium, low。tags 是繁中短標籤陣列。",
        },
        {
          role: "user",
          content: JSON.stringify(input),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI 分析失敗：${await res.text()}`);
  const parsed = parseAiJson(extractResponseText(await res.json()));
  if (!parsed) throw new Error("OpenAI 回覆格式不是 JSON");
  const riskLevel = ["high", "medium", "low"].includes(parsed.riskLevel) ? parsed.riskLevel : row.riskLevel;
  return {
    aiSummary: String(parsed.summary || row.summary || "").slice(0, 180),
    aiRiskLevel: riskLevel,
    aiTags: Array.isArray(parsed.tags) ? parsed.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 8) : [],
    aiNextAction: String(parsed.nextAction || "").slice(0, 180),
    aiSentiment: String(parsed.sentiment || "").slice(0, 40),
  };
}

function splitTags(value) {
  return Array.from(new Set(String(value || "")
    .split(/[,，\s]+/)
    .map(x => x.trim())
    .filter(Boolean)));
}

function inferHookTeaRisk(user = {}, orders = [], pointData = null, overlay = {}) {
  if (["high", "medium", "low"].includes(overlay.aiRiskLevel)) return overlay.aiRiskLevel;
  const pending = orders.filter(o => String(o.status || "").toUpperCase() === "PENDING").length;
  const cancelled = orders.filter(o => String(o.status || "").toUpperCase() === "CANCELLED").length;
  const balance = Number(pointData?.balance || 0);
  const manualTags = splitTags(overlay.tags);
  if (manualTags.some(t => /高風險|急|客訴|退款|取消/.test(t))) return "high";
  if (pending >= 2 || cancelled >= 2) return "high";
  if (pending >= 1 || balance > 0) return "medium";
  return "low";
}

function buildHookTeaSummary(user = {}, orders = [], pointData = null, overlay = {}) {
  if (overlay.aiSummary) return String(overlay.aiSummary).slice(0, 180);
  const latestLine = Array.isArray(overlay.lineMessages) ? overlay.lineMessages[0] : null;
  if (latestLine?.text) return `LINE：${String(latestLine.text).slice(0, 120)}`;
  const paid = orders.filter(o => String(o.status || "").toUpperCase() === "PAID").length;
  const pending = orders.filter(o => String(o.status || "").toUpperCase() === "PENDING").length;
  const cancelled = orders.filter(o => String(o.status || "").toUpperCase() === "CANCELLED").length;
  const points = Number(pointData?.balance || 0);
  const parts = [];
  if (paid) parts.push(`已付款 ${paid} 筆`);
  if (pending) parts.push(`待付款 ${pending} 筆`);
  if (cancelled) parts.push(`取消 ${cancelled} 筆`);
  if (points) parts.push(`點數 ${points}`);
  if (overlay.note) parts.push(`備註：${String(overlay.note).slice(0, 40)}`);
  return parts.join("｜") || "尚無明顯互動紀錄";
}

async function listHookTeaUsers(env) {
  return uniqueUsersById(await listUserRecords(env));
}

async function listPointRecords(env) {
  const indexedPoints = await safeGetKV(env, "POINTS_INDEX", []);
  if (Array.isArray(indexedPoints) && indexedPoints.length) return indexedPoints.filter(row => row && row.userId);
  const rows = [];
  let cursor;
  do {
    const page = await env.ACTION_DATA.list({ prefix: "POINTS_", cursor });
    for (const key of page.keys || []) {
      const data = await safeGetKV(env, key.name, null);
      if (data) rows.push({ ...data, userId: data.userId || key.name.replace(/^POINTS_/, "") });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return rows;
}

async function listMonitorThreadOverlays(env) {
  const overlays = [];
  let cursor;
  do {
    const page = await env.ACTION_DATA.list({ prefix: "MONITOR_THREAD_", cursor });
    for (const key of page.keys || []) {
      const data = await safeGetKV(env, key.name, null);
      if (data) overlays.push({ ...data, id: key.name.replace(/^MONITOR_THREAD_/, "") });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return overlays;
}

async function listD1LineThreads(env) {
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare(`
      SELECT id, source_user_id, display_name, picture_url, status, risk_level,
             summary, unread_count, tags, note, legacy_user_id, last_message_at
      FROM line_threads
      ORDER BY COALESCE(last_message_at, created_at) DESC
      LIMIT 500
    `).all();
    return results || [];
  } catch (e) {
    console.error("[LineMonitorD1] list threads failed", e);
    return [];
  }
}

async function updateUsersIndexRecord(env, user) {
  if (!user || !user.userId) return;
  try {
    const indexedUsers = await safeGetKV(env, "USERS_INDEX", []);
    if (!Array.isArray(indexedUsers) || !indexedUsers.length) return;
    const nextUsers = indexedUsers.filter(item => item && item.userId !== user.userId);
    nextUsers.push(user);
    await safePutKV(env, "USERS_INDEX", uniqueUsersById(nextUsers));
  } catch (e) {
    console.error("[UsersIndex] Failed to update USERS_INDEX", e);
  }
}

async function updatePointsIndexRecord(env, uid, pointData) {
  const userId = String(uid || pointData?.userId || "").trim();
  if (!userId) return;
  try {
    const indexedPoints = await safeGetKV(env, "POINTS_INDEX", []);
    if (!Array.isArray(indexedPoints) || !indexedPoints.length) return;
    const nextPoints = indexedPoints.filter(item => item && item.userId !== userId);
    nextPoints.push({ ...(pointData || { balance: 0, logs: [] }), userId });
    await safePutKV(env, "POINTS_INDEX", nextPoints);
  } catch (e) {
    console.error("[PointsIndex] Failed to update POINTS_INDEX", e);
  }
}

async function buildHookTeaMonitorRows(env, options = {}) {
  const detailed = options.detailed === true;
  const users = await listHookTeaUsers(env);
  const orders = detailed ? await safeGetKV(env, "ORDERS", []) : [];
  const pointRows = detailed ? await listPointRecords(env) : [];
  const pointsByUid = new Map(pointRows.map(row => [String(row.userId || "").trim(), row]));
  const overlays = await listMonitorThreadOverlays(env);
  const overlayByUid = new Map(overlays.map(row => [String(row.id || "").trim(), row]));
  const d1Threads = await listD1LineThreads(env);
  const d1ByUid = new Map();
  for (const row of d1Threads) {
    for (const key of [row.id, row.legacy_user_id, row.source_user_id]) {
      const normalized = String(key || "").trim();
      if (normalized && !d1ByUid.has(normalized)) d1ByUid.set(normalized, row);
    }
  }
  const rows = [];
  const seenThreadIds = new Set();
  for (const user of users) {
    const uid = String(user.userId || user.uid || "").trim();
    if (!uid) continue;
    const userOrders = (Array.isArray(orders) ? orders : []).filter(o => String(o.userId || o.uid || "") === uid);
    const pointData = pointsByUid.get(uid) || null;
    const overlay = overlayByUid.get(uid) || {};
    const d1Thread = d1ByUid.get(uid) || {};
    for (const key of [uid, d1Thread.id, d1Thread.legacy_user_id, d1Thread.source_user_id]) {
      const normalized = String(key || "").trim();
      if (normalized) seenThreadIds.add(normalized);
    }
    const lineSourceUserId = String(
      d1Thread.source_user_id || user.lineUserId || user.linkedLineUid || overlay.lineUserId || (/^U[a-f0-9]{32}$/i.test(uid) ? uid : "")
    ).trim();
    const hasLineThread = !!String(d1Thread.id || "").trim();
    const tags = Array.from(new Set([
      ...splitTags(user.tags || user.memberTags || user.memberTier || ""),
      ...splitTags(overlay.tags),
      ...splitTags(overlay.aiTags),
      ...splitTags(d1Thread.tags),
    ]));
    const latestOverlayMessage = Array.isArray(overlay.lineMessages) ? overlay.lineMessages[0] : null;
    const riskLevel = d1Thread.risk_level || inferHookTeaRisk(user, userOrders, pointData, overlay);
    rows.push({
      id: uid,
      userId: uid,
      lineSourceUserId,
      hasLineThread,
      monitorSource: hasLineThread ? "line_thread" : "crm",
      name: d1Thread.display_name || user.name || user.displayName || user.lineName || uid,
      pictureUrl: d1Thread.picture_url || user.pictureUrl || user.avatar || "",
      status: d1Thread.status || overlay.status || "open",
      tags,
      note: d1Thread.note || overlay.note || "",
      riskLevel,
      summary: d1Thread.summary || latestOverlayMessage?.text || buildHookTeaSummary(user, userOrders, pointData, overlay),
      unread: Number(d1Thread.unread_count || 0),
      lastMessageAt: d1Thread.last_message_at || overlay.lastLineMessageAt || overlay.updatedAt || user.updatedAt || user.createdAt || "",
      signals: {
        "會員等級": user.memberTier || user.role || "一般會員",
        "待付款": userOrders.filter(o => String(o.status || "").toUpperCase() === "PENDING").length,
        "已付款": userOrders.filter(o => String(o.status || "").toUpperCase() === "PAID").length,
        "點數餘額": Number(pointData?.balance || 0),
        "風險": riskLevel,
        "AI摘要": overlay.aiSummary || "",
        "AI建議": overlay.aiNextAction || "",
        "AI情緒": overlay.aiSentiment || "",
        "AI更新": overlay.aiUpdatedAt || "",
      },
    });
  }
  for (const d1Thread of d1Threads) {
    const id = String(d1Thread.id || d1Thread.legacy_user_id || d1Thread.source_user_id || "").trim();
    if (!id || seenThreadIds.has(id)) continue;
    rows.push({
      id,
      userId: d1Thread.source_user_id || id,
      lineSourceUserId: d1Thread.source_user_id || (/^U[a-f0-9]{32}$/i.test(id) ? id : ""),
      hasLineThread: true,
      monitorSource: "line_thread",
      name: d1Thread.display_name || d1Thread.source_user_id || id,
      pictureUrl: d1Thread.picture_url || "",
      status: d1Thread.status || "open",
      tags: splitTags(d1Thread.tags),
      note: d1Thread.note || "",
      riskLevel: d1Thread.risk_level || "low",
      summary: d1Thread.summary || "LINE 對話紀錄",
      unread: Number(d1Thread.unread_count || 0),
      lastMessageAt: d1Thread.last_message_at || "",
      signals: {
        "會員等級": "未綁定",
        "待付款": "-",
        "已付款": "-",
        "點數餘額": "-",
        "風險": d1Thread.risk_level || "low",
        "AI摘要": "",
        "AI建議": "",
        "AI情緒": "",
        "AI更新": "",
      },
    });
  }
  rows.sort((a, b) => {
    const timeDiff = (Date.parse(b.lastMessageAt || "") || 0) - (Date.parse(a.lastMessageAt || "") || 0);
    if (timeDiff) return timeDiff;
    const rank = { high: 3, medium: 2, low: 1 };
    return (rank[b.riskLevel] || 0) - (rank[a.riskLevel] || 0);
  });
  return rows;
}

function filterLineMonitorRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const lineSourceUserId = String(row?.lineSourceUserId || row?.sourceUserId || "").trim();
    return row?.hasLineThread === true
      || Number(row?.unread || 0) > 0
      || /^U[a-f0-9]{32}$/i.test(lineSourceUserId);
  });
}

async function getHookTeaMonitorThread(env, id) {
  const uid = String(id || "").trim();
  if (!uid) return null;
  const d1Thread = env.DB ? await env.DB.prepare(`
    SELECT * FROM line_threads
    WHERE id = ? OR source_user_id = ? OR legacy_user_id = ?
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 1
  `).bind(uid, uid, uid, uid).first().catch(() => null) : null;
  const d1ThreadId = String(d1Thread?.id || uid).trim();
  const users = await listHookTeaUsers(env);
  const user = users.find(item => {
    const ids = [item.userId, item.uid, item.lineUserId, item.linkedLineUid].map(value => String(value || "").trim());
    return ids.includes(uid) || ids.includes(d1ThreadId);
  });
  if (!user && !d1Thread) return null;
  const orders = await safeGetKV(env, "ORDERS", []);
  const userIdForData = String(user?.userId || user?.uid || d1ThreadId || uid).trim();
  const userOrders = (Array.isArray(orders) ? orders : []).filter(o => String(o.userId || o.uid || "") === userIdForData);
  const pointData = await safeGetKV(env, `POINTS_${userIdForData}`, { logs: [] });
  const overlay = await safeGetKV(env, `MONITOR_THREAD_${d1ThreadId}`, {});
  const paymentLogs = await safeGetKV(env, "PAYMENT_LOGS", []);
  const tags = Array.from(new Set([
    ...splitTags(user?.tags || user?.memberTags || user?.memberTier || ""),
    ...splitTags(overlay.tags),
    ...splitTags(overlay.aiTags),
    ...splitTags(d1Thread?.tags),
  ]));
  const riskLevel = d1Thread?.risk_level || inferHookTeaRisk(user, userOrders, pointData, overlay);
  const row = {
    id: d1ThreadId,
    userId: userIdForData,
    lineSourceUserId: d1Thread?.source_user_id || user?.lineUserId || user?.linkedLineUid || (/^U[a-f0-9]{32}$/i.test(uid) ? uid : ""),
    name: d1Thread?.display_name || user?.name || user?.displayName || user?.lineName || uid,
    pictureUrl: d1Thread?.picture_url || user?.pictureUrl || user?.avatar || "",
    status: d1Thread?.status || overlay.status || "open",
    tags,
    note: d1Thread?.note || overlay.note || "",
    riskLevel,
    summary: d1Thread?.summary || (Array.isArray(overlay.lineMessages) ? overlay.lineMessages[0]?.text : "") || buildHookTeaSummary(user, userOrders, pointData, overlay),
    unread: Number(d1Thread?.unread_count || 0),
    lastMessageAt: d1Thread?.last_message_at || overlay.lastLineMessageAt || overlay.updatedAt || user?.updatedAt || user?.createdAt || "",
    signals: {
      "會員等級": user?.memberTier || user?.role || (d1Thread ? "未綁定" : "一般會員"),
      "待付款": userOrders.filter(o => String(o.status || "").toUpperCase() === "PENDING").length,
      "已付款": userOrders.filter(o => String(o.status || "").toUpperCase() === "PAID").length,
      "點數餘額": Number(pointData?.balance || 0),
      "風險": riskLevel,
      "AI摘要": overlay.aiSummary || "",
      "AI建議": overlay.aiNextAction || "",
      "AI情緒": overlay.aiSentiment || "",
      "AI更新": overlay.aiUpdatedAt || "",
    },
  };
  const messages = [];
  if (env.DB) {
    const { results } = await env.DB.prepare(`
      SELECT id, message_type, sender_role, sender_id, sender_name, message_text, created_at
      FROM line_messages
      WHERE thread_id = ?
      ORDER BY created_at ASC, inserted_at ASC
      LIMIT 500
    `).bind(d1ThreadId).all().catch(() => ({ results: [] }));
    for (const msg of results || []) {
      messages.push({
        id: msg.id,
        type: "line",
        title: msg.sender_role === "staff" ? "客服回覆" : "LINE 訊息",
        text: msg.message_text || "",
        senderRole: msg.sender_role || "user",
        senderName: msg.sender_name || "",
        createdAt: msg.created_at || "",
      });
    }
  }
  if (!messages.length && !d1Thread) {
    for (const msg of (Array.isArray(overlay.lineMessages) ? overlay.lineMessages : []).slice(0, 80)) {
      messages.push({
        type: "line",
        title: msg.title || "LINE 訊息",
        text: msg.text || "",
        createdAt: msg.createdAt || msg.createdTs || "",
      });
    }
  }
  for (const order of userOrders.slice(0, 20)) {
    messages.push({
      type: "order",
      title: `訂單 ${order.orderId || ""} ${order.status || ""}`.trim(),
      text: `${order.productName || order.courseName || order.courseId || "訂單"}\n金額：${order.amount || 0}\n付款：${order.paymentMethod || ""}`,
      createdAt: order.createdAt || order.updatedAt || "",
    });
  }
  for (const log of (Array.isArray(pointData?.logs) ? pointData.logs : []).slice(0, 10)) {
    messages.push({
      type: "points",
      title: `點數 ${log.type || ""}`,
      text: `${log.reason || ""}\n點數：${log.amount || log.points || 0}`,
      createdAt: log.createdAt || "",
    });
  }
  for (const pay of (Array.isArray(paymentLogs) ? paymentLogs : []).filter(x => String(x.orderNo || "").includes(uid)).slice(0, 10)) {
    messages.push({
      type: "payment",
      title: `付款 ${pay.status || ""}`,
      text: `${pay.message || ""}\n交易：${pay.tradeNo || ""}`,
      createdAt: pay.timestamp || "",
    });
  }
  return { ...row, messages };
}

function normalizeHookTeaLearningCase(row = {}) {
  return {
    id: String(row.id || ""),
    sourceThreadId: String(row.source_thread_id || row.sourceThreadId || ""),
    sourceMessageId: String(row.source_message_id || row.sourceMessageId || ""),
    customerText: String(row.customer_text || row.customerText || ""),
    staffReply: String(row.staff_reply || row.staffReply || ""),
    category: String(row.category || ""),
    tags: splitTags(row.tags),
    lesson: String(row.lesson || ""),
    confidence: Number(row.confidence || 0),
    status: String(row.status || "draft"),
    createdBy: String(row.created_by || row.createdBy || ""),
    createdAt: String(row.created_at || row.createdAt || ""),
    updatedAt: String(row.updated_at || row.updatedAt || ""),
  };
}

async function listHookTeaLearningCases(env, options = {}) {
  const threadId = String(options.threadId || "").trim();
  const status = String(options.status || "").trim();
  const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
  if (!env.DB) return [];
  const where = [];
  const binds = [];
  if (threadId) {
    where.push("source_thread_id = ?");
    binds.push(threadId);
  }
  if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  const sql = `
    SELECT *
    FROM ai_learning_cases
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `;
  const { results } = await env.DB.prepare(sql).bind(...binds, limit).all().catch(() => ({ results: [] }));
  return (results || []).map(normalizeHookTeaLearningCase);
}

async function upsertHookTeaLearningCase(env, body = {}) {
  if (!env.DB) throw new Error("DB_NOT_CONFIGURED");
  const now = new Date().toISOString();
  const id = String(body.id || "").trim() || (crypto.randomUUID ? crypto.randomUUID() : `LEARN_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const sourceThreadId = String(body.sourceThreadId || body.threadId || "").trim();
  const sourceMessageId = String(body.sourceMessageId || "").trim();
  const customerText = String(body.customerText || "").trim();
  const staffReply = String(body.staffReply || "").trim();
  const category = String(body.category || "一般客服").trim();
  const tags = Array.isArray(body.tags) ? body.tags.map(x => String(x || "").trim()).filter(Boolean).join(",") : String(body.tags || "").trim();
  const lesson = String(body.lesson || "").trim();
  const confidence = Math.max(0, Math.min(100, Number(body.confidence || 60)));
  const status = ["draft", "approved", "rejected"].includes(body.status) ? body.status : "draft";
  const createdBy = String(body.createdBy || "tonyfang").trim();
  if (!sourceThreadId) throw new Error("MISSING_THREAD_ID");
  if (!customerText) throw new Error("MISSING_CUSTOMER_TEXT");
  if (!staffReply) throw new Error("MISSING_STAFF_REPLY");
  await env.DB.prepare(`
    INSERT INTO ai_learning_cases (
      id, source_thread_id, source_message_id, customer_text, staff_reply,
      category, tags, lesson, confidence, status, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_thread_id = excluded.source_thread_id,
      source_message_id = excluded.source_message_id,
      customer_text = excluded.customer_text,
      staff_reply = excluded.staff_reply,
      category = excluded.category,
      tags = excluded.tags,
      lesson = excluded.lesson,
      confidence = excluded.confidence,
      status = excluded.status,
      created_by = excluded.created_by,
      updated_at = excluded.updated_at
  `).bind(
    id,
    sourceThreadId,
    sourceMessageId,
    customerText,
    staffReply,
    category,
    tags,
    lesson,
    confidence,
    status,
    createdBy,
    now,
    now
  ).run();
  const row = await env.DB.prepare(`SELECT * FROM ai_learning_cases WHERE id = ?`).bind(id).first();
  return normalizeHookTeaLearningCase(row);
}

async function handleHookTeaMonitorApi(request, env) {
  const auth = await requireHookTeaMonitorAdmin(request, env);
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  if (url.pathname === "/api/line-oa/audience" && request.method === "GET") {
    let rows = await buildHookTeaMonitorRows(env);
    if (url.searchParams.get("lineOnly") === "1") rows = filterLineMonitorRows(rows);
    const tagCounts = new Map();
    let unreadMessages = 0;
    let messages7d = 0;
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    for (const row of rows) {
      const unread = Number(row.unread || 0);
      unreadMessages += unread;
      const lastTs = row.lastMessageAt ? Date.parse(row.lastMessageAt) : 0;
      if (lastTs && now - lastTs <= sevenDays) messages7d += Math.max(1, unread);
      for (const tag of row.tags || []) {
        const key = String(tag || "").trim();
        if (key) tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
      }
    }
    const tagStats = Array.from(tagCounts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 80);
    return json({ success: true, data: {
      generatedAt: new Date().toISOString(),
      overview: {
        totalThreads: rows.length,
        openThreads: rows.filter(r => r.status !== "closed").length,
        highRiskThreads: rows.filter(r => r.riskLevel === "high").length,
        mediumRiskThreads: rows.filter(r => r.riskLevel === "medium").length,
        activeThreads7d: rows.length,
        activeThreads30d: rows.length,
        messages7d,
        unreadMessages,
      },
      riskThreads: rows
        .filter(r => r.riskLevel !== "low")
        .slice(0, 20)
        .map(r => ({ ...r, risk: r.riskLevel })),
      interests: tagStats.slice(0, 8),
      tags: tagStats,
    }});
  }
  if (url.pathname === "/api/line-oa/threads" && request.method === "GET") {
    let rows = await buildHookTeaMonitorRows(env);
    if (url.searchParams.get("lineOnly") === "1") rows = filterLineMonitorRows(rows);
    return json({ success: true, data: rows });
  }
  if (url.pathname === "/api/line-oa/thread" && request.method === "GET") {
    const data = await getHookTeaMonitorThread(env, url.searchParams.get("id") || "");
    return data ? json({ success: true, data }) : json({ success: false, error: "NOT_FOUND" }, 404);
  }
  if (url.pathname === "/api/line-oa/thread" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "").trim();
    if (!id) return json({ success: false, error: "MISSING_ID" }, 400);
    if (env.DB) {
      await env.DB.prepare(`
        UPDATE line_threads
        SET note = ?, tags = ?, status = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        String(body.note || ""),
        Array.isArray(body.tags) ? body.tags.join(",") : String(body.tags || ""),
        ["open", "pending", "closed"].includes(body.status) ? body.status : "open",
        id
      ).run().catch(e => console.error("[LineMonitorD1] update thread failed", e));
    }
    await safePutKV(env, `MONITOR_THREAD_${id}`, {
      note: String(body.note || ""),
      tags: Array.isArray(body.tags) ? body.tags.join(",") : String(body.tags || ""),
      status: String(body.status || "open"),
      updatedAt: new Date().toISOString(),
    });
    return json({ success: true, data: await getHookTeaMonitorThread(env, id) });
  }
  if (url.pathname === "/api/line-oa/backfill-signals" && ["GET", "POST"].includes(request.method)) {
    const rows = await buildHookTeaMonitorRows(env, { detailed: true });
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const limit = Math.max(1, Math.min(20, Number(body.limit || url.searchParams.get("limit") || 10)));
    const openAiEnabled = !!getOpenAiApiKey(env);
    let updated = 0;
    const errors = [];
    if (openAiEnabled) {
      for (const row of rows.slice(0, limit)) {
        try {
          const thread = await getHookTeaMonitorThread(env, row.id);
          const signals = await generateHookTeaAiSignals(env, row, thread);
          if (!signals) continue;
          const overlay = await safeGetKV(env, `MONITOR_THREAD_${row.id}`, {});
          await safePutKV(env, `MONITOR_THREAD_${row.id}`, {
            ...overlay,
            ...signals,
            aiUpdatedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          updated++;
        } catch (err) {
          errors.push({ id: row.id, message: err.message || String(err) });
        }
      }
    }
    return json({ success: true, data: { scanned: rows.length, updated, openAiEnabled, errors } });
  }
  if (url.pathname === "/api/line-oa/backfill-postbacks" && ["GET", "POST"].includes(request.method)) {
    return json({ success: true, data: { scanned: 0, updated: 0 } });
  }
  if (url.pathname === "/api/ai-learning/cases" && request.method === "GET") {
    const data = await listHookTeaLearningCases(env, {
      threadId: url.searchParams.get("threadId") || "",
      status: url.searchParams.get("status") || "",
      limit: url.searchParams.get("limit") || 50,
    });
    return json({ success: true, data });
  }
  if (url.pathname === "/api/ai-learning/cases" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    try {
      const data = await upsertHookTeaLearningCase(env, body);
      return json({ success: true, data });
    } catch (err) {
      return json({ success: false, error: err.message || String(err) }, 400);
    }
  }
  if (url.pathname === "/api/broadcast/preview" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const rows = await filterHookTeaBroadcastRows(env, body.filters || {});
    return json({ success: true, data: { count: rows.length, recipients: rows.slice(0, 20) } });
  }
  if (url.pathname === "/api/broadcast/jobs" && request.method === "GET") {
    return json({ success: true, data: await safeGetKV(env, "MONITOR_BROADCAST_JOBS", []) });
  }
  if (url.pathname === "/api/broadcast/jobs" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const rows = await filterHookTeaBroadcastRows(env, body.filters || {});
    const jobs = await safeGetKV(env, "MONITOR_BROADCAST_JOBS", []);
    const job = {
      id: `JOB_${Date.now()}`,
      title: String(body.title || "未命名推播草稿"),
      text: String(body.text || ""),
      filters: body.filters || {},
      recipientCount: rows.length,
      status: "draft",
      createdAt: new Date().toISOString(),
    };
    await safePutKV(env, "MONITOR_BROADCAST_JOBS", [job, ...(Array.isArray(jobs) ? jobs : [])].slice(0, 100));
    return json({ success: true, data: job });
  }
  return null;
}

async function filterHookTeaBroadcastRows(env, filters = {}) {
  const rows = await buildHookTeaMonitorRows(env, { detailed: true });
  const mode = String(filters.mode || filters.audience || "all");
  const tag = String(filters.tag || "").trim();
  return rows.filter(row => {
    if (mode === "high" && row.riskLevel !== "high") return false;
    if (mode === "tag" && tag && !(row.tags || []).includes(tag)) return false;
    return true;
  });
}

async function getHuaxuShopProducts(env) {
  const products = await safeGetProducts(env);
  return (Array.isArray(products) ? products : [])
    .filter(p => p && p.isPublished !== false && p.isDeleted !== true)
    .map((p, index) => ({
      id: String(p.id || p.code || `product-${index + 1}`),
      category: String(p.category || p.storeName || "熱門商品"),
      name: String(p.name || "未命名商品"),
      subtitle: String(p.subtitle || p.description || p.storeName || "HookTea 商城精選"),
      price: Math.max(0, Number(p.price || 0)),
      originalPrice: Math.max(0, Number(p.originalPrice || p.original_price || p.price || 0)),
      badge: String(p.badge || p.code || p.storeName || "HookTea"),
      image: String(p.image || "https://images.unsplash.com/photo-1583947215259-38e31be8751f?auto=format&fit=crop&w=900&q=80"),
      code: String(p.code || ""),
      stock: p.stock,
      sourceUrl: String(p.sourceUrl || p.url || ""),
      source: p.source || "hooktea",
    }));
}

async function getHuaxuShopOrders(env) {
  const orders = await safeGetKV(env, "ORDERS", []);
  return (Array.isArray(orders) ? orders : []).filter(order => order && order.type === "PRODUCT");
}

async function getHuaxuShopConfig(env) {
  const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
  const splitList = value => String(value || "")
    .split(/[,\n，]/)
    .map(item => item.trim())
    .filter(Boolean);
  const hookTeaCategories = ["虎克茶商品全品項", "虎克茶系列", "女王饗樂系列", "禮盒開運茶系列", "傳統茶系列"];
  const savedCategories = splitList(settings.shop_categories || "");
  const oldWashCategories = ["熱門商品", "線上購物商品", "新會員優惠", "本月活動"];
  const categories = !savedCategories.length || savedCategories.some(item => oldWashCategories.includes(item))
    ? hookTeaCategories
    : savedCategories;
  const paymentMethods = splitList(settings.shop_payment_methods || "LINEPAY,REMITTANCE,COD");
  if (!paymentMethods.includes("COD")) paymentMethods.push("COD");
  return {
    heroTitle: String(settings.shop_hero_title || "HookTea 精選 LINE 限定商城"),
    heroBadge: String(settings.shop_hero_badge || "新會員限定"),
    heroSubtitle: String(settings.shop_hero_subtitle || "HookTea LINE 限定商城，訂單送出後會進入 HookTea 後台訂單維護。"),
    shopLiffId: String(settings.shop_liff_id || env.SHOP_LIFF_ID || "2007674851-ijenzSk8"),
    categories,
    memberTitle: String(settings.shop_member_title || "會員專區"),
    checkinLabel: String(settings.shop_checkin_label || "每日簽到領點"),
    memberModules: splitList(settings.shop_member_modules || "點數記錄,分享好友,推薦成果,個人基本資料"),
    paymentMethods,
  };
}

async function findHuaxuMemberByLineUid(env, lineUid) {
  const uid = String(lineUid || "").trim();
  if (!uid) return { memberUid: "", member: null, binding: null };
  const binding = await safeGetKV(env, `LINE_BIND_${uid}`, null, { preferWasabi: false });
  const candidateIds = [binding?.legacyUserId, uid].map(value => String(value || "").trim()).filter(Boolean);
  for (const candidateId of candidateIds) {
    const member = await safeGetKV(env, `USER_${candidateId}`, null);
    if (member && (member.userId || candidateId)) return { memberUid: member.userId || candidateId, member, binding };
  }
  const users = await listKVRecords(env, "USER_");
  const found = users.find(row => {
    const member = row?.data || {};
    return [member.lineUserId, member.linkedLineUid, member.lineUid, member.userId]
      .map(value => String(value || "").trim())
      .includes(uid);
  });
  if (!found?.data) return { memberUid: uid, member: null, binding };
  return { memberUid: found.data.userId || String(found.key || "").replace(/^USER_/, ""), member: found.data, binding };
}

async function ensureLineOnlyCrmMember(env, ctx, lineUid, profile = null, source = "line_interaction") {
  const uid = String(lineUid || "").trim();
  if (!uid || !uid.startsWith("U")) return null;
  const resolved = await findHuaxuMemberByLineUid(env, uid).catch(() => ({ memberUid: uid, member: null }));
  if (resolved?.member) return resolved.member;
  let lineProfile = profile;
  if (!lineProfile || (!lineProfile.displayName && !lineProfile.name && !lineProfile.pictureUrl && !lineProfile.picture)) {
    lineProfile = await fetchLineBotProfile(env, uid).catch(() => profile || {});
  }
  const displayName = String(lineProfile?.displayName || lineProfile?.name || uid).trim();
  const pictureUrl = String(lineProfile?.pictureUrl || lineProfile?.picture || "").trim();
  const now = new Date();
  const member = {
    userId: uid,
    legacyMemberId: "",
    lineUserId: uid,
    linkedLineUid: uid,
    lineDisplayName: displayName,
    name: displayName,
    displayName,
    pictureUrl,
    phone: "",
    mobile: "",
    tel: "",
    memberTier: "一般會員",
    crmBindingStatus: "LINE_ONLY_PENDING_LEGACY",
    bindingStatus: "LINE 待綁定",
    source,
    createdAt: now.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }),
    updatedAt: now.toISOString(),
  };
  await putUserKV(env, ctx, uid, member);
  return member;
}

async function handleHuaxuMemberProfile(request, env) {
  const payload = await request.json().catch(() => ({}));
  let verifiedProfile = null;
  try {
    verifiedProfile = await verifyLineAccessToken(payload.accessToken);
  } catch (error) {
    verifiedProfile = null;
  }
  const lineUid = String(verifiedProfile?.sub || payload.lineUserId || payload.lineProfile?.userId || "").trim();
  if (!lineUid) return json({ ok: false, message: "尚未取得 LINE 身分" }, 401);
  const resolved = await findHuaxuMemberByLineUid(env, lineUid);
  const memberUid = resolved.memberUid || lineUid;
  const member = resolved.member || null;
  const registeredShipping = registeredShippingFromMember(member || {});
  const localPoints = await safeGetKV(env, `POINTS_${memberUid}`, { balance: 0, logs: [] });
  const orders = await getHuaxuShopOrders(env);
  const memberOrders = orders.filter(order => {
    const ids = [order.userId, order.lineProfile?.userId, order.memberUid, order.memberId].map(value => String(value || "").trim());
    return ids.includes(lineUid) || ids.includes(memberUid);
  });
  const safeMember = member ? {
    userId: member.userId || memberUid,
    lineUserId: member.lineUserId || lineUid,
    name: member.name || member.displayName || member.lineDisplayName || verifiedProfile?.name || "",
    displayName: member.displayName || member.name || verifiedProfile?.name || "",
    phone: member.phone || member.mobile || member.tel || member.memberPhone || "",
    gender: member.gender || "",
    birthday: member.birthday || "",
    email: member.email || "",
    address: member.address || "",
    postalCode: registeredShipping.postalCode,
    city: registeredShipping.city,
    district: registeredShipping.district,
    shippingAddress: registeredShipping.address,
    industry: member.industry || "",
    memberTier: member.memberTier || "一般會員",
    pictureUrl: member.pictureUrl || member.avatar || verifiedProfile?.picture || "",
    createdAt: member.createdAt || "",
    updatedAt: member.updatedAt || "",
  } : {
    userId: lineUid,
    lineUserId: lineUid,
    name: verifiedProfile?.name || payload.lineProfile?.displayName || "",
    displayName: verifiedProfile?.name || payload.lineProfile?.displayName || "",
    phone: "",
    gender: "",
    birthday: "",
    email: "",
    address: "",
    postalCode: "",
    city: "",
    district: "",
    shippingAddress: "",
    industry: "",
    memberTier: "一般會員",
    pictureUrl: verifiedProfile?.picture || payload.lineProfile?.pictureUrl || "",
  };
  const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
  const sharedPoints = await queryWetwPointList(settings, safeMember, env).catch(error => ({
    ok: false,
    reason: "wp_query_exception",
    message: error?.message || String(error),
  }));
  const displayPoints = resolveDisplayPointData(localPoints, sharedPoints, 10);
  return json({
    ok: true,
    bound: !!member,
    lineUserId: lineUid,
    memberUid,
    member: safeMember,
    points: {
      balance: displayPoints.balance,
      source: displayPoints.source,
      shared: displayPoints.shared,
      logs: displayPoints.logs,
    },
    orders: {
      count: memberOrders.length,
      latest: memberOrders.slice(0, 5).map(order => ({
        orderId: order.orderId,
        productName: order.productName || order.courseName || "",
        paymentMethod: order.paymentMethod || "",
        amount: order.amount,
        originalAmount: order.originalAmount,
        pointsUsed: order.pointsUsed,
        status: order.status,
        remittance: order.remittance || "",
        remittanceReportedAt: order.remittanceReportedAt || "",
        remittanceStatus: order.remittanceStatus || "",
        remittanceVerifiedAt: order.remittanceVerifiedAt || "",
        remittanceVerifiedBy: order.remittanceVerifiedBy || "",
        shippingCarrierName: order.shippingCarrierName || order.shipping?.carrierName || "",
        trackingNumber: order.trackingNumber || order.shipping?.trackingNumber || "",
        trackingUrl: order.trackingUrl || order.shipping?.trackingUrl || "",
        createdAt: order.createdAt || order.createdAtIso || "",
      })),
    },
    referrals: {
      count: Number(member?.referralCount || member?.shareCount || member?.referrals || 0) || 0,
    },
  });
}

async function handleHuaxuReportRemittance(request, env, ctx) {
  const payload = await request.json().catch(() => ({}));
  const orderId = String(payload.orderId || "").trim();
  const remittance = String(payload.remittance || "").replace(/\D/g, "").slice(0, 5);
  if (!orderId) return json({ ok: false, message: "\u7f3a\u5c11\u8a02\u55ae\u7de8\u865f" }, 400);
  if (remittance.length !== 5) return json({ ok: false, message: "\u8acb\u8f38\u5165\u532f\u6b3e\u5e33\u865f\u672b\u4e94\u78bc" }, 400);
  const lineUid = String(payload.lineProfile?.userId || payload.lineUserId || "").trim();
  if (!lineUid) return json({ ok: false, message: "\u5c1a\u672a\u53d6\u5f97 LINE \u8eab\u5206" }, 401);
  const resolved = await findHuaxuMemberByLineUid(env, lineUid);
  const memberUid = resolved.memberUid || lineUid;
  const orders = await safeGetKV(env, "ORDERS", []);
  const list = Array.isArray(orders) ? orders : [];
  const idx = list.findIndex(order => order && String(order.orderId || "") === orderId);
  if (idx < 0) return json({ ok: false, message: "\u627e\u4e0d\u5230\u8a02\u55ae" }, 404);
  const order = list[idx];
  const ownerIds = [order.userId, order.lineProfile?.userId, order.memberUid, order.memberId, order.pointsMemberUid].map(value => String(value || "").trim()).filter(Boolean);
  if (!ownerIds.includes(lineUid) && !ownerIds.includes(memberUid)) return json({ ok: false, message: "\u7121\u6cd5\u56de\u5831\u975e\u672c\u4eba\u8a02\u55ae" }, 403);
  const status = String(order.status || "").toUpperCase();
  if (status !== "PENDING") return json({ ok: false, message: "\u6b64\u8a02\u55ae\u76ee\u524d\u4e0d\u53ef\u56de\u5831\u532f\u6b3e" }, 400);
  if (String(order.paymentMethod || "").toUpperCase() !== "REMITTANCE") return json({ ok: false, message: "\u7121\u6cd5\u56de\u5831\u975e\u672c\u4eba\u8a02\u55ae" }, 400);
  const nowText = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  const nowIso = new Date().toISOString();
  const updated = { ...order, remittance, remittanceReportedAt: nowText, remittanceReportedAtIso: nowIso, remittanceStatus: "REPORTED", updatedAt: nowIso };
  list[idx] = updated;
  await putOrdersKV(env, ctx, list);
  if (ctx) ctx.waitUntil(Promise.all([
    env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(() => {}),
    sendTelegramNotification(env, [
      "\u{1F3E6} <b>\u532f\u6b3e\u672b\u4e94\u78bc\u56de\u5831</b>",
      `\u55ae\u865f\uFF1A<code>${escapeTelegramHtml(updated.orderId)}</code>`,
      `\u6703\u54e1\uFF1A${escapeTelegramHtml(updated.name || updated.recipientName || "-")}`,
      `\u96fb\u8a71\uFF1A${escapeTelegramHtml(updated.phone || updated.recipientPhone || "-")}`,
      `\u672b\u4e94\u78bc\uFF1A<code>${escapeTelegramHtml(remittance)}</code>`,
      `\u91d1\u984d\uFF1A${Number(updated.amount || 0)}`,
    ].join("\n")),
  ]));
  return json({ ok: true, order: updated });
}
async function handleHuaxuUpdateMemberProfile(request, env, ctx) {
  const payload = await request.json().catch(() => ({}));
  let verifiedProfile = null;
  try {
    verifiedProfile = await verifyLineAccessToken(payload.accessToken);
  } catch (error) {
    verifiedProfile = null;
  }
  const lineUid = String(verifiedProfile?.sub || payload.lineUserId || payload.lineProfile?.userId || "").trim();
  if (!lineUid) return json({ ok: false, message: "尚未取得 LINE 身分" }, 401);
  const resolved = await findHuaxuMemberByLineUid(env, lineUid);
  const memberUid = resolved.memberUid || lineUid;
  const profile = payload.profile || payload.member || {};
  const phone = normalizeMemberPhone(profile.phone || profile.mobile || profile.tel || profile.memberPhone || "");
  const now = new Date().toISOString();
  const current = resolved.member || {};
  const nextMember = {
    ...current,
    userId: current.userId || memberUid,
    lineUserId: current.lineUserId || lineUid,
    linkedLineUid: current.linkedLineUid || lineUid,
    lineDisplayName: verifiedProfile?.name || profile.displayName || current.lineDisplayName || "",
    displayName: String(profile.displayName || profile.name || current.displayName || verifiedProfile?.name || "").trim(),
    name: String(profile.name || profile.displayName || current.name || verifiedProfile?.name || "").trim(),
    phone,
    mobile: phone,
    gender: String(profile.gender || current.gender || "").trim().slice(0, 20),
    birthday: String(profile.birthday || current.birthday || "").trim().slice(0, 30),
    email: String(profile.email || current.email || "").trim().slice(0, 120),
    address: String(profile.address || current.address || "").trim().slice(0, 240),
    industry: String(profile.industry || current.industry || "").trim().slice(0, 120),
    memberTier: current.memberTier || "一般會員",
    pictureUrl: current.pictureUrl || verifiedProfile?.picture || payload.lineProfile?.pictureUrl || "",
    createdAt: current.createdAt || now,
    updatedAt: now,
    source: current.source || "huaxu_shop_member",
  };
  await putUserKV(env, ctx, memberUid, nextMember);
  await safePutKV(env, `LINE_BIND_${lineUid}`, {
    lineUserId: lineUid,
    legacyUserId: memberUid,
    phone,
    updatedAt: now,
    source: "huaxu_shop_profile",
  }, { expirationTtl: 86400 * 3650 }).catch(() => {});
  return json({
    ok: true,
    bound: true,
    lineUserId: lineUid,
    memberUid,
    member: {
      userId: nextMember.userId,
      lineUserId: nextMember.lineUserId,
      name: nextMember.name,
      displayName: nextMember.displayName,
      phone: nextMember.phone,
      gender: nextMember.gender,
      birthday: nextMember.birthday,
      email: nextMember.email,
      address: nextMember.address,
      industry: nextMember.industry,
      memberTier: nextMember.memberTier,
      pictureUrl: nextMember.pictureUrl,
      createdAt: nextMember.createdAt,
      updatedAt: nextMember.updatedAt,
    },
  });
}

async function handleHuaxuMemberCheckin(request, env, ctx) {
  const payload = await request.json().catch(() => ({}));
  let verifiedProfile = null;
  try {
    verifiedProfile = await verifyLineAccessToken(payload.accessToken);
  } catch (error) {
    verifiedProfile = null;
  }
  const lineUid = String(verifiedProfile?.sub || payload.lineUserId || payload.lineProfile?.userId || "").trim();
  if (!lineUid) return json({ ok: false, message: "尚未取得 LINE 身分" }, 401);
  const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
  const keyword = String(payload.keyword || settings.shop_checkin_keyword || env.SHOP_CHECKIN_KEYWORD || "會員打卡").trim();
  const forwardWebhook = getMotherWebhookUrl(env, settings);
  const now = new Date();
  const dateKey = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
  const recordKey = `CHECKIN_${lineUid}_${dateKey}`;
  const existing = await safeGetKV(env, recordKey, null).catch(() => null);
  if (existing?.forwarded) {
    return json({ ok: true, alreadyCheckedIn: true, message: "今日已完成打卡", record: existing });
  }
  const event = {
    type: "message",
    mode: "active",
    timestamp: now.getTime(),
    source: { type: "user", userId: lineUid },
    replyToken: `hooktea-checkin-${now.getTime()}`,
    message: {
      id: `huaxu-checkin-${now.getTime()}`,
      type: "text",
      text: keyword,
    },
  };
  const forwardPayload = {
    destination: String(env.LINE_BOT_USER_ID || settings.line_bot_user_id || ""),
    events: [event],
  };
  const attempt = {
    lineUserId: lineUid,
    displayName: verifiedProfile?.name || payload.lineProfile?.displayName || "",
    keyword,
    url: forwardWebhook,
    dateKey,
    attemptedAt: now.toISOString(),
  };
  await safePutKV(env, "HUAXU_CHECKIN_ATTEMPT_LAST", attempt, { expirationTtl: 86400 }).catch(() => {});
  let result = null;
  try {
    const response = await fetch(forwardWebhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-line-signature": "",
        "x-hooktea-forwarded-by": "huaxu-shop-checkin",
      },
      body: JSON.stringify(forwardPayload),
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    const responseText = await response.text().catch(error => `response_text_error:${error?.message || String(error)}`);
    result = {
      ...attempt,
      forwarded: response.ok,
      status: response.status,
      ok: response.ok,
      response: responseText.slice(0, 300),
      forwardedAt: new Date().toISOString(),
    };
  } catch (error) {
    result = {
      ...attempt,
      forwarded: false,
      ok: false,
      error: error?.message || String(error),
      forwardedAt: new Date().toISOString(),
    };
  }
  await safePutKV(env, "HUAXU_CHECKIN_FORWARD_LAST", result, { expirationTtl: 86400 }).catch(() => {});
  if (result.forwarded) await safePutKV(env, recordKey, result, { expirationTtl: 86400 * 7 }).catch(() => {});
  return json({
    ok: !!result.forwarded,
    message: result.forwarded ? "打卡已送出" : "打卡送出失敗",
    keyword,
    status: result.status || 0,
    response: result.response || "",
    error: result.error || "",
  }, result.forwarded ? 200 : 502);
}

async function handleHuaxuCreateOrder(request, env, ctx, apiHandler) {
  const payload = await request.json().catch(() => null);
  if (!payload || !Array.isArray(payload.items) || !payload.items.length) {
    return json({ ok: false, message: "購物車是空的" }, 400);
  }
  const products = await getHuaxuShopProducts(env);
  const byId = new Map(products.map(item => [item.id, item]));
  const items = payload.items.map(item => {
    const product = byId.get(String(item.id || ""));
    const quantity = Math.max(1, Math.min(99, Number(item.quantity || 1)));
    return product ? { ...product, quantity, lineTotal: product.price * quantity } : null;
  }).filter(Boolean);
  if (!items.length) return json({ ok: false, message: "找不到有效商品" }, 400);

  const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const lineProfile = {
    userId: String(payload.lineProfile?.userId || "").slice(0, 80),
    displayName: String(payload.lineProfile?.displayName || "").slice(0, 80),
    pictureUrl: String(payload.lineProfile?.pictureUrl || "").slice(0, 300),
  };
  const sameAsRegistered = payload.sameAsRegistered === true || payload.customer?.sameAsRegistered === true;
  let customer = {
    name: String(payload.customer?.name || "").trim().slice(0, 80),
    phone: normalizeMemberPhone(payload.customer?.phone || "").slice(0, 40),
    email: String(payload.customer?.email || "").trim().slice(0, 120),
    postalCode: String(payload.customer?.postalCode || "").trim().slice(0, 12),
    city: String(payload.customer?.city || "").trim().slice(0, 40),
    district: String(payload.customer?.district || "").trim().slice(0, 40),
    address: String(payload.customer?.address || "").trim().slice(0, 160),
    shippingStoreInfo: String(payload.customer?.shippingStoreInfo || payload.shippingStoreInfo || "").trim().slice(0, 120),
    note: String(payload.customer?.note || "").trim().slice(0, 300),
  };
  if (sameAsRegistered) {
    if (!lineProfile.userId) return json({ ok: false, message: "尚未取得 LINE 身分，無法套用註冊人資料" }, 401);
    const resolvedMember = await findHuaxuMemberByLineUid(env, lineProfile.userId);
    if (!resolvedMember.member) return json({ ok: false, message: "尚未找到註冊會員資料，請改用手填收件資料" }, 400);
    const registeredCustomer = registeredShippingFromMember(resolvedMember.member);
    customer = {
      ...customer,
      ...registeredCustomer,
      note: customer.note,
    };
    const missingRegistered = missingShippingFields(customer);
    if (missingRegistered.length) {
      return json({ ok: false, message: `註冊資料不完整，缺少：${missingRegistered.join("、")}。請先補齊會員資料或改用手填收件資料。` }, 400);
    }
  }
  const missingCustomer = missingShippingFields(customer);
  if (missingCustomer.length) {
    return json({ ok: false, message: `請填寫完整收件資料：${missingCustomer.join("、")}` }, 400);
  }
  const shippingValidation = validateHuaxuShippingCustomer(customer);
  if (!shippingValidation.ok) {
    return json({ ok: false, message: `\u6536\u4ef6\u8cc7\u6599\u683c\u5f0f\u4e0d\u5b8c\u6574\uff1a${shippingValidation.errors.join("\u3001")}` }, 400);
  }
  customer.phone = shippingValidation.phone;
  customer.city = shippingValidation.city || customer.city;
  customer.district = shippingValidation.district || customer.district;
  customer.address = shippingValidation.address || customer.address;
  const shippingAddress = [customer.postalCode, customer.city, customer.district, customer.address].filter(Boolean).join(" ");
  const entryParams = payload.entryParams && typeof payload.entryParams === "object" && !Array.isArray(payload.entryParams)
    ? Object.fromEntries(Object.entries(payload.entryParams).map(([key, value]) => [String(key).slice(0, 80), String(value ?? "").slice(0, 500)]))
    : {};
  const requestedPointsUsed = Math.max(0, Math.floor(Number(payload.pointsUsed || payload.pointDeduction || 0)));
  const maxPointDeduction = Math.max(0, Math.floor(items.reduce((sum, item) => {
    const itemPointLimit = Number(item.pointsPrice ?? item.pointPrice ?? item.price ?? 0) || 0;
    return sum + Math.min(item.lineTotal, Math.max(0, itemPointLimit) * item.quantity);
  }, 0)));
  let memberUidForPoints = "";
  let pointDataForOrder = { balance: 0, logs: [] };
  let pointsUsed = Math.min(requestedPointsUsed, total, maxPointDeduction);
  if (requestedPointsUsed > 0 && pointsUsed <= 0) {
    return json({ ok: false, message: "本次商品未開放點數折抵" }, 400);
  }
  if (pointsUsed > 0) {
    if (!lineProfile.userId) return json({ ok: false, message: "請先完成 LINE 登入，才能使用點數折抵" }, 401);
    const resolvedForPoints = await findHuaxuMemberByLineUid(env, lineProfile.userId);
    memberUidForPoints = resolvedForPoints.memberUid || lineProfile.userId;
    const localPointData = await safeGetKV(env, `POINTS_${memberUidForPoints}`, { balance: 0, logs: [] });
    const memberForPoints = resolvedForPoints.member || { userId: memberUidForPoints, lineUserId: lineProfile.userId };
    const pointSettings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
    const sharedPointData = await queryWetwPointList(pointSettings, memberForPoints, env).catch(error => ({
      ok: false,
      reason: "wp_query_exception",
      message: error?.message || String(error),
    }));
    const displayPointData = resolveDisplayPointData(localPointData, sharedPointData, 50);
    pointDataForOrder = { ...localPointData, balance: displayPointData.balance };
    if (Number(displayPointData.balance || 0) !== Number(localPointData.balance || 0)) {
      await putPointKV(env, ctx, memberUidForPoints, pointDataForOrder);
    }
    const balance = Math.max(0, Math.floor(Number(pointDataForOrder.balance || 0)));
    if (balance <= 0) return json({ ok: false, message: "目前沒有可折抵點數" }, 400);
    if (requestedPointsUsed > maxPointDeduction) return json({ ok: false, message: `本次商品最高可折抵 ${maxPointDeduction} 點` }, 400);
    if (pointsUsed > balance) return json({ ok: false, message: `點數不足，目前可用 ${balance} 點` }, 400);
  }
  const payableTotal = Math.max(0, total - pointsUsed);
  const requestedMethod = String(payload.paymentMethod || "LINEPAY").toUpperCase();
  const paymentMethod = payableTotal <= 0 ? "POINTS" : (["LINEPAY", "REMITTANCE", "COD"].includes(requestedMethod) ? requestedMethod : "LINEPAY");
  const requestedShippingCarrier = String(payload.shippingCarrier || payload.customer?.shippingCarrier || "").toUpperCase();
  const shippingCarrier = ["FAMILY", "SEVEN", "POST"].includes(requestedShippingCarrier) ? requestedShippingCarrier : "FAMILY";
  const shippingCarrierName = {
    FAMILY: "全家",
    SEVEN: "7-11",
    POST: "中華郵政",
  }[shippingCarrier] || "全家";
  const itemFingerprint = items
    .map(item => `${item.id}:${item.quantity}:${item.price}`)
    .sort()
    .join("|");
  const providedClientOrderKey = String(payload.clientOrderKey || "").trim().slice(0, 120);
  const fallbackClientOrderKey = await sha256HexBody(JSON.stringify({
    items: itemFingerprint,
    customer,
    lineUserId: lineProfile.userId || "",
    paymentMethod,
    pointsUsed,
  }));
  const clientOrderKey = providedClientOrderKey || fallbackClientOrderKey;
  const pendingKey = `HUAXU_ORDER_PENDING_${clientOrderKey}`;
  const existingPending = await safeGetKV(env, pendingKey, null).catch(() => null);
  if (existingPending?.status === "CREATING") {
    return json({ ok: false, processing: true, message: "訂單處理中，請勿重複送出" }, 409);
  }
  if (existingPending?.order) {
    return json({
      ok: true,
      duplicate: true,
      order: existingPending.order,
      payment: existingPending.payment || null,
      remittanceInfo: existingPending.remittanceInfo || "",
    });
  }
  await safePutKV(env, pendingKey, {
    status: "CREATING",
    createdAt: new Date().toISOString(),
  }, { expirationTtl: 120 }).catch(() => {});
  const order = {
    orderId: `HX${Date.now()}`,
    type: "PRODUCT",
    source: "huaxu-shop",
    userId: lineProfile.userId || "",
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    postalCode: customer.postalCode,
    city: customer.city,
    district: customer.district,
    address: shippingAddress,
    shipping: {
      recipientName: customer.name,
      recipientPhone: customer.phone,
      recipientEmail: customer.email,
      postalCode: customer.postalCode,
      city: customer.city,
      district: customer.district,
      address: customer.address,
      fullAddress: shippingAddress,
      carrier: shippingCarrier,
      carrierName: shippingCarrierName,
      storeInfo: customer.shippingStoreInfo,
      trackingNumber: "",
      trackingUrl: "",
      note: customer.note,
      sameAsRegistered,
    },
    recipientName: customer.name,
    recipientPhone: customer.phone,
    recipientEmail: customer.email,
    shippingPostalCode: customer.postalCode,
    shippingCity: customer.city,
    shippingDistrict: customer.district,
    shippingAddress,
    note: customer.note,
    productId: items.map(item => item.id).join(","),
    productName: items.map(item => `${item.name}${item.quantity > 1 ? ` x ${item.quantity}` : ""}`).join("\n"),
    productCode: items.map(item => item.code).filter(Boolean).join(","),
    quantity: items.reduce((sum, item) => sum + item.quantity, 0),
    originalAmount: total,
    amount: payableTotal,
    pointsUsed,
    pointBalanceBefore: pointsUsed > 0 ? Math.max(0, Math.floor(Number(pointDataForOrder.balance || 0))) : 0,
    pointsMemberUid: memberUidForPoints,
    paymentMethod,
    shippingCarrier,
    shippingCarrierName,
    shippingStoreInfo: customer.shippingStoreInfo,
    trackingNumber: "",
    trackingUrl: "",
    sameAsRegistered,
    status: payableTotal > 0 ? "PENDING" : "PAID",
    entryUrl: String(payload.entryUrl || "").slice(0, 1000),
    entryParams,
    clientOrderKey,
    items: items.map(item => ({
      id: item.id,
      name: item.name,
      code: item.code,
      price: item.price,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
      pointsPrice: item.pointsPrice || item.pointPrice || item.price || 0,
    })),
    lineProfile,
    createdAt: new Date().toLocaleString(),
    createdAtIso: new Date().toISOString(),
  };
  const orders = await safeGetKV(env, "ORDERS", []);
  const nextOrders = [order, ...(Array.isArray(orders) ? orders : [])].slice(0, 2000);
  await putOrdersKV(env, ctx, nextOrders);
  if (ctx) ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(() => {}));

  let payment = null;
  let remittanceInfo = "";
  if (payableTotal > 0 && paymentMethod === "REMITTANCE") {
    const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
    remittanceInfo = String(
      settings.remittance_info ||
      settings.bankTransferInfo ||
      settings.bank_account ||
      settings.bankAccount ||
      env.REMITTANCE_INFO ||
      "尚未設定匯款帳號，請等候客服提供匯款資訊。"
    );
    payment = { provider: "REMITTANCE", orderId: order.orderId, status: "PENDING" };
  } else if (payableTotal > 0 && paymentMethod === "COD") {
    payment = { provider: "COD", orderId: order.orderId, status: "PENDING" };
  } else if (payableTotal > 0 && apiHandler?.preparePayment) {
    const workerUrl = String(payload.workerUrl || new URL(request.url).origin).replace(/\/+$/, "");
    const returnUrl = String(payload.returnUrl || `${workerUrl}/huaxu-shop.html`);
    try {
      payment = await apiHandler.preparePayment({
        orderId: order.orderId,
        amount: payableTotal,
        courseName: order.productName,
        paymentMethod,
        email: customer.email,
        workerUrl,
        returnUrl,
      }, env);
    } catch (error) {
      return json({ ok: false, message: error?.message || "付款建立失敗，請稍後再試。", order }, 502);
    }
  }
  if (pointsUsed > 0 && apiHandler?.updatePoints) {
    await apiHandler.updatePoints(env, ctx, memberUidForPoints, -pointsUsed, `購物車點數折抵：${order.orderId}`, {
      source: "huaxu_shop_checkout",
      targetName: customer.name,
    });
    order.pointsDeductedAt = new Date().toISOString();
    order.pointBalanceAfter = Math.max(0, Math.floor(Number(pointDataForOrder.balance || 0))) - pointsUsed;
    const refreshedOrders = await safeGetKV(env, "ORDERS", []);
    const orderIndex = Array.isArray(refreshedOrders) ? refreshedOrders.findIndex(item => item?.orderId === order.orderId) : -1;
    if (orderIndex >= 0) {
      refreshedOrders[orderIndex] = { ...refreshedOrders[orderIndex], ...order };
      await putOrdersKV(env, ctx, refreshedOrders);
    }
  }
  await safePutKV(env, pendingKey, {
    status: "CREATED",
    order,
    payment,
    remittanceInfo,
    createdAt: new Date().toISOString(),
  }, { expirationTtl: 120 }).catch(() => {});
  if (ctx) ctx.waitUntil(sendTelegramNotification(env, [
    "\u{1F6D2} <b>HookTea \u8cfc\u7269\u8eca\u65b0\u8a02\u55ae</b>",
    `\u55ae\u865f\uFF1A<code>${escapeTelegramHtml(order.orderId)}</code>`,
    `\u6536\u4ef6\u4eba\uFF1A${escapeTelegramHtml(order.recipientName || order.name || "-")}` ,
    `\u96fb\u8a71\uFF1A${escapeTelegramHtml(order.recipientPhone || order.phone || "-")}` ,
    `\u5546\u54c1\uFF1A${escapeTelegramHtml(order.productName || "-")}` ,
    `\u91d1\u984d\uFF1A${Number(order.amount || 0)}${Number(order.pointsUsed || 0) > 0 ? `\uFF08\u9ede\u6578\u6298\u62b5 ${Number(order.pointsUsed || 0)}\uFF09` : ""}` ,
    `\u7269\u6d41\uFF1A${escapeTelegramHtml(order.shippingCarrierName || "-")}` ,
    `\u9580\u5e02\uFF1A${escapeTelegramHtml(order.shippingStoreInfo || order.shipping?.storeInfo || "-")}` ,
    `\u4ed8\u6b3e\uFF1A${escapeTelegramHtml(order.paymentMethod || "-")}` ,
    `\u72c0\u614b\uFF1A${escapeTelegramHtml(order.status || "-")}` ,
  ].join("\n")));
  return json({ ok: true, order, payment, remittanceInfo });
}

async function handleHuaxuCancelOrder(request, env, ctx, apiHandler) {
  const payload = await request.json().catch(() => ({}));
  const orderId = String(payload.orderId || "").trim();
  if (!orderId) return json({ ok: false, message: "缺少訂單編號" }, 400);
  const lineUid = String(payload.lineProfile?.userId || payload.lineUserId || "").trim();
  if (!lineUid) return json({ ok: false, message: "尚未取得 LINE 身分" }, 401);
  const resolved = await findHuaxuMemberByLineUid(env, lineUid);
  const memberUid = resolved.memberUid || lineUid;
  const orders = await safeGetKV(env, "ORDERS", []);
  const list = Array.isArray(orders) ? orders : [];
  const idx = list.findIndex(order => order && String(order.orderId || "") === orderId);
  if (idx < 0) return json({ ok: false, message: "找不到訂單" }, 404);
  const order = list[idx];
  const ownerIds = [order.userId, order.lineProfile?.userId, order.memberUid, order.memberId, order.pointsMemberUid]
    .map(value => String(value || "").trim())
    .filter(Boolean);
  if (!ownerIds.includes(lineUid) && !ownerIds.includes(memberUid)) {
    return json({ ok: false, message: "無法取消非本人訂單" }, 403);
  }
  const status = String(order.status || "").toUpperCase();
  if (["PAID", "PREPARING", "SHIPPED", "COMPLETED"].includes(status)) {
    return json({ ok: false, message: "\u6b64\u8a02\u55ae\u5df2\u4ed8\u6b3e\u6216\u5df2\u9032\u5165\u914d\u9001\uff0c\u8acb\u806f\u7d61\u5ba2\u670d\u8655\u7406" }, 400);
  }
  if (status === "CANCELLED") return json({ ok: true, order, duplicate: true });

  const nowIso = new Date().toISOString();
  const patch = {
    status: "CANCELLED",
    paymentStatus: "CANCELLED",
    cancelledAt: nowIso,
    cancelReason: String(payload.reason || "會員自行取消").slice(0, 120),
  };
  const pointsToRestore = Math.max(0, Math.floor(Number(order.pointsUsed || 0)));
  const restoreUid = String(order.pointsMemberUid || memberUid || lineUid).trim();
  if (pointsToRestore > 0 && order.pointsDeductedAt && !order.pointsRestoredAt && restoreUid && apiHandler?.updatePoints) {
    await apiHandler.updatePoints(env, ctx, restoreUid, pointsToRestore, `取消訂單回補：${orderId}`, {
      source: "huaxu_shop_cancel",
      targetName: order.name || order.recipientName || "",
    });
    patch.pointsRestoredAt = nowIso;
    patch.pointRestoreReason = "ORDER_CANCEL";
  }
  list[idx] = { ...order, ...patch, updatedAt: nowIso };
  await putOrdersKV(env, ctx, list);
  await appendPaymentLog(env, {
    timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }),
    orderNo: orderId,
    amount: Number(order.amount || 0),
    status: "CANCELLED",
    message: pointsToRestore > 0 ? `會員取消訂單，回補 ${pointsToRestore} 點` : "會員取消訂單",
    tradeNo: String(order.linePayTransactionId || ""),
    source: "HUAXU_ORDER_CANCEL",
  }).catch(() => {});
  if (ctx) ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(() => {}));
  return json({ ok: true, order: list[idx], pointsRestored: pointsToRestore });
}

async function handleHuaxuLiffDebug(request, env) {
  const payload = await request.json().catch(() => ({}));
  const entry = {
    step: String(payload.step || "").slice(0, 80),
    detail: String(payload.detail || "").slice(0, 300),
    liffId: String(payload.liffId || "").slice(0, 80),
    href: String(payload.href || "").slice(0, 500),
    isInClient: Boolean(payload.isInClient),
    isLoggedIn: Boolean(payload.isLoggedIn),
    userId: String(payload.userId || "").slice(0, 100),
    createdAt: new Date().toISOString(),
  };
  await safePutKV(env, "HUAXU_LIFF_DEBUG_LAST", entry, { expirationTtl: 86400 }).catch(() => {});
  const rows = await safeGetKV(env, "HUAXU_LIFF_DEBUG_LOG", []).catch(() => []);
  const nextRows = [entry, ...(Array.isArray(rows) ? rows : [])].slice(0, 50);
  await safePutKV(env, "HUAXU_LIFF_DEBUG_LOG", nextRows, { expirationTtl: 86400 }).catch(() => {});
  return json({ ok: true });
}

async function handleHuaxuShopRoute(request, env, ctx, apiHandler) {
  const url = new URL(request.url);
  if (url.pathname === "/api/huaxu/config" && request.method === "GET") return json(await getHuaxuShopConfig(env));
  if (url.pathname === "/api/huaxu/products" && request.method === "GET") return json(await getHuaxuShopProducts(env));
  if (url.pathname === "/api/huaxu/orders" && request.method === "GET") return json(await getHuaxuShopOrders(env));
  if (url.pathname === "/api/huaxu/member" && request.method === "POST") return handleHuaxuMemberProfile(request, env);
  if (url.pathname === "/api/huaxu/member" && request.method === "PUT") return handleHuaxuUpdateMemberProfile(request, env, ctx);
  if (url.pathname === "/api/huaxu/checkin" && request.method === "POST") return handleHuaxuMemberCheckin(request, env, ctx);
  if (url.pathname === "/api/huaxu/liff-debug" && request.method === "POST") return handleHuaxuLiffDebug(request, env);
  if (url.pathname === "/api/huaxu/orders/remittance" && request.method === "POST") return handleHuaxuReportRemittance(request, env, ctx);
  if (url.pathname === "/api/huaxu/orders/cancel" && request.method === "POST") return handleHuaxuCancelOrder(request, env, ctx, apiHandler);
  if (url.pathname === "/api/huaxu/orders" && request.method === "POST") return handleHuaxuCreateOrder(request, env, ctx, apiHandler);
  if (url.pathname === "/huaxu-shop.html" || url.pathname === "/huaxu-shop") {
    const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
    const shopLiffId = String(settings.shop_liff_id || env.SHOP_LIFF_ID || "2007674851-ijenzSk8").trim();
    return new Response(renderHuaxuShopHtml(shopLiffId), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return null;
}

function renderHuaxuShopHtml(shopLiffId = "2007674851-ijenzSk8") {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>HookTea 購物商城</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#050505;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.app{max-width:480px;min-height:100vh;margin:0 auto;background:#050505;padding-bottom:88px}.top{position:sticky;top:0;z-index:20;background:#050505;padding:18px 18px 14px;display:flex;align-items:center;gap:18px;border-bottom:1px solid #161616}.icon{width:38px;height:38px;border:0;background:transparent;color:#fff;font-size:28px}.brand{flex:1;font-weight:900;letter-spacing:.02em}.brand small{display:block;color:#8d8d8d;font-size:12px;margin-top:2px}.tabs{padding:22px 18px 12px}.tabs h2{margin:0 0 14px;font-size:20px}.tabrow{display:flex;gap:10px;overflow:auto;padding-bottom:4px}.pill{white-space:nowrap;border:1px solid #1b1b1b;background:#111;color:#fff;border-radius:8px;padding:10px 14px;font-weight:800}.pill.active{background:#09251f;border-color:#16c7a2;color:#7fffe2}.hero{position:relative;min-height:310px;background:linear-gradient(135deg,#083172,#07142f 55%,#000);overflow:hidden}.hero:before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 75% 20%,rgba(255,210,92,.32),transparent 28%)}.hero-content{position:relative;padding:26px 22px}.hero-kicker{display:inline-block;background:#d7ae4f;color:#101010;border-radius:7px;padding:7px 11px;font-weight:900}.hero h1{font-size:38px;line-height:1.05;margin:18px 0 10px;color:#ffe28d;text-shadow:0 3px 0 #1a1a1a}.hero p{font-size:15px;line-height:1.5;max-width:300px;color:#f3f3f3}.section{padding:22px 16px}.section h2{margin:0 0 14px;font-size:22px}.products{display:grid;grid-template-columns:1fr 1fr;gap:12px}.card{background:#111;border:1px solid #202020;border-radius:10px;overflow:hidden}.product-link,.product-title{display:block;width:100%;padding:0;border:0;background:transparent;color:inherit;text-align:left;text-decoration:none}.card img{width:100%;aspect-ratio:1/1;object-fit:cover;display:block}.card-body{padding:12px}.badge{display:inline-block;background:#062a22;color:#78ffde;border:1px solid #0b6f5a;border-radius:999px;padding:4px 8px;font-size:12px;font-weight:900}.card h3{font-size:16px;line-height:1.25;margin:10px 0 4px}.card p{color:#aaa;font-size:12px;line-height:1.45;margin:0 0 10px;min-height:32px;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}.price{font-weight:900;color:#ffe28d;font-size:20px}.original{font-size:12px;color:#777;text-decoration:line-through;margin-left:4px}.buy{width:100%;margin-top:10px;border:0;border-radius:7px;background:#13b99a;color:#04100d;font-weight:900;padding:10px}.source-link{display:block;width:100%;border:0;background:transparent;text-align:center;color:#8d8d8d;text-decoration:none;font-size:12px;font-weight:800;margin-top:8px;padding:4px}.source-link:hover{color:#fff}.nav{position:fixed;left:50%;bottom:0;transform:translateX(-50%);width:100%;max-width:480px;background:#050505;border-top:1px solid #151515;display:grid;grid-template-columns:repeat(4,1fr);padding:9px 0 calc(9px + env(safe-area-inset-bottom));z-index:25}.nav button{background:transparent;border:0;color:#fff;font-size:25px;position:relative}.nav small{display:block;font-size:11px;margin-top:2px}.count{position:absolute;top:-2px;right:28%;background:#13b99a;color:#00110d;border-radius:999px;font-size:12px;min-width:20px;padding:2px 5px}.drawer,.cart,.detail{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.45);display:none}.panel{width:82%;max-width:370px;height:100%;background:#050505;padding:24px 18px;overflow:auto}.panel.right{margin-left:auto}.cart .panel{width:100%;max-width:480px;margin:0 auto;padding-bottom:104px}.drawer.open,.cart.open,.detail.open{display:block}.cart-head{position:sticky;top:-24px;z-index:3;margin:-24px -18px 16px;padding:18px;background:#050505;border-bottom:1px solid #161616;display:flex;align-items:center;justify-content:space-between}.cart-head h2{margin:0}.cart-close{width:42px;height:42px;border:1px solid #2a2a2a;border-radius:10px;background:#111;color:#fff;font-size:24px;font-weight:900}.menu-logo{font-weight:900;margin-bottom:32px}.menu-item{border-bottom:1px solid #333;padding:16px 0;font-size:20px;font-weight:800}.cart-item{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid #222;padding:14px 0}.cart-item button{background:#222;color:#fff;border:0;border-radius:6px;padding:7px 10px}.field{width:100%;background:#111;border:1px solid #2a2a2a;color:#fff;border-radius:7px;padding:12px;margin:8px 0;font-size:16px}.form-title{margin:18px 0 8px;color:#f7d979;font-size:14px;font-weight:900}.form-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.required-hint{color:#8d8d8d;font-size:12px;line-height:1.5;margin:4px 0 8px}.checkout{width:100%;border:0;border-radius:8px;background:#13b99a;color:#04100d;font-weight:900;padding:14px;font-size:16px;margin-top:12px}.detail-card img{width:100%;border-radius:10px;aspect-ratio:1/1;object-fit:cover}.detail-card h2{font-size:24px;line-height:1.2;margin:16px 0 8px}.detail-desc{white-space:pre-wrap;color:#d7d7d7;font-size:14px;line-height:1.7;margin-top:14px}.detail-close{border:0;background:#151515;color:#fff;border-radius:8px;padding:10px 12px;font-weight:900}.empty{color:#888;padding:24px 0}.toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:#13b99a;color:#04100d;border-radius:999px;padding:12px 18px;font-weight:900;display:none;z-index:60}.toast.show{display:block}
    .profile-button{width:42px;height:42px;border:1px solid #242424;border-radius:999px;background:#111;color:#fff;display:grid;place-items:center;overflow:hidden}.profile-button.ready{border-color:#13b99a}.profile-button img{width:100%;height:100%;object-fit:cover;display:none}.profile-button.ready img{display:block}.profile-button.ready span{display:none}.profile-button span{font-size:18px;font-weight:900}.category-head{position:relative;display:inline-block}.category-trigger{border:0;background:transparent;color:#fff;font-size:20px;font-weight:900;padding:0 24px 0 0}.category-trigger:after{content:"";position:absolute;right:0;top:50%;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid #fff;transform:translateY(-25%)}.category-menu{position:absolute;left:0;top:30px;z-index:30;min-width:178px;background:#fff;color:#111;border-radius:2px;box-shadow:0 8px 18px rgba(0,0,0,.28);padding:8px 0;display:none}.category-menu.open{display:block}.category-menu button{display:block;width:100%;border:0;background:#fff;color:#111;text-align:left;font-size:16px;font-weight:900;padding:12px 20px}.category-menu button.active,.category-menu button:hover{background:#f1f5f9}.same-member{display:flex;align-items:center;gap:9px;border:1px solid #2a2a2a;background:#101010;border-radius:8px;padding:10px 12px;margin:10px 0 8px;color:#fff;font-weight:900}.same-member input{width:18px;height:18px;accent-color:#13b99a}.same-member-hint{display:none;color:#9ca3af;font-size:12px;line-height:1.45;margin:-2px 0 8px}.same-member-hint.warn{display:block;color:#fbbf24}.same-member-hint.ok{display:block;color:#5eead4}.pay-title{color:#aaa;font-size:12px;font-weight:900;margin:12px 0 8px}.pay-options{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.pay-option{border:1px solid #2a2a2a;border-radius:7px;background:#111;color:#fff;font-weight:900;padding:10px 6px}.pay-option.active{background:#13b99a;color:#04100d;border-color:#13b99a}.pay-option:disabled{opacity:.38}.checkout-block{border:1px solid #242424;background:#0f0f0f;border-radius:10px;padding:12px;margin:14px 0}.summary-row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;color:#d1d5db;font-size:14px}.summary-row.total{border-top:1px solid #262626;margin-top:6px;padding-top:10px;color:#fff;font-size:17px;font-weight:900}.point-row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}.point-row .field{margin:0}.mini-button{border:0;border-radius:7px;background:#243127;color:#7fffe2;font-weight:900;padding:12px 10px}.point-note{color:#9ca3af;font-size:12px;line-height:1.45;margin-top:8px}.point-note.warn{color:#fbbf24}
    .section-tabs{display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;margin:-2px -10px 14px;padding:0 10px 5px;scroll-snap-type:x proximity}.section-tabs::-webkit-scrollbar{height:0}.section-tab{flex:0 1 auto;min-width:0;max-width:108px;scroll-snap-align:start;border:1px solid #242424;background:#111;color:#fff;border-radius:7px;padding:8px 9px;font-size:12px;font-weight:900;line-height:1.15;white-space:normal;word-break:keep-all;text-align:center}.section-tab.active{background:#08271f;border-color:#15c6a3;color:#80ffe2;box-shadow:inset 0 0 0 1px rgba(19,185,154,.28)}@media(max-width:390px){.section-tabs{gap:5px;margin-left:-8px;margin-right:-8px;padding-left:8px;padding-right:8px}.section-tab{max-width:96px;padding:7px 7px;font-size:11px}}
    .member{position:fixed;inset:0;z-index:50;background:#f4f6f8;color:#020b1c;display:none;overflow:auto}.member.open{display:block}.member-sheet{max-width:480px;min-height:100%;margin:0 auto;padding:20px 18px 96px}.member-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.member-top h2{margin:0;font-size:24px}.member-close{width:42px;height:42px;border:1px solid #d5dde8;border-radius:10px;background:#fff;color:#020b1c;font-size:24px;font-weight:900}.member-profile{position:relative;background:#fff;border:1px solid #d5dde8;border-radius:18px;text-align:center;overflow:hidden;margin-bottom:18px;box-shadow:0 8px 24px rgba(15,23,42,.06)}.member-cover{height:112px;background:#0d1728;background-image:radial-gradient(#24344e 1px,transparent 1px);background-size:18px 18px}.member-avatar{width:96px;height:96px;border-radius:999px;border:5px solid #fff;object-fit:cover;background:#e6f7ff;margin:-48px auto 8px;display:block}.member-name{font-size:24px;font-weight:900;line-height:1.2;padding:0 14px}.member-tier{display:inline-block;margin:10px 0 20px;border:1px solid #9fe9ca;background:#dcffef;color:#00925f;border-radius:7px;padding:6px 14px;font-size:13px;font-weight:900}.member-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px}.member-action{border:0;border-radius:14px;background:#fff;color:#020b1c;padding:18px 8px;box-shadow:0 10px 24px rgba(15,23,42,.07);font-weight:900}.member-action b{display:block;color:#14b99a;font-size:32px;line-height:1}.member-action span{display:block;margin-top:8px;font-size:13px}.checkin-button{width:78%;margin:6px auto 18px;display:block;border:1px solid #d5dde8;border-radius:999px;background:#fff;color:#14213d;padding:14px;font-weight:900;font-size:15px}.member-row{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:12px;background:#fff;border:1px solid #d5dde8;border-radius:12px;padding:14px 16px;margin:10px 0;font-weight:900}.member-row small{color:#13b99a;margin-right:6px}.member-row button,.toggle-badge{border:0;border-radius:999px;background:#06c755;color:#fff;font-weight:900;padding:7px 12px;display:inline-flex;align-items:center;justify-content:center;min-width:54px;line-height:1.15}.member-detail{background:#fff;border:1px solid #d5dde8;border-radius:16px;margin:12px 0 16px;padding:16px;box-shadow:0 10px 24px rgba(15,23,42,.05)}.member-detail-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.member-detail-title{font-size:17px;font-weight:900}.member-edit{border:0;border-radius:999px;background:#2563eb;color:#fff;font-weight:900;padding:8px 12px}.member-save{width:100%;border:0;border-radius:12px;background:#06c755;color:#fff;font-weight:900;padding:14px;margin-top:12px;font-size:15px}.member-grid{display:grid;gap:10px}.member-field label{display:block;color:#64748b;font-size:12px;font-weight:900;margin:0 0 5px}.member-field input,.member-field select{width:100%;border:1px solid #d8e0ec;background:#f8fafc;border-radius:10px;padding:12px;color:#020b1c;font-weight:800;font-size:15px}.member-info-row{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid #eef2f7;padding:10px 0;font-weight:900}.member-info-row span:first-child{color:#64748b}.points-summary{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}.points-card{background:#f8fafc;border:1px solid #edf2f7;border-radius:14px;padding:14px}.points-card small{display:block;color:#64748b;font-weight:900;margin-bottom:6px}.points-card b{font-size:24px}.point-log{display:grid;grid-template-columns:1fr auto;gap:10px;background:#f8fafc;border:1px solid #edf2f7;border-radius:12px;padding:12px;margin:8px 0}.point-log-title{font-weight:900}.point-log-date{color:#94a3b8;font-size:12px;margin-top:4px}.point-log-amount{font-weight:900;font-size:18px;color:#06a657}.point-log-amount.spend{color:#dc2626}.member-empty{color:#64748b;background:#f8fafc;border-radius:12px;padding:16px;text-align:center;font-weight:800}
  </style>
</head>
<body>
  <div class="app">
    <header class="top">
      <button class="icon" onclick="toggleDrawer(true)">☰</button>
      <div class="brand">HookTea 購物商城<small>LINE 好友限定商城</small></div>
      <button class="profile-button" id="profileButton" onclick="openMember()" aria-label="LINE 會員">
        <span id="profileFallback">👤</span>
        <img id="profileAvatar" alt="LINE 頭貼">
      </button>
    </header>
    <section class="tabs">
      <div class="category-head">
        <button class="category-trigger" id="productTitle" onclick="toggleCategoryMenu()">全品項</button>
        <div class="category-menu" id="tabs"></div>
      </div>
    </section>
    <section class="hero">
      <div class="hero-content">
        <span class="hero-kicker" id="heroBadge">新會員限定</span>
        <h1 id="heroTitle">HookTea 精選<br>LINE 限定商城</h1>
        <p id="heroSubtitle">HookTea LINE 限定商城，訂單送出後會進入 HookTea 後台訂單維護。</p>
      </div>
    </section>
    <section class="section">
      <h2 id="listTitle">全品項</h2>
      <div class="section-tabs" id="sectionTabs"></div>
      <div class="products" id="products"></div>
    </section>
  </div>
  <nav class="nav">
    <button onclick="window.scrollTo({top:0,behavior:'smooth'})">⌂<small>首頁</small></button>
    <button onclick="openOrders()">▣<small>訂單</small></button>
    <button onclick="toggleCart(true)">🛒<span class="count" id="cartCount">0</span><small>購物車</small></button>
    <button onclick="openMember()"><span id="memberNavIcon">👤</span><small id="memberNavText">我的</small></button>
  </nav>
  <div class="drawer" id="drawer" onclick="toggleDrawer(false)">
    <div class="panel" onclick="event.stopPropagation()">
      <div class="menu-logo">HookTea 購物商城</div>
      <div class="menu-item" onclick="setCategory('虎克茶商品全品項');toggleDrawer(false)">全品項</div>
      <div class="menu-item" onclick="setCategory('虎克茶系列');toggleDrawer(false)">虎克茶系列</div>
      <div class="menu-item" onclick="setCategory('女王饗樂系列');toggleDrawer(false)">女王饗樂系列</div>
      <div class="menu-item" onclick="setCategory('禮盒開運茶系列');toggleDrawer(false)">禮盒開運茶系列</div>
      <div class="menu-item" onclick="setCategory('傳統茶系列');toggleDrawer(false)">傳統茶系列</div>
    </div>
  </div>
  <div class="cart" id="cart" onclick="toggleCart(false)">
    <div class="panel right" onclick="event.stopPropagation()">
      <div class="cart-head"><h2>購物車</h2><button class="cart-close" onclick="toggleCart(false)">×</button></div>
      <div id="cartItems"></div>
      <div class="checkout-block" id="orderSummary"></div>
      <div class="form-title">點數折抵</div>
      <div class="point-row">
        <input class="field" id="pointsUsed" type="number" min="0" step="1" inputmode="numeric" placeholder="輸入要折抵的點數" oninput="setPointDeduction(this.value)">
        <button class="mini-button" type="button" onclick="useMaxPoints()">全抵</button>
      </div>
      <div class="point-note" id="pointNote">登入後可使用會員點數折抵。</div>
      <div class="form-title">收件人資料</div>
      <div class="required-hint">請填寫實際可收貨的姓名、手機與地址。</div>
      <label class="same-member"><input type="checkbox" id="sameAsRegistered" onchange="toggleSameAsRegistered(this.checked)"><span>同註冊人資料</span></label>
      <div class="same-member-hint" id="sameMemberHint"></div>
      <input class="field" id="name" autocomplete="name" placeholder="收件姓名 *">
      <input class="field" id="phone" type="tel" autocomplete="tel" placeholder="收件手機 *">
      <input class="field" id="email" type="email" autocomplete="email" placeholder="Email（選填，用於付款通知）">
      <div class="form-row">
        <input class="field" id="postalCode" inputmode="numeric" autocomplete="postal-code" placeholder="郵遞區號">
        <input class="field" id="city" autocomplete="address-level1" placeholder="縣市 *">
      </div>
      <input class="field" id="district" autocomplete="address-level2" placeholder="區域 / 鄉鎮市 *">
      <input class="field" id="address" autocomplete="street-address" placeholder="路名、巷弄、門牌、樓層 *">
      <div class="form-title">物流方式</div>
      <select class="field" id="shippingCarrier">
        <option value="FAMILY">全家</option>
        <option value="SEVEN">7-11</option>
        <option value="POST">中華郵政</option>
      </select>
      <input class="field" id="shippingStoreInfo" placeholder="超商店號或店名（選填，例如：全家竹北自強店）">
      <textarea class="field" id="note" placeholder="配送備註（例如：管理室代收、可收貨時段）"></textarea>
      <div class="pay-title">付款方式</div>
      <div class="pay-options" id="payOptions"></div>
      <button class="checkout" id="checkoutButton" onclick="checkout()">送出訂單</button>
    </div>
  </div>
  <div class="detail" id="detail" onclick="closeProduct()">
    <div class="panel right" onclick="event.stopPropagation()">
      <button class="detail-close" onclick="closeProduct()">返回商品</button>
      <div id="detailContent" class="detail-card"></div>
    </div>
  </div>
  <div class="member" id="member" onclick="toggleMember(false)">
    <div class="member-sheet" onclick="event.stopPropagation()">
      <div class="member-top">
        <h2 id="memberPanelTitle">會員專區</h2>
        <button class="member-close" onclick="toggleMember(false)">×</button>
      </div>
      <div class="member-profile">
        <div class="member-cover"></div>
        <img class="member-avatar" id="memberAvatar" alt="LINE 頭貼">
        <div class="member-name" id="memberName">LINE 會員</div>
        <span class="member-tier" id="memberTier">一般會員</span>
      </div>
      <div class="member-actions" id="memberActions"></div>
      <button class="checkin-button" id="checkinButton" onclick="dailyCheckin()">每日簽到領點</button>
      <div id="memberRows"></div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    let products = [];
    const hookTeaCategories = ["虎克茶商品全品項","虎克茶系列","女王饗樂系列","禮盒開運茶系列","傳統茶系列"];
    let shopConfig = { categories: hookTeaCategories };
    let activeCategory = "虎克茶商品全品項";
    let cart = JSON.parse(localStorage.getItem("huaxu_cart") || "[]");
    let paymentMethod = localStorage.getItem("huaxu_payment") || "LINEPAY";
    if (!["LINEPAY","REMITTANCE","COD"].includes(paymentMethod)) paymentMethod = "LINEPAY";
    let pointDeduction = Math.max(0, Math.floor(Number(localStorage.getItem("huaxu_points_used") || 0)));
    let lineProfile = {};
    let memberData = null;
    let memberLoading = false;
    let activeMemberSection = "";
    let memberEditMode = false;
    let expandedOrderId = "";
    let cancellingOrderId = "";
    let reportingOrderId = "";
    let isCheckingOut = false;
    let entryContext = { url: location.href.split("#")[0], params: {} };
    const SHOP_LIFF_ID = ${JSON.stringify(String(shopLiffId || "2007674851-ijenzSk8"))};
    init();
    async function init(){
      entryContext = restoreEntryContext();
      const loaded = await Promise.all([
        fetch("/api/huaxu/config").then(r => r.json()).catch(() => null),
        fetch("/api/huaxu/products").then(r => r.json())
      ]);
      if (loaded[0]) shopConfig = loaded[0];
      products = loaded[1] || [];
      applyShopConfig();
      renderTabs(); renderProducts(); renderCart(); renderPayOptions(); renderMemberPanel(); renderLineProfile();
      initLineIdentity();
    }
    async function logShopLiff(step, detail, extra){
      try {
        let isInClient = false;
        let isLoggedIn = false;
        try { isInClient = !!(window.liff && liff.isInClient && liff.isInClient()); } catch (error) {}
        try { isLoggedIn = !!(window.liff && liff.isLoggedIn && liff.isLoggedIn()); } catch (error) {}
        await fetch("/api/huaxu/liff-debug", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(Object.assign({
            step,
            detail: detail || "",
            liffId: SHOP_LIFF_ID,
            href: location.href,
            isInClient,
            isLoggedIn,
            userId: lineProfile.userId || ""
          }, extra || {}))
        });
      } catch (error) {}
    }
    async function initLineIdentity(forceLogin){
      if (!window.liff) {
        await logShopLiff("no_sdk", "LIFF SDK not available");
        return;
      }
      try {
        entryContext = restoreEntryContext();
        const params = new URLSearchParams(location.search);
        const liffId = params.get("liffId") || shopConfig.shopLiffId || SHOP_LIFF_ID || "2007674851-ijenzSk8";
        if (!liffId) return;
        await liff.init({ liffId, withLoginOnExternalBrowser: true });
        await logShopLiff("init_done", "", { liffId });
        if (!liff.isLoggedIn()) {
          await logShopLiff(forceLogin ? "login_manual" : "login_redirect", "", { liffId });
          liff.login({ redirectUri: entryContext.url || location.href.split("#")[0] });
          return;
        }
        lineProfile = await liff.getProfile();
        await logShopLiff("profile_done", "", { liffId, userId: lineProfile.userId || "" });
        renderLineProfile();
        await loadMemberData(liff.getAccessToken ? liff.getAccessToken() : "");
        renderLineProfile();
        if (new URLSearchParams(location.search).get("open") === "member") openMember();
      } catch (error) {
        console.warn("LIFF init failed", error);
        await logShopLiff("error", error && error.message ? error.message : String(error || "unknown"));
      }
    }
    function applyShopConfig(){
      const heroTitle = document.getElementById("heroTitle");
      const heroBadge = document.getElementById("heroBadge");
      const heroSubtitle = document.getElementById("heroSubtitle");
      if (heroTitle) heroTitle.innerHTML = escapeHtml(shopConfig.heroTitle || "HookTea 精選 LINE 限定商城").replace(/\\n/g, "<br>");
      if (heroBadge) heroBadge.textContent = shopConfig.heroBadge || "新會員限定";
      if (heroSubtitle) heroSubtitle.textContent = shopConfig.heroSubtitle || "";
    }
    function categories(){
      const configured = Array.isArray(shopConfig.categories) && shopConfig.categories.length ? shopConfig.categories : hookTeaCategories;
      const legacyCategories = ["熱門商品","線上購物商品","虎克茶","新會員優惠","本月活動"];
      return configured.some(cat => legacyCategories.includes(cat)) ? hookTeaCategories : configured;
    }
    function categoryLabel(category){
      return category === "虎克茶商品全品項" ? "全品項" : category;
    }
    function renderTabs(){
      const categoryItems = categories();
      document.getElementById("tabs").innerHTML = categoryItems.map(cat =>
        '<button class="'+(cat===activeCategory?'active':'')+'" onclick="setCategory(\\''+escapeAttr(cat)+'\\')">'+escapeHtml(categoryLabel(cat))+'</button>'
      ).join("");
      const sectionTabs = document.getElementById("sectionTabs");
      if (sectionTabs) {
        sectionTabs.innerHTML = categoryItems.map(cat =>
          '<button class="section-tab '+(cat===activeCategory?'active':'')+'" onclick="setCategory(\\''+escapeAttr(cat)+'\\')">'+escapeHtml(categoryLabel(cat))+'</button>'
        ).join("");
      }
    }
    function setCategory(category){
      activeCategory = category;
      document.getElementById("productTitle").textContent = categoryLabel(category);
      document.getElementById("listTitle").textContent = categoryLabel(category);
      document.getElementById("tabs").classList.remove("open");
      renderTabs(); renderProducts();
    }
    function toggleCategoryMenu(){ document.getElementById("tabs").classList.toggle("open"); }
    function productInCategory(product, category){
      const text = [product.category, product.name, product.subtitle, product.badge, product.code].map(v => String(v || "")).join(" ");
      if (!category || category === "虎克茶商品全品項") return true;
      if (category === "虎克茶系列") return String(product.category || "") === "虎克茶" || /虎克茶|翔琪|漂浮|苦瓜胜肽/.test(text);
      if (category === "女王饗樂系列") return /女王|蜂蜜|小藝術|饗樂/.test(text);
      if (category === "禮盒開運茶系列") return /禮盒|禮袋|好運|竹縣|一手掌握|組盒|組/.test(text);
      if (category === "傳統茶系列") return /經典檸檬茶|暖心檸檬薑茶|翔琪檸檬茶|漂浮檸檬茶/.test(text);
      return String(product.category || "") === category;
    }
    function renderProducts(){
      const shown = products.filter(p => productInCategory(p, activeCategory));
      document.getElementById("products").innerHTML = shown.map(p => {
        const image = '<img src="'+escapeAttr(p.image)+'" alt="'+escapeAttr(p.name || "")+'">';
        const title = '<h3>'+escapeHtml(p.name)+'</h3>';
        return '<article class="card">'
          +'<button class="product-link" onclick="openProduct(\\''+escapeAttr(p.id)+'\\')">'+image+'</button>'
          +'<div class="card-body"><span class="badge">'+escapeHtml(p.badge || "HookTea")+'</span>'
          +'<button class="product-title" onclick="openProduct(\\''+escapeAttr(p.id)+'\\')">'+title+'</button>'
          +'<p>'+escapeHtml(p.subtitle || "")+'</p><div><span class="price">$'+money(p.price)+'</span>'
          +(p.originalPrice && p.originalPrice > p.price ? '<span class="original">$'+money(p.originalPrice)+'</span>' : '')
          +'</div><button class="buy" onclick="addToCart(\\''+escapeAttr(p.id)+'\\')">加入購物車</button>'
          +'<button class="source-link" onclick="openProduct(\\''+escapeAttr(p.id)+'\\')">查看商品內容</button>'
          +'</div></article>';
      }).join("") || '<div class="empty">目前沒有商品</div>';
    }
    function openProduct(id){
      const p = products.find(product => product.id === id);
      if (!p) return;
      const sourceUrl = String(p.sourceUrl || "");
      document.getElementById("detailContent").innerHTML =
        '<img src="'+escapeAttr(p.image)+'" alt="'+escapeAttr(p.name || "")+'">'
        +'<span class="badge">'+escapeHtml(p.badge || "HookTea")+'</span>'
        +'<h2>'+escapeHtml(p.name || "")+'</h2>'
        +'<div><span class="price">$'+money(p.price)+'</span>'+(p.originalPrice && p.originalPrice > p.price ? '<span class="original">$'+money(p.originalPrice)+'</span>' : '')+'</div>'
        +'<div class="detail-desc">'+escapeHtml(p.description || p.subtitle || "")+'</div>'
        +'<button class="buy" onclick="addToCart(\\''+escapeAttr(p.id)+'\\')">加入購物車</button>'
        +(sourceUrl ? '<a class="source-link" href="'+escapeAttr(sourceUrl)+'">官網原頁</a>' : '');
      document.getElementById("detail").classList.add("open");
    }
    function closeProduct(){ document.getElementById("detail").classList.remove("open"); }
    function addToCart(id){
      const found = cart.find(item => item.id === id);
      if (found) found.quantity += 1; else cart.push({ id, quantity: 1 });
      saveCart(); toast("已加入購物車");
    }
    function saveCart(){ localStorage.setItem("huaxu_cart", JSON.stringify(cart)); clampPointDeduction(); renderCart(); }
    function setPaymentMethod(method){
      paymentMethod = method;
      localStorage.setItem("huaxu_payment", method);
      renderPayOptions();
    }
    function renderPayOptions(){
      const labels = { LINEPAY:"LINE Pay", REMITTANCE:"匯款", COD:"貨到付款" };
      const el = document.getElementById("payOptions");
      if (!el) return;
      const payable = cartTotals().payable;
      el.innerHTML = Object.keys(labels).map(method =>
        '<button type="button" '+(payable <= 0 ? "disabled" : "")+' class="pay-option '+(paymentMethod===method?'active':'')+'" onclick="setPaymentMethod(\\''+method+'\\')">'+labels[method]+'</button>'
      ).join("");
    }
    function cartTotals(){
      let subtotal = 0;
      let maxPoints = 0;
      cart.forEach(item => {
        const p = products.find(product => product.id === item.id);
        if (!p) return;
        const quantity = Math.max(1, Number(item.quantity || 1));
        const lineTotal = Math.max(0, Number(p.price || 0)) * quantity;
        const pointLimit = Math.max(0, Number(p.pointsPrice ?? p.pointPrice ?? p.price ?? 0)) * quantity;
        subtotal += lineTotal;
        maxPoints += Math.min(lineTotal, pointLimit);
      });
      const memberBalance = memberPointBalance();
      const allowedPoints = Math.max(0, Math.min(subtotal, maxPoints, memberBalance));
      const used = Math.max(0, Math.min(pointDeduction, allowedPoints));
      return { subtotal, maxPoints, memberBalance, allowedPoints, used, payable: Math.max(0, subtotal - used) };
    }
    function memberPointBalance(){
      if (!memberData || !memberData.points) return 0;
      return Math.max(0, Math.floor(Number(memberData.points.balance || 0)));
    }
    function clampPointDeduction(){
      const totals = cartTotals();
      pointDeduction = Math.max(0, Math.min(Math.floor(Number(pointDeduction || 0)), totals.allowedPoints));
      localStorage.setItem("huaxu_points_used", String(pointDeduction));
      const input = document.getElementById("pointsUsed");
      if (input && String(input.value || "") !== String(pointDeduction || "")) input.value = pointDeduction || "";
      return totals;
    }
    function setPointDeduction(value){
      pointDeduction = Math.max(0, Math.floor(Number(value || 0)));
      clampPointDeduction();
      renderCart();
      renderPayOptions();
    }
    function useMaxPoints(){
      if (!lineProfile.userId) return loginLine();
      const totals = cartTotals();
      pointDeduction = totals.allowedPoints;
      clampPointDeduction();
      renderCart();
      renderPayOptions();
    }
    function renderOrderSummary(){
      const el = document.getElementById("orderSummary");
      if (!el) return;
      const totals = clampPointDeduction();
      el.innerHTML =
        '<div class="summary-row"><span>商品小計</span><b>$'+money(totals.subtotal)+'</b></div>'
        +'<div class="summary-row"><span>點數折抵</span><b>- $'+money(totals.used)+'</b></div>'
        +'<div class="summary-row total"><span>實付金額</span><b>$'+money(totals.payable)+'</b></div>';
      const note = document.getElementById("pointNote");
      if (note) {
        const canUse = !!lineProfile.userId && !!memberData;
        note.className = "point-note" + (!canUse || (!totals.allowedPoints && totals.subtotal > 0) ? " warn" : "");
        note.textContent = !lineProfile.userId
          ? "請先登入 LINE 才能使用點數折抵。"
          : memberLoading
            ? "會員點數讀取中..."
            : !memberData
              ? "尚未連動會員資料，無法使用點數折抵。"
              : "目前可用 " + money(totals.memberBalance) + " 點，本次最高可折抵 " + money(totals.allowedPoints) + " 點。";
      }
      renderPayOptions();
    }
    function renderCart(){
      document.getElementById("cartCount").textContent = cart.reduce((sum,item)=>sum+item.quantity,0);
      const rows = cart.map(item => {
        const p = products.find(product => product.id === item.id);
        return p ? '<div class="cart-item"><div><b>'+escapeHtml(p.name)+'</b><br><small>$'+money(p.price)+' x '+item.quantity+'</small></div><button onclick="removeCart(\\''+escapeAttr(item.id)+'\\')">移除</button></div>' : "";
      }).join("");
      document.getElementById("cartItems").innerHTML = rows || '<div class="empty">購物車目前是空的</div>';
      renderOrderSummary();
    }
    function removeCart(id){ cart = cart.filter(item => item.id !== id); saveCart(); }
    function buildClientOrderKey(customer){
      const cartKey = cart.map(item => String(item.id || "") + ":" + Number(item.quantity || 1)).sort().join("|");
      return [lineProfile.userId || "guest", paymentMethod, pointDeduction, customer.shippingCarrier, customer.shippingStoreInfo, customer.name, customer.phone, customer.city, customer.district, customer.address, cartKey].join("|");
    }
    function setCheckoutBusy(busy){
      isCheckingOut = !!busy;
      const button = document.getElementById("checkoutButton");
      if (!button) return;
      button.disabled = isCheckingOut;
      button.textContent = isCheckingOut ? "處理中..." : "送出訂單";
      button.style.opacity = isCheckingOut ? ".65" : "1";
      button.style.cursor = isCheckingOut ? "not-allowed" : "pointer";
    }
    function parseRegisteredAddress(value){
      let text = String(value || "").trim().replace(/\\s+/g, "");
      const result = { postalCode:"", city:"", district:"", address:text };
      const postal = text.match(/^([0-9]{3,6})/);
      if (postal) { result.postalCode = postal[1]; text = text.slice(postal[1].length); }
      const cities = ["臺北市","台北市","新北市","桃園市","臺中市","台中市","臺南市","台南市","高雄市","基隆市","新竹市","嘉義市","新竹縣","苗栗縣","彰化縣","南投縣","雲林縣","嘉義縣","屏東縣","宜蘭縣","花蓮縣","臺東縣","台東縣","澎湖縣","金門縣","連江縣"];
      const city = cities.find(name => text.indexOf(name) === 0);
      if (city) { result.city = city; text = text.slice(city.length); }
      const district = text.match(/^(.{1,8}?(?:區|鄉|鎮|市))/);
      if (district) { result.district = district[1]; text = text.slice(district[1].length); }
      result.address = text || result.address;
      return result;
    }
    function setField(id, value){
      const el = document.getElementById(id);
      if (el) el.value = value || "";
    }
    function registeredShipping(){
      const member = memberData && memberData.member ? memberData.member : {};
      const parsed = parseRegisteredAddress(member.shippingAddress || member.address || "");
      return {
        name: member.name || member.displayName || lineProfile.displayName || "",
        phone: member.phone || member.mobile || member.tel || "",
        email: member.email || "",
        postalCode: member.postalCode || parsed.postalCode || "",
        city: member.city || parsed.city || "",
        district: member.district || parsed.district || "",
        address: member.shippingAddress || parsed.address || member.address || ""
      };
    }
    function missingShippingFields(customer){
      const fields = [["name","姓名"],["phone","手機"],["city","縣市"],["district","區域 / 鄉鎮市"],["address","路名、巷弄、門牌、樓層"]];
      return fields.filter(item => !String(customer[item[0]] || "").trim()).map(item => item[1]);
    }
    function normalizeCheckoutPhone(value){
      const digits = String(value || "").replace(/\\.0$/, "").replace(/\\D+/g, "");
      return digits && !digits.startsWith("0") && digits.length === 9 ? "0" + digits : digits;
    }
    function validateShippingCustomer(customer){
      const data = customer || {};
      const errors = [];
      const phone = normalizeCheckoutPhone(data.phone);
      const postalCode = String(data.postalCode || "").trim();
      const city = String(data.city || "").trim();
      const district = String(data.district || "").trim();
      const address = String(data.address || "").trim();
      const compactAddress = address.replace(/\\s+/g, "");
      const cities = ["\u81fa\u5317\u5e02","\u53f0\u5317\u5e02","\u65b0\u5317\u5e02","\u6843\u5712\u5e02","\u81fa\u4e2d\u5e02","\u53f0\u4e2d\u5e02","\u81fa\u5357\u5e02","\u53f0\u5357\u5e02","\u9ad8\u96c4\u5e02","\u57fa\u9686\u5e02","\u65b0\u7af9\u5e02","\u5609\u7fa9\u5e02","\u65b0\u7af9\u7e23","\u82d7\u6817\u7e23","\u5f70\u5316\u7e23","\u5357\u6295\u7e23","\u96f2\u6797\u7e23","\u5609\u7fa9\u7e23","\u5c4f\u6771\u7e23","\u5b9c\u862d\u7e23","\u82b1\u84ee\u7e23","\u81fa\u6771\u7e23","\u53f0\u6771\u7e23","\u6f8e\u6e56\u7e23","\u91d1\u9580\u7e23","\u9023\u6c5f\u7e23"];
      const parsed = parseRegisteredAddress([postalCode, city, district, address].filter(Boolean).join(""));
      const resolvedCity = city || parsed.city;
      const resolvedDistrict = district || parsed.district;
      if (!/^09\\d{8}$/.test(phone)) errors.push("\u6536\u4ef6\u624b\u6a5f\u9700\u70ba 09 \u958b\u982d 10 \u78bc\u624b\u6a5f\u865f\u78bc");
      if (postalCode && !/^\\d{3,6}$/.test(postalCode)) errors.push("\u90f5\u905e\u5340\u865f\u9700\u70ba 3-6 \u78bc\u6578\u5b57");
      if (!resolvedCity || !cities.includes(resolvedCity)) errors.push("\u8acb\u586b\u5beb\u6b63\u78ba\u7e23\u5e02");
      if (!resolvedDistrict || !/^.{1,8}(?:\u5340|\u9109|\u93ae|\u5e02)$/.test(resolvedDistrict)) errors.push("\u8acb\u586b\u5beb\u6b63\u78ba\u5340\u57df / \u9109\u93ae\u5e02");
      if (compactAddress.length < 4) errors.push("\u8acb\u586b\u5beb\u5b8c\u6574\u8def\u540d\u3001\u5df7\u5f04\u3001\u9580\u724c\u6216\u4fe1\u7bb1");
      if (!/(?:\u8def|\u8857|\u5927\u9053|\u6bb5|\u5df7|\u5f04|\u6751|\u91cc|\u865f|\u53f7|\u6a13|\u5ba4|\u4fe1\u7bb1)/.test(compactAddress)) errors.push("\u5730\u5740\u9700\u5305\u542b\u8def\u8857\u3001\u5df7\u5f04\u3001\u9580\u724c\u6216\u4fe1\u7bb1\u7b49\u8a73\u7d30\u8cc7\u8a0a");
      if (!/(?:\\d+.*(?:\u865f|\u53f7)|\\d+.*\u4fe1\u7bb1|\\d+\\s*-\\s*\\d+)/.test(compactAddress)) errors.push("\u5730\u5740\u9700\u5305\u542b\u9580\u724c\u865f\u78bc\u6216\u4fe1\u7bb1\u865f\u78bc");
      return { ok: errors.length === 0, errors: [...new Set(errors)], phone, city: resolvedCity, district: resolvedDistrict, address };
    }

    function setSameMemberHint(message, type){
      const hint = document.getElementById("sameMemberHint");
      if (!hint) return;
      hint.className = "same-member-hint" + (type ? " " + type : "");
      hint.textContent = message || "";
    }
    function fillRegisteredShipping(){
      const data = registeredShipping();
      setField("name", data.name);
      setField("phone", data.phone);
      setField("email", data.email);
      setField("postalCode", data.postalCode);
      setField("city", data.city);
      setField("district", data.district);
      setField("address", data.address);
      const missing = missingShippingFields(data);
      if (missing.length) {
        setSameMemberHint("註冊資料不完整，缺少：" + missing.join("、") + "。請先補齊會員資料或改用手填。", "warn");
        return false;
      }
      setSameMemberHint("已帶入註冊人資料，送出前系統仍會再次檢查。", "ok");
      return true;
    }
    function toggleSameAsRegistered(checked){
      if (!checked) return setSameMemberHint("", "");
      if (!lineProfile.userId) {
        const box = document.getElementById("sameAsRegistered");
        if (box) box.checked = false;
        toast("請先完成 LINE 登入");
        return loginLine();
      }
      if (!memberData) {
        const box = document.getElementById("sameAsRegistered");
        if (box) box.checked = false;
        return toast(memberLoading ? "會員資料讀取中" : "尚未取得註冊資料");
      }
      fillRegisteredShipping();
    }
    async function checkout(){
      if (isCheckingOut) return toast("訂單處理中，請稍候");
      if (!cart.length) return toast("購物車是空的");
      const totals = clampPointDeduction();
      if (totals.used > 0 && !lineProfile.userId) return loginLine();
      const sameAsRegistered = !!document.getElementById("sameAsRegistered")?.checked;
      if (sameAsRegistered && !fillRegisteredShipping()) return;
      const customer = { name: val("name"), phone: val("phone"), email: val("email"), postalCode: val("postalCode"), city: val("city"), district: val("district"), address: val("address"), shippingCarrier: val("shippingCarrier"), shippingStoreInfo: val("shippingStoreInfo"), note: val("note"), sameAsRegistered };
      const missingCustomer = missingShippingFields(customer);
      if (missingCustomer.length) return toast("請補齊：" + missingCustomer.join("、"));
      const shippingValidation = validateShippingCustomer(customer);
      if (!shippingValidation.ok) return toast("\u6536\u4ef6\u8cc7\u6599\u683c\u5f0f\u4e0d\u5b8c\u6574\uff1a" + shippingValidation.errors.join("\u3001"));
      customer.phone = shippingValidation.phone;
      customer.city = shippingValidation.city || customer.city;
      customer.district = shippingValidation.district || customer.district;
      customer.address = shippingValidation.address || customer.address;
      setField("phone", customer.phone);
      setField("city", customer.city);
      setField("district", customer.district);
      setField("address", customer.address);
      entryContext = restoreEntryContext();
      setCheckoutBusy(true);
      let keepBusy = false;
      try {
        const clientOrderKey = buildClientOrderKey(customer);
        const currentCart = cart.map(item => ({ id: item.id, quantity: item.quantity }));
        const res = await fetch("/api/huaxu/orders", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ items: currentCart, customer, lineProfile, paymentMethod, pointsUsed: totals.used, shippingCarrier: customer.shippingCarrier, sameAsRegistered, clientOrderKey, workerUrl: location.origin, returnUrl: entryContext.url || location.href.split("#")[0], entryUrl: entryContext.url, entryParams: entryContext.params }) }).then(r => r.json());
        if (!res.ok) {
          toast(res.message || "訂單送出失敗");
          return;
        }
        if (res.payment && res.payment.provider === "LINEPAY" && res.payment.redirectUrl) {
          keepBusy = true;
          location.href = res.payment.redirectUrl;
          return;
        }
        if (res.payment && res.payment.GatewayUrl) {
          keepBusy = true;
          submitPaymentForm(res.payment);
          return;
        }
        cart = []; pointDeduction = 0; localStorage.setItem("huaxu_points_used", "0"); saveCart(); toggleCart(false); toast("訂單已送出：" + res.order.orderId);
        if (res.order && Number(res.order.amount || 0) <= 0 && Number(res.order.pointsUsed || 0) > 0) {
          alert("訂單已成立：" + res.order.orderId + "\\n已使用點數折抵：" + money(res.order.pointsUsed) + " 點\\n本筆不需付款。");
          await refreshMemberData();
        }
        if (paymentMethod === "REMITTANCE" && res.order && Number(res.order.amount || 0) > 0) {
          alert("\u8a02\u55ae\u5df2\u6210\u7acb\uff1a" + res.order.orderId + "\\n\\n\u532f\u6b3e\u8cc7\u8a0a\uff1a\\n" + (res.remittanceInfo || "\u5c1a\u672a\u8a2d\u5b9a\u532f\u6b3e\u5e33\u865f\uff0c\u8acb\u7b49\u5019\u5ba2\u670d\u63d0\u4f9b\u532f\u6b3e\u8cc7\u8a0a\u3002") + "\\n\\n\u532f\u6b3e\u5f8c\u8acb\u5728\u8a02\u55ae\u67e5\u8a62\u4e2d\u586b\u5beb\u532f\u6b3e\u5e33\u865f\u672b\u4e94\u78bc\u3002");
          memberTab = "orders";
          expandedOrderId = res.order.orderId;
          await refreshMemberData();
          openMember();
        }
        if (paymentMethod === "COD" && res.order && Number(res.order.amount || 0) > 0) {
          alert("\u8a02\u55ae\u5df2\u6210\u7acb\uff1a" + res.order.orderId + "\n\n\u4ed8\u6b3e\u65b9\u5f0f\uff1a\u8ca8\u5230\u4ed8\u6b3e\n\u8acb\u7559\u610f\u914d\u9001\u901a\u77e5\u8207\u53d6\u8ca8\u4ed8\u6b3e\u3002");
          memberTab = "orders";
          expandedOrderId = res.order.orderId;
          await refreshMemberData();
          openMember();
        }
      } catch (error) {
        toast("訂單送出失敗，請稍後再試");
      } finally {
        if (!keepBusy) setCheckoutBusy(false);
      }
    }
    function submitPaymentForm(payRes){
      const form = document.createElement("form");
      form.method = "POST";
      form.action = payRes.GatewayUrl;
      form.target = "_top";
      form.style.display = "none";
      const params = { MerchantID: payRes.MerchantID, TradeInfo: payRes.TradeInfo, TradeSha: payRes.TradeSha, Version: payRes.Version };
      Object.keys(params).forEach(key => {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = key;
        input.value = params[key] || "";
        form.appendChild(input);
      });
      document.body.appendChild(form);
      form.submit();
    }
    function toggleDrawer(open){ document.getElementById("drawer").classList.toggle("open", open); }
    function toggleCart(open){ document.getElementById("cart").classList.toggle("open", open); renderCart(); }
    function restoreEntryContext(){
      let current = new URL(location.href);
      const state = current.searchParams.get("liff.state");
      if (state) {
        try {
          const restoredUrl = new URL(decodeURIComponent(state), location.origin);
          const restoredPath = restoredUrl.pathname + restoredUrl.search + location.hash;
          if (restoredUrl.pathname && restoredPath !== location.pathname + location.search + location.hash) {
            history.replaceState(null, "", restoredPath);
            current = new URL(location.href);
          }
        } catch (error) { console.warn("LIFF state restore failed", error); }
      }
      const ignored = new Set(["code", "state", "liff.state", "friendship_status_changed"]);
      const hasEntryParams = Array.from(current.searchParams.keys()).some(key => !ignored.has(key));
      try {
        if (hasEntryParams || !sessionStorage.getItem("huaxu_entry_url")) {
          sessionStorage.setItem("huaxu_entry_url", current.href.split("#")[0]);
        }
        const savedUrl = sessionStorage.getItem("huaxu_entry_url") || current.href.split("#")[0];
        const saved = new URL(savedUrl, location.origin);
        const params = {};
        saved.searchParams.forEach((value, key) => { if (!ignored.has(key)) params[key] = value; });
        return { url: saved.href.split("#")[0], params };
      } catch (error) {
        const params = {};
        current.searchParams.forEach((value, key) => { if (!ignored.has(key)) params[key] = value; });
        return { url: current.href.split("#")[0], params };
      }
    }
    function renderLineProfile(){
      const ready = !!lineProfile.userId;
      const button = document.getElementById("profileButton");
      const avatar = document.getElementById("profileAvatar");
      const fallback = document.getElementById("profileFallback");
      const navIcon = document.getElementById("memberNavIcon");
      const navText = document.getElementById("memberNavText");
      if (button) button.classList.toggle("ready", ready && !!lineProfile.pictureUrl);
      if (avatar && lineProfile.pictureUrl) avatar.src = lineProfile.pictureUrl;
      if (fallback) fallback.textContent = lineProfile.displayName ? lineProfile.displayName.trim().slice(0,1).toUpperCase() : "👤";
      if (navIcon) navIcon.textContent = "👤";
      if (navText) navText.textContent = "我的";
      renderMemberPanel();
    }
    async function loadMemberData(accessToken){
      if (!lineProfile.userId) return;
      memberLoading = true;
      renderMemberPanel();
      try {
        const res = await fetch("/api/huaxu/member", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken, lineUserId: lineProfile.userId, lineProfile })
        }).then(r => r.json());
        memberData = res && res.ok ? res : null;
      } catch (error) {
        console.warn("Member profile load failed", error);
        memberData = null;
      } finally {
        memberLoading = false;
        renderCart();
        renderMemberPanel();
      }
    }
    function openMember(){
      if (!lineProfile.userId) return loginLine();
      renderMemberPanel();
      toggleMember(true);
    }
    async function openOrders(){
      if (!lineProfile.userId) return loginLine();
      activeMemberSection = "訂單查詢";
      memberEditMode = false;
      if (!memberData && !memberLoading) await refreshMemberData();
      renderMemberPanel();
      toggleMember(true);
    }
    function toggleMember(open){
      const panel = document.getElementById("member");
      if (panel) panel.classList.toggle("open", !!open);
    }
    function renderMemberPanel(){
      const member = memberData?.member || {};
      const name = member.name || member.displayName || lineProfile.displayName || "LINE 會員";
      const avatar = member.pictureUrl || lineProfile.pictureUrl || "";
      const tier = member.memberTier || "一般會員";
      const balance = memberLoading ? "讀取中" : (memberData?.points ? Number(memberData.points.balance || 0).toLocaleString("zh-TW") + " 點" : "尚未連動");
      const shareCount = memberData?.referrals ? Number(memberData.referrals.count || 0) : 0;
      const modules = Array.isArray(shopConfig.memberModules) && shopConfig.memberModules.length
        ? shopConfig.memberModules
        : ["點數記錄","分享好友","推薦成果","個人基本資料"];
      const panelTitle = document.getElementById("memberPanelTitle");
      const memberName = document.getElementById("memberName");
      const memberAvatar = document.getElementById("memberAvatar");
      const memberTier = document.getElementById("memberTier");
      const actions = document.getElementById("memberActions");
      const checkin = document.getElementById("checkinButton");
      const rows = document.getElementById("memberRows");
      if (panelTitle) panelTitle.textContent = shopConfig.memberTitle || "會員專區";
      if (memberName) memberName.textContent = name;
      if (memberTier) memberTier.textContent = tier;
      if (memberAvatar) {
        memberAvatar.src = avatar || "https://placehold.co/160x160/e6f7ff/0f172a?text=LINE";
      }
      if (checkin) checkin.textContent = shopConfig.checkinLabel || "每日簽到領點";
      if (actions) {
        const actionDefs = [
          { key:"點數記錄", icon:"點" },
          { key:"分享好友", icon:"享" },
          { key:"推薦成果", icon:"邀" }
        ];
        actions.innerHTML = actionDefs.map(item =>
          '<button class="member-action" onclick="memberAction(\\''+escapeAttr(item.key)+'\\')"><b>'+escapeHtml(item.icon)+'</b><span>'+escapeHtml(item.key)+'</span></button>'
        ).join("");
      }
      if (rows) {
        const rowDefs = [
          { label: modules.includes("個人基本資料") ? "個人基本資料" : modules[0] || "個人基本資料", value: memberData?.bound ? "已註冊" : "尚未綁定" },
          { label: modules.includes("點數記錄") ? "點數記載" : modules[1] || "點數記載", value: balance },
          { label: "訂單查詢", value: Number(memberData?.orders?.count || 0) + " 筆" },
          { label: modules.includes("分享好友") ? "分享連結" : modules[2] || "分享連結", value: shareCount + " 人" }
        ];
        rows.innerHTML = rowDefs.map(row =>
          '<div class="member-row"><div><small>□</small>'+escapeHtml(row.label)+'</div><div>'+escapeHtml(row.value)+'</div><button onclick="memberAction(\\''+escapeAttr(row.label)+'\\')">'+(activeMemberSection===row.label ? "收合" : "展開")+'</button></div>'
        ).join("") + renderMemberDetail();
      }
    }
    function loginLine(){
      if (lineProfile.userId) return openMember();
      initLineIdentity(true);
      toast("正在確認 LINE 身分");
    }
    async function dailyCheckin(){
      if (!lineProfile.userId) return loginLine();
      const button = document.getElementById("checkinButton");
      if (button) {
        button.disabled = true;
        button.textContent = "打卡送出中...";
      }
      try {
        const accessToken = window.liff && liff.getAccessToken ? liff.getAccessToken() : "";
        const res = await fetch("/api/huaxu/checkin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken, lineUserId: lineProfile.userId, lineProfile, keyword: "會員打卡" })
        }).then(r => r.json());
        if (!res.ok) throw new Error(res.message || "打卡送出失敗");
        toast(res.alreadyCheckedIn ? "今日已完成打卡" : "打卡已送出");
        await refreshMemberData();
      } catch (error) {
        toast(error.message || "打卡送出失敗");
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = shopConfig.checkinLabel || "每日簽到領點";
        }
      }
    }
    function memberAction(label){
      if (!memberData) return toast(memberLoading ? "會員資料讀取中" : "尚未連動會員資料");
      const member = memberData.member || {};
      if (label.includes("點")) {
        activeMemberSection = activeMemberSection === label ? "" : label;
        memberEditMode = false;
        renderMemberPanel();
        return;
      }
      if (label.includes("個人")) {
        activeMemberSection = activeMemberSection === label ? "" : label;
        memberEditMode = false;
        renderMemberPanel();
        return;
      }
      if (label.includes("訂單")) {
        activeMemberSection = activeMemberSection === label ? "" : label;
        memberEditMode = false;
        renderMemberPanel();
        return;
      }
      if (label.includes("分享") || label.includes("推薦") || label.includes("邀")) {
        activeMemberSection = activeMemberSection === label ? "" : label;
        memberEditMode = false;
        renderMemberPanel();
        return;
      }
      toast(label + "已連動");
    }
    function renderMemberDetail(){
      if (!activeMemberSection || !memberData) return "";
      if (activeMemberSection.includes("個人")) return renderProfileDetail();
      if (activeMemberSection.includes("點")) return renderPointsDetail();
      if (activeMemberSection.includes("訂單")) return renderOrderDetail();
      if (activeMemberSection.includes("分享") || activeMemberSection.includes("推薦") || activeMemberSection.includes("邀")) return renderReferralDetail();
      return "";
    }
    function renderProfileDetail(){
      const member = memberData.member || {};
      const rows = [
        ["姓名", member.name || member.displayName || lineProfile.displayName || ""],
        ["手機", member.phone || ""],
        ["性別", member.gender || ""],
        ["生日", member.birthday || ""],
        ["Email", member.email || ""],
        ["地址", member.address || ""],
        ["業種", member.industry || ""]
      ];
      if (!memberEditMode) {
        return '<section class="member-detail"><div class="member-detail-head"><div class="member-detail-title">個人基本資料</div><button class="member-edit" onclick="editMemberProfile()">編輯</button></div>'
          + rows.map(row => '<div class="member-info-row"><span>'+escapeHtml(row[0])+'</span><b>'+escapeHtml(row[1] || "-")+'</b></div>').join("")
          + '</section>';
      }
      return '<section class="member-detail"><div class="member-detail-head"><div class="member-detail-title">編輯個人資料</div><button class="member-edit" onclick="cancelMemberEdit()">取消</button></div>'
        + '<div class="member-grid">'
        + profileField("姓名", "editName", member.name || member.displayName || lineProfile.displayName || "", "text")
        + profileField("手機", "editPhone", member.phone || "", "tel")
        + '<div class="member-field"><label>性別</label><select id="editGender"><option value="">請選擇</option><option value="男" '+selectedAttr(member.gender,"男")+'>男</option><option value="女" '+selectedAttr(member.gender,"女")+'>女</option></select></div>'
        + profileField("生日", "editBirthday", member.birthday || "", "date")
        + profileField("Email", "editEmail", member.email || "", "email")
        + profileField("地址", "editAddress", member.address || "", "text")
        + profileField("業種", "editIndustry", member.industry || "", "text")
        + '</div><button class="member-save" onclick="saveMemberProfile()">確認修改資料</button></section>';
    }
    function profileField(label, id, value, type){
      return '<div class="member-field"><label>'+escapeHtml(label)+'</label><input id="'+escapeAttr(id)+'" type="'+escapeAttr(type || "text")+'" value="'+escapeAttr(value || "")+'"></div>';
    }
    function selectedAttr(value, expected){ return String(value || "") === expected ? "selected" : ""; }
    function renderPointsDetail(){
      const points = memberData.points || {};
      const balance = Number(points.balance || 0);
      const logs = Array.isArray(points.logs) ? points.logs : [];
      const sourceText = points.source === "wetw" ? "母站共用點數" : "HookTea 本地點數";
      return '<section class="member-detail"><div class="member-detail-head"><div class="member-detail-title">點數記錄</div><button class="member-edit" onclick="refreshMemberData()">重新整理</button></div>'
        + '<div class="points-summary"><div class="points-card"><small>目前餘額</small><b>'+money(balance)+' 點</b></div><div class="points-card"><small>資料來源</small><b style="font-size:15px">'+escapeHtml(sourceText)+'</b></div></div>'
        + (logs.length ? logs.map(renderPointLog).join("") : '<div class="member-empty">目前沒有點數異動紀錄</div>')
        + '</section>';
    }
    function renderPointLog(log){
      const raw = Number(log.amount || log.points || 0);
      const isSpend = String(log.type || "").toUpperCase() === "SPEND" || raw < 0;
      const amount = Math.abs(raw);
      return '<div class="point-log"><div><div class="point-log-title">'+escapeHtml(cleanPointLogReason(log.reason || "點數異動"))+'</div><div class="point-log-date">'+escapeHtml(formatDate(log.createdAt || log.date || ""))+'</div></div><div class="point-log-amount '+(isSpend ? "spend" : "")+'">'+(isSpend ? "-" : "+")+money(amount)+'</div></div>';
    }
    function cleanPointLogReason(reason){
      const text = String(reason || "").trim();
      if (text.indexOf("????") === 0) {
        const balance = text.split("").filter(ch => ch >= "0" && ch <= "9").join("");
        return balance ? "校正手機母站顯示餘額 " + balance : "校正手機母站顯示餘額";
      }
      return text || "點數異動";
    }
    function renderOrderDetail(){
      const latest = Array.isArray(memberData.orders?.latest) ? memberData.orders.latest : [];
      return '<section class="member-detail"><div class="member-detail-head"><div class="member-detail-title">訂單查詢</div><button class="member-edit" onclick="refreshMemberData()">重新整理</button></div>'
        + (latest.length ? latest.map(renderOrderRow).join("") : '<div class="member-empty">目前沒有訂單紀錄</div>')
        + '</section>';
    }
    function renderOrderRow(order){
      const orderId = String(order.orderId || "");
      const status = orderStatusText(order.status);
      const payment = paymentText(order);
      const amount = Number(order.amount || 0);
      const original = Number(order.originalAmount || amount || 0);
      const points = Number(order.pointsUsed || 0);
      const expanded = expandedOrderId === orderId;
      const tracking = order.trackingUrl
        ? '<a href="'+escapeAttr(order.trackingUrl)+'" target="_blank" rel="noopener" style="color:#2563eb;font-weight:900;text-decoration:none">物流查詢</a>'
        : (order.trackingNumber ? escapeHtml(order.trackingNumber) : "尚未出貨");
      const canReport = canReportRemittance(order);
      const remittanceForm = canReport
        ? '<div class="member-info-row" style="display:block"><span style="display:block;margin-bottom:8px">&#x532F;&#x6B3E;&#x5E33;&#x865F;&#x672B;&#x4E94;&#x78BC;</span><div style="display:grid;grid-template-columns:1fr auto;gap:8px"><input id="remit_'+escapeAttr(orderId)+'" inputmode="numeric" maxlength="5" pattern="[0-9]*" style="min-width:0;border:1px solid #d8e0ec;background:#fff;border-radius:10px;padding:10px;font-weight:900;font-size:16px" placeholder="12345"><button class="member-edit" onclick="reportRemittance(\\''+escapeAttr(orderId)+'\\')">'+(reportingOrderId === orderId ? "&#x9001;&#x51FA;&#x4E2D;" : "&#x9001;&#x51FA;")+'</button></div></div>'
        : '';
      const cancellable = canCancelOrder(order);
      const cancelButton = cancellable
        ? '<button class="member-edit" style="background:#fee2e2;color:#dc2626" onclick="cancelOrder(\\''+escapeAttr(orderId)+'\\')">'+(cancellingOrderId === orderId ? "取消中..." : "取消訂單")+'</button>'
        : "";
      return '<div class="point-log" style="display:block">'
        + '<button style="width:100%;border:0;background:transparent;color:inherit;text-align:left;padding:0" onclick="toggleOrderDetail(\\''+escapeAttr(orderId)+'\\')">'
        + '<div class="point-log-title">'+escapeHtml(order.productName || "商城訂單")+'</div>'
        + '<div class="point-log-date">'+escapeHtml(orderId)+' · '+escapeHtml(formatDate(order.createdAt || ""))+'</div>'
        + '<div class="member-info-row"><span>'+escapeHtml(status)+' · $'+money(amount)+'</span><b class="toggle-badge">'+(expanded ? "收合" : "展開")+'</b></div>'
        + '</button>'
        + (expanded
          ? '<div class="member-info-row"><span>狀態</span><b>'+escapeHtml(status)+'</b></div>'
            + '<div class="member-info-row"><span>付款</span><b>'+escapeHtml(payment)+'</b></div>'
            + '<div class="member-info-row"><span>金額</span><b>$'+money(amount)+(points ? ' / 折 '+money(points)+' 點' : '')+(original && original !== amount ? ' / 原 $'+money(original) : '')+'</b></div>'
            + '<div class="member-info-row"><span>物流</span><b>'+escapeHtml(order.shippingCarrierName || "-")+'</b></div>'
            + (order.shippingStoreInfo || order.shipping?.storeInfo ? '<div class="member-info-row"><span>門市</span><b>'+escapeHtml(order.shippingStoreInfo || order.shipping.storeInfo || "-")+'</b></div>' : '')
            + '<div class="member-info-row"><span>追蹤</span><b>'+tracking+'</b></div>'
            + remittanceForm
            + (cancelButton ? '<div style="padding-top:12px">'+cancelButton+'</div>' : '')
          : '')
        + '</div>';
    }
    function toggleOrderDetail(orderId){
      expandedOrderId = expandedOrderId === orderId ? "" : orderId;
      renderMemberPanel();
    }
    function canCancelOrder(order){
      const status = String(order.status || "").toUpperCase();
      return !!order.orderId && !["PAID","PREPARING","SHIPPED","COMPLETED","CANCELLED"].includes(status) && !order.remittance;
    }
    function canReportRemittance(order){
      const status = String(order.status || "").toUpperCase();
      const method = String(order.paymentMethod || "").toUpperCase();
      return !!order.orderId && status === "PENDING" && method === "REMITTANCE" && !order.remittance;
    }
    async function reportRemittance(orderId){
      if (!orderId || reportingOrderId) return;
      const input = document.getElementById("remit_" + orderId);
      const remittance = String(input && input.value || "").replace(/\D/g, "").slice(0, 5);
      if (remittance.length !== 5) return toast("\u8acb\u8f38\u5165\u532f\u6b3e\u5e33\u865f\u672b\u4e94\u78bc");
      reportingOrderId = orderId;
      renderMemberPanel();
      try {
        const res = await fetch("/api/huaxu/orders/remittance", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId, remittance, lineProfile })
        }).then(r => r.json());
        if (!res.ok) throw new Error(res.message || "\u56de\u5831\u532f\u6b3e\u5931\u6557");
        toast("\u5df2\u9001\u51fa\u532f\u6b3e\u672b\u4e94\u78bc\uFF0C\u7b49\u5f85\u5f8c\u53f0\u6838\u5c0d");
        await refreshMemberData();
        expandedOrderId = orderId;
      } catch (error) {
        toast(error.message || "\u56de\u5831\u532f\u6b3e\u5931\u6557");
      } finally {
        reportingOrderId = "";
        renderMemberPanel();
      }
    }
    async function cancelOrder(orderId){
      if (!orderId || cancellingOrderId) return;
      if (!confirm("確定要取消這筆訂單？")) return;
      cancellingOrderId = orderId;
      renderMemberPanel();
      try {
        const res = await fetch("/api/huaxu/orders/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId, lineProfile })
        }).then(r => r.json());
        if (!res.ok) throw new Error(res.message || "取消訂單失敗");
        toast(res.pointsRestored ? "訂單已取消，點數已回補" : "訂單已取消");
        await refreshMemberData();
        expandedOrderId = orderId;
      } catch (error) {
        toast(error.message || "取消訂單失敗");
      } finally {
        cancellingOrderId = "";
        renderMemberPanel();
      }
    }
    function orderStatusText(status){
      const value = String(status || "").toUpperCase();
      if (value === "PAID") return "已付款";
      if (value === "PENDING") return "待付款";
      if (value === "CANCELLED") return "已取消";
      if (value === "PREPARING") return "\u5099\u8ca8\u4e2d";
      if (value === "SHIPPED") return "\u914d\u9001\u4e2d";
      if (value === "COMPLETED") return "已完成";
      return status || "-";
    }
    function paymentText(order){
      const method = String(order.paymentMethod || "").toUpperCase();
      if (method === "LINEPAY") return "LINE Pay";
      if (method === "REMITTANCE") return order.remittance ? "匯款末五碼 " + order.remittance : "銀行匯款";
      if (method === "COD") return "貨到付款";
      if (method === "POINTS") return "點數折抵";
      return order.paymentMethod || "-";
    }
    function renderReferralDetail(){
      const count = Number(memberData.referrals?.count || 0);
      const orderCount = Number(memberData.orders?.count || 0);
      return '<section class="member-detail"><div class="member-detail-head"><div class="member-detail-title">推薦成果</div></div>'
        + '<div class="points-summary"><div class="points-card"><small>推薦人數</small><b>'+money(count)+' 人</b></div><div class="points-card"><small>訂單紀錄</small><b>'+money(orderCount)+' 筆</b></div></div></section>';
    }
    function editMemberProfile(){ memberEditMode = true; renderMemberPanel(); }
    function cancelMemberEdit(){ memberEditMode = false; renderMemberPanel(); }
    async function refreshMemberData(){
      await loadMemberData(window.liff && liff.getAccessToken ? liff.getAccessToken() : "");
      renderMemberPanel();
    }
    async function saveMemberProfile(){
      if (!lineProfile.userId) return loginLine();
      const profile = {
        name: fieldValue("editName"),
        phone: fieldValue("editPhone"),
        gender: fieldValue("editGender"),
        birthday: fieldValue("editBirthday"),
        email: fieldValue("editEmail"),
        address: fieldValue("editAddress"),
        industry: fieldValue("editIndustry")
      };
      if (!profile.name || !profile.phone) return toast("請填寫姓名與手機");
      memberLoading = true;
      renderMemberPanel();
      try {
        const accessToken = window.liff && liff.getAccessToken ? liff.getAccessToken() : "";
        const res = await fetch("/api/huaxu/member", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken, lineUserId: lineProfile.userId, lineProfile, profile })
        }).then(r => r.json());
        if (!res.ok) throw new Error(res.message || "資料儲存失敗");
        memberData = Object.assign({}, memberData || {}, { bound: true, memberUid: res.memberUid, lineUserId: res.lineUserId, member: res.member });
        memberEditMode = false;
        activeMemberSection = "個人基本資料";
        toast("個人資料已更新");
      } catch (error) {
        toast(error.message || "資料儲存失敗");
      } finally {
        memberLoading = false;
        renderMemberPanel();
      }
    }
    function fieldValue(id){ const el = document.getElementById(id); return el ? el.value.trim() : ""; }
    function formatDate(value){
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString("zh-TW", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
    }
    function toast(message){ const el = document.getElementById("toast"); el.textContent = message; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2200); }
    function val(id){ return document.getElementById(id).value.trim(); }
    function money(value){ return Number(value || 0).toLocaleString("zh-TW"); }
    function escapeHtml(value){ return String(value || "").replace(/[&<>"']/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;" }[ch])); }
    function escapeAttr(value){ return escapeHtml(value).replace(/\\\\/g, "\\\\").replace(/'/g, "&#39;"); }
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-line-signature",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);
    if (url.pathname === "/referral" && request.method === "GET") {
      return new Response(await renderReferralHtml(env, request.url), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/referral/register" && request.method === "POST") {
      return handleReferralRegister(request, env, ctx);
    }
    if (url.pathname === "/api/referral/debug" && request.method === "POST") {
      return handleReferralDebug(request, env);
    }
    if (url.pathname === "/huaxu-shop.html" || url.pathname === "/huaxu-shop" || url.pathname.startsWith("/api/huaxu/")) {
      const huaxuResponse = await handleHuaxuShopRoute(request, env, ctx, this);
      if (huaxuResponse) return huaxuResponse;
    }
    if (url.pathname.startsWith("/linepay/confirm") || url.searchParams.get("action") === "LINEPAY_CONFIRM") {
      return this.handleLinePayConfirm(request, env, ctx);
    }
    if (url.pathname.startsWith("/linepay/cancel") || url.searchParams.get("action") === "LINEPAY_CANCEL") {
      return this.handleLinePayCancel(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname.startsWith("/img/")) {
      const fileName = url.pathname.replace("/img/", "");
      const object = await env['act-image']?.get(fileName);
      if (!object) return new Response("Not Found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('Cache-Control', 'public, max-age=31536000');
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-line-signature');
      return new Response(object.body, { headers });
    }

    if (url.pathname === "/ai-monitor") {
      url.pathname = "/line-oa-monitor.html";
      return Response.redirect(url.toString(), 302);
    }

    if (url.pathname.startsWith("/api/line-oa/") || url.pathname.startsWith("/api/broadcast/") || url.pathname.startsWith("/api/ai-learning/")) {
      const apiResponse = await handleHookTeaMonitorApi(request, env);
      if (apiResponse) return apiResponse;
    }

    if (url.pathname === "/hub-status") {
        return new Response(JSON.stringify({ gas: 'success', forward: 'success', line: 'success', allGood: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (request.method === "GET" && isReferralLiffRequest(url)) {
      return new Response(await renderReferralHtml(env, request.url), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname.includes("line-webhook") || request.headers.get("x-line-signature")) {
      return this.handleLineWebhook(request, env, ctx);
    }
    if (url.searchParams.get("action") === "NEWEBPAY_NOTIFY") {
      return this.handleNewebpayNotify(request, env, ctx);
    }
    const staticResponse = await serveStaticHtml(request, env, corsHeaders);
    if (staticResponse) return staticResponse;

    if (request.method === "POST") {
      return this.handleApiActions(request, env, ctx, corsHeaders);
    }

    return new Response("Hooktea API Node Active", { status: 200, headers: corsHeaders });
  },

  async handleApiActions(request, env, ctx, corsHeaders) {
    try {
      const body = await request.json();
      const { action, payload, userProfile, idToken, accessToken } = body;
      const claimedUserId = userProfile?.userId || payload?.userId || "GUEST";
      let result = { status: "success", data: null };

      if (!env.ACTION_DATA) {
          throw new Error("【Cloudflare 設定遺漏】尚未綁定 KV 空間！");
      }

      const access = await resolveAccess(env, claimedUserId, payload, idToken, accessToken);
      const userId = access.userId;
      const isSensitiveAdminAction = action?.startsWith("ADMIN_") || action === "UPLOAD_IMAGE" || action === "DEPLOY_RICH_MENU";
      const isTeacherAction = TEACHER_ALLOWED_ACTIONS.has(action);
      const isSystemAction = CRM_SYSTEM_ALLOWED_ACTIONS.has(action);

      if (isSensitiveAdminAction && !access.isAdmin) {
        if (!(access.isTeacher && isTeacherAction) && !(access.canSystemTools && isSystemAction) && !(access.canHeadquarter && HQ_ALLOWED_ACTIONS.has(action)) && !(access.canCrmLogin && !access.canSystemTools && CRM_LOGIN_ALLOWED_ACTIONS.has(action))) {
          throw new Error("Admin authorization required");
        }
      }

      if (action === "GET_USER_POINTS" && payload?.targetUid && payload.targetUid !== userId && !access.isAdmin && !access.canSystemTools) {
        throw new Error("Admin authorization required");
      }

      if (VERIFIED_USER_ACTIONS.has(action) && action !== "CHECK_USER" && !access.hasVerifiedLineUser && !access.isAdmin) {
        throw new Error("LINE authorization required");
      }

      if (action === "LOG_ADMIN_EVENT" && !(access.isAdmin || access.canCrmLogin || access.isTeacher)) {
        throw new Error("Admin authorization required");
      }

      switch (action) {
        case "CHECK_UPDATES":
          result.data = { lastUpdate: await env.ACTION_DATA.get("SYS_LAST_UPDATE") || "0" };
          break;

        case "ADMIN_WASABI_CHECK":
          result.data = await buildWasabiMigrationCheck(env);
          break;

        case "ADMIN_WASABI_EXPORT_LOW_RISK":
          result.data = await exportLowRiskWasabiSnapshot(env);
          break;

        case "ADMIN_WASABI_VERIFY_LOW_RISK":
          result.data = await verifyLowRiskWasabiSnapshot(env);
          break;

        case "ADMIN_WASABI_EXPORT_HIGH_RISK":
          result.data = await exportHighRiskWasabiSnapshot(env);
          break;

        case "ADMIN_WASABI_VERIFY_HIGH_RISK":
          result.data = await verifyHighRiskWasabiSnapshot(env);
          break;

        case "ADMIN_WASABI_DAILY_CHECK":
          result.data = await runWasabiDailyAcceptanceCheck(env);
          break;

        case "LOG_ADMIN_EVENT":
          result.data = { success: true };
          break;

        case "GET_SETTINGS":
          const storedSettings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
          const publicSettings = {
            ...storedSettings,
            crm_liff_id: getCrmLiffId(env, storedSettings),
            crm_line_login_enabled: isCrmLineLoginEnabled(env, storedSettings) ? "true" : "false",
          };
          if (access.isAdmin) {
            result.data = publicSettings;
          } else {
            const sanitizedSettings = { ...publicSettings };
            for (const key of Object.keys(sanitizedSettings)) {
              if (/(token|secret|password|pwd|api[_-]?key|hash[_-]?(key|iv))/i.test(key)) {
                delete sanitizedSettings[key];
              }
            }
            delete sanitizedSettings.admin_uids;
            delete sanitizedSettings.crm_login_uids;
            result.data = sanitizedSettings;
          }
          break;
          
        case "GET_COURSES":
          const courses = await safeGetCourses(env);
          result.data = courses.filter(c => c && c.isDeleted !== true && c.isPublished !== false);
          break;

        case "GET_PRODUCTS":
          const products = await safeGetProducts(env);
          result.data = products.filter(p => {
            if (!p || p.isPublished === false) return false;
            if (p.isDeleted === true) return false;
            const status = String(p.status || "");
            return !status || status.includes("販賣") || /sell|active|on/i.test(status);
          });
          break;

        case "GET_VIDEOS": {
          const videos = await safeGetVideos(env);
          result.data = videos
            .filter(v => v && v.isPublished !== false && v.driveFileId)
            .map(v => ({
              ...v,
              previewUrl: `https://drive.google.com/file/d/${v.driveFileId}/preview`,
              viewUrl: `https://drive.google.com/file/d/${v.driveFileId}/view`,
            }));
          break;
        }

        case "GET_BOOKING_DATA":
          const bookingUsers = await listUserRecords(env);
          const bookingCourses = await safeGetCourses(env);
          const bookingSlots = await safeGetKV(env, "SLOTS", []);
          const bookingOrders = await safeGetKV(env, "ORDERS", []);
          const occupiedBookingLocations = (Array.isArray(bookingOrders) ? bookingOrders : [])
            .filter(order => order && order.type === "BOOKING" && !["CANCELLED", "REFUNDED"].includes(String(order.status || "").toUpperCase()))
            .map(order => ({
              date: order.schedule?.date || order.bookingDate || "",
              time: order.schedule?.time || order.bookingTime || "",
              location: order.location || order.service?.location || "",
            }))
            .filter(item => item.date && item.time && item.location);
          result.data = {
            settings: { liff_id: access.settings?.liff_id || "" },
            teachers: uniqueTeachers(bookingUsers),
            courses: bookingCourses.filter(c => c && c.isPublished !== false),
            slots: Array.isArray(bookingSlots) ? bookingSlots : [],
            occupiedLocations: occupiedBookingLocations,
          };
          break;
          
        case "CHECK_USER":
          result.data = {
            registered: !!access.userData,
            info: access.userData,
            userId: access.userId,
            lineUserId: access.lineUserId || access.userId,
            legacyBound: !!access.legacyBinding?.legacyUserId,
            legacyUserId: access.legacyBinding?.legacyUserId || "",
            name: access.userData?.name || access.userData?.displayName || access.lineProfile?.name || "",
            pictureUrl: access.userData?.pictureUrl || access.userData?.avatar || access.lineProfile?.picture || "",
            isAdmin: access.isAdmin,
            canCrmLogin: access.canCrmLogin,
            canHeadquarter: access.canHeadquarter,
            canSystemTools: access.canSystemTools,
            isTeacher: access.isTeacher,
            crmLineLoginEnabled: access.crmLineLoginEnabled,
          };
          break;

        case "BIND_LEGACY_MEMBER": {
          const bindResult = await bindLegacyMemberToLine(env, ctx, access.lineUserId || userId, payload, access.lineProfile);
          if (!bindResult.bound) throw new Error(`舊會員綁定失敗：${bindResult.reason || "not_found"}`);
          result.data = {
            success: true,
            userId: bindResult.userId,
            memberData: bindResult.member,
            source: bindResult.source,
          };
          break;
        }
          
        case "GET_USER_POINTS":
          {
            const pointUid = payload?.targetUid || userId;
            const localPointData = await safeGetKV(env, `POINTS_${pointUid}`, { balance: 0, logs: [] });
            const pointMember = await safeGetKV(env, `USER_${pointUid}`, null);
            const pointSettings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
            const sharedPointData = await queryWetwPointList(pointSettings, pointMember || { userId: pointUid, lineUserId: pointUid }, env).catch(error => ({
              ok: false,
              reason: "wp_query_exception",
              message: error?.message || String(error),
            }));
            result.data = resolveDisplayPointData(localPointData, sharedPointData, 50);
          }
          break;
          
        case "GET_USER_ORDERS":
          const allOrd = await safeGetKV(env, "ORDERS", []);
          result.data = allOrd.filter(o => o.userId === userId);
          break;

        case "TEACHER_GET_MY_COURSES": {
          if (!access.isTeacher && !access.isAdmin) throw new Error("Teacher authorization required");
          const allCoursesForTeacher = await safeGetCourses(env);
          result.data = allCoursesForTeacher.filter(course => courseBelongsToTeacher(course, access.userData, userId));
          break;
        }

        case "TEACHER_UPDATE_COURSE": {
          if (!access.isTeacher && !access.isAdmin) throw new Error("Teacher authorization required");
          const allCoursesForUpdate = await safeGetCourses(env);
          const incomingCourse = { ...(payload || {}) };
          if (!incomingCourse.name) throw new Error("Course name required");
          const courseId = String(incomingCourse.id || `NEW_${Date.now()}`);
          const existingIndex = allCoursesForUpdate.findIndex(course => course && String(course.id) === courseId);
          const existingCourse = existingIndex >= 0 ? allCoursesForUpdate[existingIndex] : null;
          if (!access.isAdmin && existingCourse && !courseBelongsToTeacher(existingCourse, access.userData, userId)) {
            throw new Error("Teacher scope mismatch");
          }
          incomingCourse.id = courseId;
          incomingCourse.instructor = access.userData?.name || incomingCourse.instructor || userProfile?.displayName || "";
          incomingCourse.teacherUid = userId;
          incomingCourse.updatedAt = new Date().toISOString();
          if (existingIndex >= 0) allCoursesForUpdate[existingIndex] = { ...existingCourse, ...incomingCourse };
          else allCoursesForUpdate.unshift({ ...incomingCourse, createdAt: new Date().toISOString() });
          const teacherCourseStorage = await safePutCourses(env, allCoursesForUpdate);
          touchLastUpdate(env, ctx, "Courses");
          result.data = { success: true, course: incomingCourse, storage: teacherCourseStorage.storage };
          break;
        }

        case "TEACHER_DELETE_COURSE": {
          if (!access.isTeacher && !access.isAdmin) throw new Error("Teacher authorization required");
          const deleteCourseId = String(payload?.courseId || "").trim();
          if (!deleteCourseId) throw new Error("Course id required");
          const allCoursesForDelete = await safeGetCourses(env);
          const targetCourse = allCoursesForDelete.find(course => course && String(course.id) === deleteCourseId);
          if (!targetCourse) throw new Error("Course not found");
          if (!access.isAdmin && !courseBelongsToTeacher(targetCourse, access.userData, userId)) {
            throw new Error("Teacher scope mismatch");
          }
          const nextCourses = allCoursesForDelete.map(course => {
            if (!course || String(course.id) !== deleteCourseId) return course;
            return { ...course, isPublished: false, updatedAt: new Date().toISOString() };
          });
          await safePutCourses(env, nextCourses);
          touchLastUpdate(env, ctx, "Courses");
          result.data = { success: true };
          break;
        }

        case "TEACHER_GET_MY_REPORT": {
          if (!access.isTeacher && !access.isAdmin) throw new Error("Teacher authorization required");
          const reportCourses = await safeGetCourses(env);
          const teacherCoursesForReport = reportCourses.filter(course => courseBelongsToTeacher(course, access.userData, userId));
          const courseKeySet = new Set();
          for (const course of teacherCoursesForReport) {
            if (course?.id) courseKeySet.add(String(course.id));
            const title = getCourseTitle(course);
            if (title) courseKeySet.add(title);
            if (course?.name) courseKeySet.add(String(course.name));
          }
          const reportOrders = await safeGetKV(env, "ORDERS", []);
          const teacherOrders = reportOrders.filter(order => {
            if (!order || order.type === "PRODUCT") return false;
            if (String(order.teacher?.userId || order.teacherUid || "") === String(userId)) return true;
            if (Array.isArray(order.teacher?.teacherUids) && order.teacher.teacherUids.map(String).includes(String(userId))) return true;
            const key = getOrderCourseKey(order);
            return key && courseKeySet.has(key);
          });
          const grossAmount = teacherOrders.reduce((sum, order) => sum + (Number(String(order.originalAmount || order.service?.price || order.teacherCollectAmount || order.amount || 0).replace(/[^0-9.-]/g, "")) || 0), 0);
          const paidAmount = teacherOrders
            .filter(order => String(order.status || "").toUpperCase() === "PAID" || String(order.attendance || "").toUpperCase() === "ATTENDED")
            .reduce((sum, order) => sum + (Number(String(order.teacherCollectAmount || order.amount || 0).replace(/[^0-9.-]/g, "")) || 0), 0);
          const pointLedgerForTeacher = await safeGetKV(env, "POINT_LEDGER", []);
          const teacherDeductions = (Array.isArray(pointLedgerForTeacher) ? pointLedgerForTeacher : [])
            .filter(entry => {
              if (!entry) return false;
              const source = String(entry.source || "");
              if (["slot_open", "teacher_commission"].includes(source) && String(entry.uid || "") === String(userId)) return true;
              return source === "teacher_deduct" && String(entry.operatorUid || "") === String(userId);
            });
          const deductedPoints = teacherDeductions.reduce((sum, entry) => sum + (Number(entry.points || Math.abs(entry.amount || 0)) || 0), 0);
          result.data = {
            courses: teacherCoursesForReport.map(course => ({ id: course.id, name: getCourseTitle(course), type: course.type || "", price: course.price || 0 })),
            orders: teacherOrders,
            deductions: teacherDeductions,
            summary: { orderCount: teacherOrders.length, grossAmount, paidAmount, deductCount: teacherDeductions.length, deductedPoints }
          };
          break;
        }

        case "TEACHER_COMPLETE_BOOKING": {
          if (!access.isTeacher && !access.isAdmin) throw new Error("Teacher authorization required");
          const orderId = String(payload?.orderId || "").trim();
          if (!orderId) throw new Error("缺少預約單號");
          const bookingOrdersForComplete = await safeGetKV(env, "ORDERS", []);
          const completeIdx = bookingOrdersForComplete.findIndex(order => order && String(order.orderId) === orderId);
          if (completeIdx < 0) throw new Error("找不到預約資料");
          const targetBooking = bookingOrdersForComplete[completeIdx];
          const teacherUid = String(targetBooking.teacher?.userId || targetBooking.teacherUid || "").trim();
          const teacherUids = Array.isArray(targetBooking.teacher?.teacherUids) ? targetBooking.teacher.teacherUids.map(String) : [];
          if (!access.isAdmin && teacherUid !== String(userId) && !teacherUids.includes(String(userId))) {
            throw new Error("只能核銷自己的預約");
          }
          if (String(targetBooking.status || "") === "CANCELLED") throw new Error("已取消的預約不能核銷");
          let completedBooking = {
            ...targetBooking,
            attendance: "ATTENDED",
            status: "COMPLETED",
            completedAt: targetBooking.completedAt || new Date().toISOString(),
          };
          completedBooking = await deductTeacherCommissionForOrder(env, ctx, completedBooking, userId, access.userData?.name || userProfile?.displayName || "Teacher", this.updatePoints.bind(this));
          bookingOrdersForComplete[completeIdx] = completedBooking;
          await putOrdersKV(env, ctx, bookingOrdersForComplete);
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()));
          result.data = { success: true, order: completedBooking };
          break;
        }

        case "TEACHER_DEDUCT_POINTS": {
          if (!access.isTeacher && !access.isAdmin) throw new Error("Teacher authorization required");
          const targetUid = String(payload?.targetUid || payload?.uid || "").trim();
          const deductAmount = Math.abs(Number(payload?.amount || 0));
          const deductReason = String(payload?.reason || "").trim();
          if (!targetUid) throw new Error("請輸入會員 UID");
          if (!deductAmount) throw new Error("請輸入扣點點數");
          const currentPointData = await safeGetKV(env, `POINTS_${targetUid}`, { balance: 0, logs: [] });
          const currentBalance = Number(currentPointData.balance || 0);
          if (currentBalance < deductAmount) throw new Error("會員點數不足");
          const teacherName = access.userData?.name || userProfile?.displayName || userId;
          const finalReason = `講師扣點：${teacherName}${deductReason ? ` - ${deductReason}` : ""}`;
          await this.updatePoints(env, ctx, targetUid, -deductAmount, finalReason, {
            source: "teacher_deduct",
            operatorUid: userId,
            operatorName: teacherName,
            targetName: payload?.studentName || "",
          });
          result.data = { success: true, balance: currentBalance - deductAmount };
          break;
        }

        case "REGISTER_USER": {
          const bindResult = await bindLegacyMemberToLine(env, ctx, access.lineUserId || userId, payload, access.lineProfile);
          const memberUid = bindResult.bound ? bindResult.userId : userId;
          const currentMember = bindResult.bound ? bindResult.member : await safeGetKV(env, `USER_${memberUid}`, {});
          const savedRegisterMember = {
            ...currentMember,
            ...payload,
            userId: memberUid,
            lineUserId: access.lineUserId || userId,
            linkedLineUid: access.lineUserId || userId,
            createdAt: currentMember?.createdAt || new Date().toLocaleString(),
            updatedAt: new Date().toISOString(),
            memberTier: payload.memberTier || currentMember?.memberTier || "一般會員",
          };
          await putUserKV(env, ctx, memberUid, savedRegisterMember);
          
          const setsReg = await safeGetKV(env, "SYSTEM_SETTINGS", {});
          if (!bindResult.bound) await this.updatePoints(env, ctx, memberUid, setsReg.reward_register || 100, "註冊獎勵");
          
          if (env.GAS_URL) {
              ctx.waitUntil(fetch(env.GAS_URL, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "REGISTER_USER", payload: savedRegisterMember }),
                  redirect: "follow"
              }).catch(e => console.error("GAS Sync Error:", e)));
          }

          ctx.waitUntil(this.sendTgMessage(env, `🆕 <b>新學員註冊</b>\n姓名：${payload.name}\n電話：${payload.phone}\n業種：${payload.industry || '未填寫'}`));
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString())); 

          result.data = { success: true, userId: memberUid, legacyBound: !!bindResult.bound, bindSource: bindResult.source || "" };
          break;
        }
          
        case "DAILY_CHECKIN":
          const today = taipeiDateKey();
          const checkKey = `CHECKIN_${userId}_${today}`;
          if (await safeGetKV(env, checkKey, false, { preferWasabi: false })) throw new Error("今天已經領過紅包囉！");
          const setsDaily = await safeGetKV(env, "SYSTEM_SETTINGS", {});
          const pts = setsDaily.reward_daily || 10;
          await safePutKV(env, checkKey, true, { expirationTtl: secondsUntilNextTaipeiMidnight() });
          
          await this.updatePoints(env, ctx, userId, pts, "每日登入紅包");
          result.data = { earned: pts };
          break;

        case "CREATE_BOOKING": {
          const service = payload?.service || {};
          const teacher = payload?.teacher || {};
          const schedule = payload?.schedule || {};
          const customer = payload?.customer || {};
          const serviceId = String(service.id || service.courseId || "").trim();
          const teacherUidsForBooking = Array.isArray(teacher.teacherUids) && teacher.teacherUids.length
            ? teacher.teacherUids.map(String)
            : [String(teacher.userId || "").trim()].filter(Boolean);
          const bookingDate = String(schedule.date || "").trim();
          const bookingTime = String(schedule.time || "").trim();
          if (!serviceId) throw new Error("缺少預約項目");
          if (!teacherUidsForBooking.length) throw new Error("缺少導師資料");
          if (!bookingDate || !bookingTime) throw new Error("缺少預約時段");

          let bookingSlotList = await safeGetKV(env, "SLOTS", []);
          const slotIndex = bookingSlotList.findIndex(slot =>
            slot &&
            teacherUidsForBooking.includes(String(slot.teacherUid || "")) &&
            slot.date === bookingDate &&
            slot.time === bookingTime &&
            slot.status === "OPEN"
          );
          if (slotIndex < 0) throw new Error("此時段已不可預約，請重新選擇");
          const selectedBookingSlot = bookingSlotList[slotIndex];
          const slotCourseId = String(selectedBookingSlot.courseId || "").trim();
          if (slotCourseId && slotCourseId !== serviceId && slotCourseId !== String(service.name || "").trim()) {
            throw new Error("此時段不屬於所選預約服務，請重新選擇");
          }

          let bookingOrderList = await safeGetKV(env, "ORDERS", []);
          const location = String(service.location || "").trim();
          if (location) {
            const locationBooked = bookingOrderList.some(order =>
              order &&
              order.type === "BOOKING" &&
              !["CANCELLED", "REFUNDED"].includes(String(order.status || "").toUpperCase()) &&
              (order.schedule?.date || order.bookingDate) === bookingDate &&
              (order.schedule?.time || order.bookingTime) === bookingTime &&
              String(order.location || order.service?.location || "").trim() === location
            );
            if (locationBooked) throw new Error("此場地同時段已被預約，請選擇其他時段");
          }

          const bookingCourseList = await safeGetCourses(env);
          const fullService = bookingCourseList.find(course => course && (String(course.id) === serviceId || String(course.name) === serviceId)) || service;
          const servicePrice = Number(String(fullService.price || service.price || 0).replace(/[^0-9.-]/g, "")) || 0;
          const maxBookingPoints = Math.min(servicePrice, Math.max(0, Number(fullService.maxPoints || service.maxPoints || 0)));
          const requestedBookingPoints = Math.max(0, Number(payload.pointsUsed || 0));
          if (requestedBookingPoints > maxBookingPoints) throw new Error(`此預約最多可折抵 ${maxBookingPoints} 點`);
          if (requestedBookingPoints > 0) {
            const bookingPointData = await safeGetKV(env, `POINTS_${userId}`, { balance: 0, logs: [] });
            if ((Number(bookingPointData.balance) || 0) < requestedBookingPoints) throw new Error("點數不足，無法完成折抵");
            await this.updatePoints(env, ctx, userId, -requestedBookingPoints, `預約服務折抵：${getCourseTitle(fullService) || serviceId}`);
          }

          const payableAmount = Math.max(0, servicePrice - requestedBookingPoints);
          const teacherCollectAmount = payableAmount;
          const orderId = `BOOK${Date.now()}`;
          const bookingUser = await safeGetKV(env, `USER_${userId}`, {});
          const bookingOrder = {
            orderId,
            type: "BOOKING",
            userId,
            name: customer.name || bookingUser.name || userProfile?.displayName || "未填寫",
            phone: customer.phone || bookingUser.phone || "",
            courseId: serviceId,
            courseName: getCourseTitle(fullService) || service.name || serviceId,
            service: {
              id: serviceId,
              name: getCourseTitle(fullService) || service.name || serviceId,
              location,
              price: servicePrice,
            },
            teacher: {
              userId: teacher.userId || teacherUidsForBooking[0],
              teacherUids: teacherUidsForBooking,
              name: teacher.name || fullService.instructor || "",
            },
            schedule: { date: bookingDate, time: bookingTime },
            bookingDate,
            bookingTime,
            location,
            amount: 0,
            originalAmount: servicePrice,
            pointsUsed: requestedBookingPoints,
            platformCollectedAmount: 0,
            teacherCollectAmount,
            paymentMethod: "TEACHER_DIRECT",
            note: customer.note || "",
            status: "BOOKED",
            createdAt: new Date().toLocaleString(),
          };

          bookingOrderList.unshift(bookingOrder);
          bookingSlotList[slotIndex] = { ...bookingSlotList[slotIndex], status: "BOOKED", orderId, userId };
          await putOrdersKV(env, ctx, bookingOrderList);
          await env.ACTION_DATA.put("SLOTS", JSON.stringify(bookingSlotList));
          if (env.GAS_URL) {
            ctx.waitUntil(fetch(env.GAS_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "SYNC_ORDER", payload: bookingOrder }),
              redirect: "follow",
            }).catch(e => console.error("GAS Sync Error", e)));
          }
          ctx.waitUntil(Promise.all([
            env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(() => {}),
            sendTelegramNotification(env, [
              "\u{1F4C5} <b>\u65b0\u9810\u7d04\u7533\u8acb</b>",
              `\u55ae\u865f\uFF1A<code>${escapeTelegramHtml(bookingOrder.orderId)}</code>`,
              `\u6703\u54e1\uFF1A${escapeTelegramHtml(bookingOrder.name)}`,
              `\u96fb\u8a71\uFF1A${escapeTelegramHtml(bookingOrder.phone || "-")}`,
              `\u9805\u76ee\uFF1A${escapeTelegramHtml(bookingOrder.courseName || "-")}` ,
              `\u6642\u9593\uFF1A${escapeTelegramHtml(bookingOrder.bookingDate || "-")} ${escapeTelegramHtml(bookingOrder.bookingTime || "-")}` ,
              `\u5c0e\u5e2b\uFF1A${escapeTelegramHtml(bookingOrder.teacher?.name || "-")}` ,
              `\u72c0\u614b\uFF1A${escapeTelegramHtml(bookingOrder.status || "-")}` ,
            ].join("\n")),
          ]));
          result.data = { success: true, orderId, amount: 0, teacherCollectAmount, pointsUsed: requestedBookingPoints };
          break;
        }

        case "REGISTER": 
          let currentOrders = await safeGetKV(env, "ORDERS", []);
          let userInfo = await safeGetKV(env, `USER_${userId}`, {});
          const coursePointsUsed = Math.max(0, Number(payload.pointsUsed || 0));
          const courseListForOrder = await safeGetCourses(env);
          const courseForOrder = courseListForOrder.find(c => c && (c.id === payload.courseId || c.name === payload.courseId)) || {};
          const coursePrice = Number(courseForOrder.price || 0);
          const isReservationOrderCourse = String(courseForOrder.type || "").includes("預約");
          const customMaxCoursePoints = isReservationOrderCourse ? Math.max(0, Number(courseForOrder.maxPoints || 0)) : 0;
          let maxAllowedCoursePoints = 0;
          if (customMaxCoursePoints > 0) maxAllowedCoursePoints = Math.min(customMaxCoursePoints, coursePrice);
          else if (courseForOrder.discountRule === "RULE_A") maxAllowedCoursePoints = Math.floor(coursePrice * 0.2);
          else if (courseForOrder.discountRule === "RULE_B") maxAllowedCoursePoints = Math.floor(coursePrice * 0.5);
          else if (courseForOrder.discountRule === "RULE_D") maxAllowedCoursePoints = Math.floor(coursePrice * 0.6);
          else if (courseForOrder.discountRule === "RULE_C") maxAllowedCoursePoints = coursePrice;
          if (coursePointsUsed > maxAllowedCoursePoints) throw new Error(`可抵用點數上限為 ${maxAllowedCoursePoints} 點`);
          if (coursePointsUsed > 0) {
            const currentPointData = await safeGetKV(env, `POINTS_${userId}`, { balance: 0, logs: [] });
            if ((Number(currentPointData.balance) || 0) < coursePointsUsed) throw new Error("點數不足，無法完成折抵");
            await this.updatePoints(env, ctx, userId, -coursePointsUsed, `課程折抵：${payload.courseId}`);
          }
          const coursePayableAmount = Math.max(0, Number(String(payload.amount ?? 0).replace(/[^0-9.-]/g, "")) || 0);
          const newOrder = {
              orderId: `ORD${Date.now()}`,
              userId: userId,
              name: userInfo.name || "未填寫",
              phone: userInfo.phone || "未填寫",
              courseId: payload.courseId,
              amount: coursePayableAmount,
              pointsUsed: coursePointsUsed,
              paymentMethod: coursePayableAmount <= 0 ? "POINTS" : (payload.paymentMethod || "NEWEBPAY"),
              status: coursePayableAmount <= 0 ? 'PAID' : 'PENDING',
              createdAt: new Date().toLocaleString()
          };
          currentOrders.unshift(newOrder); 
          await putOrdersKV(env, ctx, currentOrders);
          
          if (env.GAS_URL) {
              ctx.waitUntil(fetch(env.GAS_URL, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "SYNC_ORDER", payload: newOrder }),
                  redirect: "follow"
              }).catch(e => console.error("GAS Sync Error", e)));
          }

          ctx.waitUntil((async () => {
             let cList = await safeGetCourses(env);
             let targetCourse = cList.find(c => c.id === payload.courseId);
             let courseName = targetCourse ? targetCourse.name.split('\n')[0] : payload.courseId;
             const finalAmount = Number(newOrder.amount || 0);
             const statusLabel = finalAmount <= 0
               ? (Number(newOrder.pointsUsed || 0) > 0 ? "點數全額折抵" : "免費")
               : "待付款";
             await this.sendTgMessage(env, `💰 <b>新課程報名單</b>\n學員：${newOrder.name}\n電話：${newOrder.phone}\n課程：${courseName}\n金額：$${newOrder.amount}\n狀態：${statusLabel}`);
          })());
          
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString())); 

          result.data = { success: true, orderId: newOrder.orderId };
          break;

        case "BUY_PRODUCT":
          const productList = await safeGetProducts(env);
          const product = productList.find(p => p && (p.id === payload.productId || p.code === payload.productId));
          if (!product || product.isPublished === false) throw new Error("商品不存在或未上架");
          const quantity = Math.max(1, Math.floor(Number(payload.quantity || 1)));
          if (product.stock !== null && product.stock !== undefined && Number(product.stock) <= 0) throw new Error("商品已售完");
          if (product.stock !== null && product.stock !== undefined && quantity > Number(product.stock || 0)) throw new Error("商品庫存不足");
          const unitPrice = Math.max(0, Number(product.price || 0));
          const productPrice = unitPrice * quantity;
          const maxPointDeduction = Math.max(0, Number(product.pointsPrice || 0)) * quantity;
          const pointCost = Math.max(0, Number(payload.pointsUsed ?? payload.customPoints ?? 0));
          if (pointCost > maxPointDeduction) throw new Error("使用點數超過商品可扣點上限");
          if (pointCost > productPrice) throw new Error("使用點數不可超過商品售價");
          const payableAmount = Math.max(0, productPrice - pointCost);
          const buyerPoints = await safeGetKV(env, `POINTS_${userId}`, { balance: 0, logs: [] });
          if ((Number(buyerPoints.balance) || 0) < pointCost) throw new Error("點數不足，無法購買");
          const buyerInfo = await safeGetKV(env, `USER_${userId}`, {});
          const shopOrders = await safeGetKV(env, "ORDERS", []);
          const productOrder = {
            orderId: `SHOP${Date.now()}`,
            type: "PRODUCT",
            userId,
            name: buyerInfo.name || userProfile?.displayName || "會員",
            phone: buyerInfo.phone || "",
            productId: product.id,
            productName: product.name,
            productCode: product.code || "",
            productSource: product.source || "hooktea",
            quantity,
            unitPrice,
            originalAmount: productPrice,
            amount: payableAmount,
            pointsUsed: pointCost,
            paymentMethod: payableAmount > 0 ? (payload.paymentMethod || "NEWEBPAY") : "POINTS",
            status: payableAmount > 0 ? "PENDING" : "PAID",
            createdAt: new Date().toLocaleString()
          };
          if (pointCost > 0) await this.updatePoints(env, ctx, userId, -pointCost, `商城商品折抵：${product.name}`);
          if (product.stock !== null && product.stock !== undefined && product.source !== "huaxu") {
            product.stock = Math.max(0, Number(product.stock) - quantity);
            await safePutProducts(env, productList);
          }
          shopOrders.unshift(productOrder);
          await putOrdersKV(env, ctx, shopOrders);
          ctx.waitUntil(Promise.all([
            env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(() => {}),
            sendTelegramNotification(env, [
              "\u{1F6D2} <b>\u65b0\u5546\u54c1\u8a02\u55ae</b>",
              `\u55ae\u865f\uFF1A<code>${escapeTelegramHtml(productOrder.orderId)}</code>`,
              `\u6703\u54e1\uFF1A${escapeTelegramHtml(productOrder.name)}`,
              `\u96fb\u8a71\uFF1A${escapeTelegramHtml(productOrder.phone || "-")}`,
              `\u5546\u54c1\uFF1A${escapeTelegramHtml(productOrder.productName)} x ${productOrder.quantity}`,
              `\u91d1\u984d\uFF1A${Number(productOrder.amount || 0)}` ,
              `\u4ed8\u6b3e\uFF1A${escapeTelegramHtml(productOrder.paymentMethod || "-")}` ,
              `\u72c0\u614b\uFF1A${escapeTelegramHtml(productOrder.status || "-")}` ,
            ].join("\n")),
          ]));
          result.data = { success: true, orderId: productOrder.orderId, amount: payableAmount, pointsUsed: pointCost, balance: (Number(buyerPoints.balance) || 0) - pointCost };
          break;

        case "UPDATE_MY_ORDER": {
          const orderId = String(payload?.orderId || "").trim();
          if (!orderId) throw new Error("缺少訂單編號");
          const remittance = String(payload?.remittance || "").replace(/\D/g, "").slice(0, 5);
          if (remittance && remittance.length !== 5) throw new Error("匯款末五碼格式錯誤");
          const userOrders = await safeGetKV(env, "ORDERS", []);
          const orderIndex = userOrders.findIndex(o => o && o.orderId === orderId && o.userId === userId);
          if (orderIndex < 0) throw new Error("找不到可更新的訂單");
          const currentOrder = userOrders[orderIndex];
          if (String(currentOrder.status || "").toUpperCase() !== "PENDING") throw new Error("此訂單目前不可回報付款");
          userOrders[orderIndex] = {
            ...currentOrder,
            remittance,
            remittanceReportedAt: new Date().toLocaleString(),
            updatedAt: new Date().toISOString(),
          };
          await putOrdersKV(env, ctx, userOrders);
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(e => console.error("[Orders] SYS_LAST_UPDATE 寫入失敗", e)));
          result.data = { success: true, order: userOrders[orderIndex] };
          break;
        }

        case "CANCEL_MY_ORDER": {
          const orderId = String(payload?.orderId || "").trim();
          if (!orderId) throw new Error("缺少訂單編號");
          const cancelOrders = await safeGetKV(env, "ORDERS", []);
          const cancelIndex = cancelOrders.findIndex(o => o && o.orderId === orderId && o.userId === userId);
          if (cancelIndex < 0) throw new Error("找不到可取消的訂單");
          const targetOrder = cancelOrders[cancelIndex];
          if (String(targetOrder.status || "").toUpperCase() !== "PENDING" || targetOrder.remittance) {
            throw new Error("此訂單目前不可取消");
          }
          cancelOrders[cancelIndex] = {
            ...targetOrder,
            status: "CANCELLED",
            cancelledAt: new Date().toLocaleString(),
            updatedAt: new Date().toISOString(),
          };
          await putOrdersKV(env, ctx, cancelOrders);
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(e => console.error("[Orders] SYS_LAST_UPDATE 寫入失敗", e)));
          result.data = { success: true, order: cancelOrders[cancelIndex] };
          break;
        }

        case "ADMIN_IMPORT_PRODUCTS":
          if (!Array.isArray(payload.products)) throw new Error("缺少商品資料");
          const oldProducts = await safeGetProducts(env);
          const mergedProducts = mergeProducts(oldProducts, payload.products, payload.mode || "append");
          await safePutProducts(env, mergedProducts);
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(e => console.error("[Products] SYS_LAST_UPDATE 寫入失敗", e)));
          result.data = { success: true, count: mergedProducts.length };
          break;

        case "ADMIN_IMPORT_WP_PRODUCTS":
          let wpSiteUrl = String(payload.siteUrl || "https://aiwe.cc").trim();
          const wpUsername = String(payload.username || "").trim();
          const wpAppPassword = String(payload.appPassword || "").trim();
          let wpPostIds = Array.isArray(payload.postIds)
            ? payload.postIds
            : String(payload.postIds || "").split(/[\s,，]+/).filter(Boolean);
          try {
            const parsedWpUrl = new URL(wpSiteUrl);
            const urlPostId = parsedWpUrl.searchParams.get("post");
            if (urlPostId && !wpPostIds.includes(urlPostId)) wpPostIds = [urlPostId, ...wpPostIds];
            wpSiteUrl = parsedWpUrl.origin;
          } catch (_) {
            // Keep the original value so fetchWpJson can report a useful URL error.
          }
          if (!wpUsername || !wpAppPassword) throw new Error("請輸入 WordPress 帳號與 Application Password");
          if (!wpPostIds.length) throw new Error("請輸入 WordPress 商品 post ID");
          const wpAuthHeader = `Basic ${btoa(`${wpUsername}:${wpAppPassword}`)}`;
          let importedProducts = [];
          const importErrors = [];
          try {
            importedProducts = await importWpProductsFromActionEndpoint(wpSiteUrl, wpPostIds, wpAuthHeader);
          } catch (e) {
            importErrors.push({ postId: "action-import-endpoint", message: e.message });
          }
          if (!importedProducts.length) {
            for (const postId of wpPostIds) {
              try {
                importedProducts.push(await importWpProduct(wpSiteUrl, postId, wpAuthHeader));
              } catch (e) {
                importErrors.push({ postId, message: e.message });
              }
            }
          }
          if (!importedProducts.length) {
            throw new Error(`沒有成功匯入任何商品。linecard_21 目前沒有開 WordPress REST API；請先安裝 HookTea linecard 匯出外掛，或請網站工程師把 linecard_21 設定 show_in_rest=true。詳細：${importErrors.map(e => `${e.postId}: ${e.message}`).join(" / ")}`);
          }
          const currentWpProducts = await safeGetProducts(env);
          const nextWpProducts = mergeProducts(currentWpProducts, importedProducts, payload.mode || "append");
          await safePutProducts(env, nextWpProducts);
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(e => console.error("[Products] SYS_LAST_UPDATE 寫入失敗", e)));
          result.data = { success: true, count: nextWpProducts.length, imported: importedProducts, errors: importErrors };
          break;

        // ==============================================
        // 🚀 終極修復：無敵防爆、智能分頁、加上 GAS 降落傘救援
        // ==============================================
        case "ADMIN_GET_DATA":
          let localUsers = uniqueUsersById(await listUserRecords(env));
          let repairedLineNames = false;
          localUsers = await Promise.all(localUsers.map(async user => {
              const filledUser = await fillMissingLineProfile(env, user);
              if (filledUser !== user) {
                  repairedLineNames = true;
                  await safePutKV(env, `USER_${filledUser.userId}`, filledUser);
              }
              return filledUser;
          }));
          if (repairedLineNames) ctx.waitUntil(observeHighRiskDualWrite(env, null, "users"));
          let adminCourses = await safeGetCourses(env);
          let adminOrders = await safeGetKV(env, "ORDERS", []);
          let adminSettings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
          let repairedPaidOrders = false;
          adminOrders = Array.isArray(adminOrders) ? adminOrders.map(order => {
              if (!order || String(order.status || "").toUpperCase() === "PAID") return order;
              const hasPaidEvidence = !!(order.newebpayTradeNo || order.paidAt) || String(order.paymentStatus || "").toUpperCase() === "SUCCESS" || String(order.newebpayStatus || "").toUpperCase() === "SUCCESS";
              if (!hasPaidEvidence) return order;
              repairedPaidOrders = true;
              return { ...order, status: "PAID", updatedAt: order.updatedAt || new Date().toISOString() };
          }) : [];
          if (repairedPaidOrders) ctx.waitUntil(putOrdersKV(env, ctx, adminOrders));

          // 🛡️ 降落傘救援：如果 KV 設定檔是空的，代表這是初次轉移或 KV 被洗掉，立刻向 GAS 求救
          if (Object.keys(adminSettings).length === 0 && env.GAS_URL) {
              try {
                  const gasRes = await fetch(env.GAS_URL, {
                      method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "ADMIN_GET_DATA" })
                  });
                  const gasJson = await gasRes.json();
                  
                  if (gasJson.status === 'success' && gasJson.data) {
                      if(gasJson.data.courses && gasJson.data.courses.length > 0) { 
                          adminCourses = gasJson.data.courses; 
                          ctx.waitUntil(safePutCourses(env, adminCourses)); 
                      }
                      if(gasJson.data.orders && gasJson.data.orders.length > 0) { 
                          adminOrders = gasJson.data.orders; 
                          ctx.waitUntil(putOrdersKV(env, ctx, adminOrders)); 
                      }
                      if(gasJson.data.settings && Object.keys(gasJson.data.settings).length > 0) { 
                          adminSettings = gasJson.data.settings; 
                          ctx.waitUntil(env.ACTION_DATA.put("SYSTEM_SETTINGS", JSON.stringify(adminSettings))); 
                      }
                      if(gasJson.data.users && gasJson.data.users.length > localUsers.length) {
                          localUsers = uniqueUsersById(gasJson.data.users);
                          // 背景大量寫入 KV
                          ctx.waitUntil((async () => {
                              for(let u of gasJson.data.users) await safePutKV(env, `USER_${u.userId}`, u);
                              await observeHighRiskDualWrite(env, null, "users");
                          })());
                      }
                  }
              } catch(e) { console.error("[GAS Rescue Error] 降落傘救援失敗:", e); }
          }

          result.data = {
              users: localUsers,
              courses: adminCourses,
              orders: adminOrders,
              products: await safeGetProducts(env),
              paymentLogs: await safeGetKV(env, "PAYMENT_LOGS", [], { preferWasabi: false }),
              lineBindReviews: await listLineBindReviewCases(env),
              flexRules: await safeGetKV(env, "FLEX_RULES", []),
              broadcastTags: normalizeAudienceTags(await safeGetKV(env, "BROADCAST_TAGS", [])),
              broadcastCampaigns: await safeGetKV(env, "PAID_BROADCASTS", []),
              teachers: localUsers.filter(u => u.memberTier && ['專業導師', '導師'].some(t => u.memberTier.includes(t))),
              settings: adminSettings
          };
          result.data.teachers = localUsers.filter(isTeacherRecord);
          if (!access.isAdmin && access.isTeacher) {
              const currentTeacher = result.data.teachers.find(u => u.userId === userId) || access.userData;
              const teacherCourses = adminCourses.filter(course => courseBelongsToTeacher(course, currentTeacher, userId));
              result.data = {
                  users: [],
                  courses: teacherCourses,
                  orders: [],
                  teachers: currentTeacher ? [currentTeacher] : [],
                  settings: {}
              };
          }
          if (!access.isAdmin && access.canCrmLogin) {
              result.data.orders = [];
              result.data.paymentLogs = [];
              result.data.settings = {
                crm_line_login_enabled: isCrmLineLoginEnabled(env, adminSettings) ? "true" : "false",
                crm_liff_id: getCrmLiffId(env, adminSettings),
                liff_id: adminSettings.liff_id || "",
              };
          }
          break;

        case "ADMIN_GET_POINTS_LEDGER":
          if (!access.isAdmin) throw new Error("Admin authorization required");
          result.data = await getPointsLedger(env, payload.limit || 50, { includeLegacy: payload.includeLegacy === true });
          break;

        case "ADMIN_GET_AUDIT_LOGS": {
          if (!access.isAdmin) throw new Error("Admin authorization required");
          const auditLogs = await safeGetKV(env, "AUDIT_LOGS", [], { preferWasabi: false });
          result.data = Array.isArray(auditLogs) ? auditLogs : [];
          break;
        }

        case "ADMIN_GET_BROADCAST_DATA": {
          if (!access.isAdmin) throw new Error("Admin authorization required");
          result.data = {
            tags: normalizeAudienceTags(await safeGetKV(env, "BROADCAST_TAGS", [])),
            campaigns: await safeGetKV(env, "PAID_BROADCASTS", []),
            flexRules: await safeGetKV(env, "FLEX_RULES", []),
          };
          break;
        }

        case "ADMIN_SAVE_REPLY_RULE": {
          if (!access.isAdmin) throw new Error("Admin authorization required");
          const existingFlexRules = await safeGetKV(env, "FLEX_RULES", []);
          const flexRules = Array.isArray(existingFlexRules) ? existingFlexRules : [];
          const nowIso = new Date().toISOString();
          const rule = {
            ...payload,
            id: String(payload?.id || `FR_${Date.now()}`).trim(),
            moduleName: String(payload?.moduleName || payload?.keyword || "HookTea 模組").trim(),
            keyword: String(payload?.keyword || "").trim(),
            replyType: String(payload?.replyType || "FLEX").trim().toUpperCase(),
            flexTemplate: String(payload?.flexTemplate || "v1").trim().toLowerCase(),
            payload: String(payload?.payload || payload?.flexJson || "").trim(),
            flexJson: String(payload?.flexJson || payload?.payload || "").trim(),
            active: payload?.active !== false,
            createdAt: payload?.createdAt || nowIso,
            updatedAt: nowIso,
          };
          if (!rule.moduleName) throw new Error("請輸入模組名稱");
          if (!rule.payload && !rule.flexJson && !rule.imageUrl && !rule.bodyText) throw new Error("請輸入模組內容");
          const idx = flexRules.findIndex(item => item && item.id === rule.id);
          if (idx >= 0) flexRules[idx] = { ...flexRules[idx], ...rule };
          else flexRules.unshift(rule);
          await safePutKV(env, "FLEX_RULES", flexRules);
          result.data = { success: true, flexRules };
          break;
        }

        case "ADMIN_DELETE_REPLY_RULE": {
          if (!access.isAdmin) throw new Error("Admin authorization required");
          const id = String(payload?.id || "").trim();
          if (!id) throw new Error("缺少模組 ID");
          const flexRules = (await safeGetKV(env, "FLEX_RULES", []) || []).filter(rule => rule && rule.id !== id);
          await safePutKV(env, "FLEX_RULES", flexRules);
          result.data = { success: true, flexRules };
          break;
        }

        case "ADMIN_SAVE_AUDIENCE_TAG": {
          if (!access.isAdmin) throw new Error("Admin authorization required");
          const name = String(payload?.name || "").trim();
          if (!name) throw new Error("請輸入標籤名稱");
          const tags = normalizeAudienceTags(await safeGetKV(env, "BROADCAST_TAGS", []));
          const existingIndex = tags.findIndex(tag => tag.name === name || tag.id === payload?.id);
          const tag = {
            id: String(payload?.id || name).trim(),
            name,
            color: String(payload?.color || "#06C755").trim(),
            description: String(payload?.description || "").trim(),
            createdAt: payload?.createdAt || new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
          };
          if (existingIndex >= 0) tags[existingIndex] = { ...tags[existingIndex], ...tag };
          else tags.unshift(tag);
          await safePutKV(env, "BROADCAST_TAGS", tags);
          result.data = { success: true, tags };
          break;
        }

        case "ADMIN_TAG_MEMBER": {
          if (!access.isAdmin) throw new Error("Admin authorization required");
          const targetUid = String(payload?.userId || "").trim();
          const tagName = String(payload?.tagName || "").trim();
          const enabled = payload?.enabled !== false;
          if (!targetUid || !tagName) throw new Error("缺少會員 UID 或標籤");
          const member = await safeGetKV(env, `USER_${targetUid}`, null);
          if (!member) throw new Error("找不到會員資料");
          const tags = new Set(getUserBroadcastTags(member));
          if (enabled) tags.add(tagName);
          else tags.delete(tagName);
          member.broadcastTags = [...tags];
          await safePutKV(env, `USER_${targetUid}`, member);
          await observeHighRiskDualWrite(env, null, "users");
          result.data = { success: true, member };
          break;
        }

        case "ADMIN_SEND_PAID_BROADCAST": {
          if (!access.isAdmin) throw new Error("Admin authorization required");
          const title = String(payload?.title || "").trim();
          const text = String(payload?.message || "").trim();
          const messages = normalizePaidBroadcastMessages(payload);
          if (!title) throw new Error("請輸入推播名稱");
          const allUsers = uniqueUsersById(await listUserRecords(env));
          const recipients = selectBroadcastAudience(allUsers, payload?.audience || {});
          if (!recipients.length) throw new Error("目前受眾為 0，沒有可推播會員");
          const reachableRecipients = recipients.filter(user => String(user.lineUserId || user.linkedLineUid || user.lineUid || user.userId || "").trim().startsWith("U"));
          if (!reachableRecipients.length) throw new Error("目前受眾尚未綁定 LINE UID，無法推播");
          const sendResult = await sendLineMulticast(env, reachableRecipients, messages);
          const campaigns = await safeGetKV(env, "PAID_BROADCASTS", []);
          const campaign = {
            id: crypto.randomUUID ? crypto.randomUUID() : `BCAST_${Date.now()}`,
            title,
            message: text,
            messageTypes: messages.map(message => message.type),
            messageCount: messages.length,
            moduleIds: Array.isArray(payload?.moduleIds) ? payload.moduleIds.map(id => String(id || "").trim()).filter(Boolean) : [],
            audience: payload?.audience || {},
            targetCount: recipients.length,
            reachableCount: reachableRecipients.length,
            sent: sendResult.sent,
            failed: sendResult.failed,
            errors: sendResult.errors,
            operatorUid: userId,
            operatorName: access.userData?.name || "",
            createdAt: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
            createdTs: Date.now(),
          };
          const nextCampaigns = [campaign, ...(Array.isArray(campaigns) ? campaigns : [])].slice(0, 200);
          await safePutKV(env, "PAID_BROADCASTS", nextCampaigns);
          result.data = { success: sendResult.failed === 0, campaign };
          break;
        }

        case "ADMIN_UPDATE_SETTINGS":
          await safePutKV(env, "SYSTEM_SETTINGS", payload);
          if (env.GAS_URL) ctx.waitUntil(fetch(env.GAS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
          touchLastUpdate(env, ctx, "Settings");
          result.data = { success: true };
          break;

        case "ADMIN_UPDATE_COURSE":
          let cList = await safeGetCourses(env);
          const courseToSave = {
            ...payload,
            maxPoints: Math.max(0, Number(payload.maxPoints || 0)),
            stageTags: Array.isArray(payload.stageTags) ? payload.stageTags.filter(Boolean) : [],
          };
          if (String(courseToSave.type || "").includes("預約")) {
            courseToSave.capacity = 0;
            courseToSave.startDate = "";
            courseToSave.endDate = "";
            if (courseToSave.maxPoints > 0) courseToSave.discountRule = "CUSTOM";
          } else {
            courseToSave.maxPoints = 0;
          }
          const idx = cList.findIndex(c => c.id === courseToSave.id);
          if (idx > -1) cList[idx] = courseToSave;
          else cList.unshift(courseToSave);
          const courseSaveStorage = await safePutCourses(env, cList);
          if (env.GAS_URL) ctx.waitUntil(fetch(env.GAS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
          touchLastUpdate(env, ctx, "Courses");
          result.data = { success: true, storage: courseSaveStorage.storage };
          break;

        case "ADMIN_DELETE_COURSE": {
          const courseId = String(payload?.courseId || "").trim();
          if (!courseId) throw new Error("缺少課程 ID");
          const coursesForDelete = await safeGetCourses(env);
          const courseIndex = coursesForDelete.findIndex(c => c && String(c.id) === courseId);
          if (courseIndex < 0) throw new Error("找不到要刪除的課程");
          coursesForDelete[courseIndex] = {
            ...coursesForDelete[courseIndex],
            isPublished: false,
            isDeleted: true,
            deletedAt: new Date().toISOString(),
            deletedBy: userId,
            deleteReason: String(payload?.reason || "後台名義刪除").trim(),
          };
          const courseDeleteStorage = await safePutCourses(env, coursesForDelete);
          touchLastUpdate(env, ctx, "Courses");
          result.data = { success: true, storage: courseDeleteStorage.storage, course: coursesForDelete[courseIndex] };
          break;
        }

        case "ADMIN_UPDATE_PRODUCT":
          const productToSave = normalizeProduct(payload);
          if (!productToSave.name) throw new Error("請輸入商品名稱");
          const productSaveList = await safeGetProducts(env);
          const productSaveIdx = productSaveList.findIndex(p => p && (p.id === productToSave.id || (productToSave.code && p.code === productToSave.code)));
          if (productSaveIdx > -1) productSaveList[productSaveIdx] = { ...productSaveList[productSaveIdx], ...productToSave };
          else productSaveList.unshift({ ...productToSave, createdAt: new Date().toISOString() });
          const productSaveStorage = await safePutProducts(env, productSaveList);
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(e => console.error("[Products] SYS_LAST_UPDATE 寫入失敗", e)));
          result.data = { success: true, product: productToSave, storage: productSaveStorage.storage };
          break;

        case "ADMIN_DELETE_PRODUCT":
          const productDeleteList = await safeGetProducts(env);
          const productDeleteIndex = productDeleteList.findIndex(p => p && p.id === payload.productId);
          if (productDeleteIndex < 0) throw new Error("找不到要刪除的商品");
          productDeleteList[productDeleteIndex] = {
            ...productDeleteList[productDeleteIndex],
            isPublished: false,
            isDeleted: true,
            deletedAt: new Date().toISOString(),
            deletedBy: userId,
            deleteReason: String(payload?.reason || "後台名義刪除").trim(),
          };
          await safePutProducts(env, productDeleteList);
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(e => console.error("[Products] SYS_LAST_UPDATE 寫入失敗", e)));
          result.data = { success: true, product: productDeleteList[productDeleteIndex] };
          break;
          
        case "ADMIN_UPDATE_ORDER":
          let editOrders = await safeGetKV(env, "ORDERS", []);
          const oIdx = editOrders.findIndex(o => o.orderId === payload.orderId);
          if (oIdx > -1) {
              const beforeOrder = editOrders[oIdx];
              const nextOrder = { ...beforeOrder, ...payload };
              const beforeStatus = String(beforeOrder.status || "").toUpperCase();
              const nextStatus = String(nextOrder.status || "").toUpperCase();
              if (String(nextOrder.type || "").toUpperCase() === "PRODUCT" && nextStatus === "SHIPPED") {
                const trackingRequired = String(nextOrder.trackingNumber || nextOrder.shipping?.trackingNumber || "").trim();
                if (!trackingRequired) throw new Error("改為配送中前，請先填寫物流 / 訂單查詢編號");
              }
              const remittanceVerified = beforeStatus !== "PAID" && nextStatus === "PAID" && String(nextOrder.paymentMethod || "").toUpperCase() === "REMITTANCE" && nextOrder.remittance && !nextOrder.remittanceVerifiedAt;
              if (remittanceVerified) {
                nextOrder.remittanceStatus = "VERIFIED";
                nextOrder.remittanceVerifiedAt = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
                nextOrder.remittanceVerifiedAtIso = new Date().toISOString();
                nextOrder.remittanceVerifiedBy = access.userData?.name || userProfile?.displayName || access.lineUserId || userId || "admin";
              }
              const attendanceChangedToAttended = String(beforeOrder.attendance || "") !== "ATTENDED" && String(nextOrder.attendance || "") === "ATTENDED";
              if (attendanceChangedToAttended && !nextOrder.teacherCommissionDeductedAt) {
                Object.assign(nextOrder, await deductTeacherCommissionForOrder(env, ctx, nextOrder, userId, access.userData?.name || userProfile?.displayName || "Admin", this.updatePoints.bind(this)));
              }
              editOrders[oIdx] = nextOrder;
              await putOrdersKV(env, ctx, editOrders);
              if (beforeStatus !== nextStatus) {
                ctx.waitUntil(notifyOrderStatusChangeLine(env, nextOrder, beforeStatus, nextStatus).catch(error => console.error("[LINE] order status notification failed", error)));
              }
          }
          if (env.GAS_URL) ctx.waitUntil(fetch(env.GAS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()));
          result.data = { success: true };
          break;

        case "ADMIN_TRANSFER_ORDER_COURSE": {
          if (!access.isAdmin) throw new Error("Admin authorization required");
          const sourceOrderId = String(payload?.orderId || "").trim();
          const targetCourseId = String(payload?.targetCourseId || "").trim();
          const transferReason = String(payload?.reason || "").trim();
          if (!sourceOrderId) throw new Error("缺少原訂單編號");
          if (!targetCourseId) throw new Error("請選擇要轉入的課程");
          if (!transferReason) throw new Error("請填寫轉課原因");

          let transferOrders = await safeGetKV(env, "ORDERS", []);
          let transferCourses = await safeGetCourses(env);
          const sourceIdx = transferOrders.findIndex(order => order && String(order.orderId) === sourceOrderId);
          if (sourceIdx < 0) throw new Error("找不到原訂單");
          const sourceOrder = transferOrders[sourceIdx];
          if (sourceOrder.type === "PRODUCT") throw new Error("商城商品訂單不能轉課");
          if (sourceOrder.type === "BOOKING") throw new Error("預約諮詢訂單不能用課程轉課流程");
          if (sourceOrder.status === "TRANSFERRED") throw new Error("此訂單已轉課，不能重複轉移");
          if (sourceOrder.status === "CANCELLED") throw new Error("已取消訂單不能轉課");
          if (String(sourceOrder.attendance || "") === "ATTENDED") throw new Error("已出席訂單不可轉課，請另行人工調整");

          const targetCourse = transferCourses.find(course => course && (String(course.id) === targetCourseId || String(course.name) === targetCourseId));
          if (!targetCourse) throw new Error("找不到目標課程");
          if (String(targetCourse.type || "").includes("預約")) throw new Error("預約類服務請使用預約流程，不能從課程訂單轉入");
          if (
            String(sourceOrder.courseId || "") === String(targetCourse.id || "") ||
            String(sourceOrder.courseId || "") === String(targetCourse.name || "")
          ) {
            throw new Error("目標課程不可與原課程相同");
          }

          const transferAt = new Date().toISOString();
          const newOrderId = `TRF${Date.now()}`;
          const transferBy = access.userData?.name || userProfile?.displayName || userId || "Admin";
          const newOrder = {
            ...sourceOrder,
            orderId: newOrderId,
            courseId: targetCourse.id || targetCourse.name,
            courseName: getCourseTitle(targetCourse),
            status: sourceOrder.status,
            createdAt: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }),
            transferredFromOrderId: sourceOrder.orderId,
            transferredToOrderId: undefined,
            transferReason,
            transferAt,
            transferBy,
            originalCourseId: sourceOrder.courseId || "",
            note: [sourceOrder.note, `轉課來源：${sourceOrder.orderId}；原因：${transferReason}`].filter(Boolean).join("\n")
          };

          transferOrders[sourceIdx] = {
            ...sourceOrder,
            status: "TRANSFERRED",
            transferredToOrderId: newOrderId,
            transferReason,
            transferAt,
            transferBy,
            originalCourseId: sourceOrder.courseId || "",
          };
          transferOrders.unshift(newOrder);

          const originalCourseKey = String(sourceOrder.courseId || "");
          transferCourses = transferCourses.map(course => {
            if (!course) return course;
            if (originalCourseKey && (String(course.id) === originalCourseKey || String(course.name) === originalCourseKey)) {
              return { ...course, enrolled: Math.max(0, Number(course.enrolled || 0) - 1) };
            }
            if (String(course.id) === String(targetCourse.id) || String(course.name) === String(targetCourse.name)) {
              return { ...course, enrolled: Number(course.enrolled || 0) + 1 };
            }
            return course;
          });

          await putOrdersKV(env, ctx, transferOrders);
          await safePutCourses(env, transferCourses);
          if (env.GAS_URL) {
            ctx.waitUntil(fetch(env.GAS_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "ADMIN_TRANSFER_ORDER_COURSE", payload: { sourceOrder: transferOrders[sourceIdx], newOrder } }),
              redirect: "follow"
            }).catch(e => console.error("GAS Transfer Sync Error", e)));
          }
          touchLastUpdate(env, ctx, "Courses");
          result.data = { success: true, sourceOrder: transferOrders[sourceIdx], newOrder, orders: transferOrders, courses: transferCourses };
          break;
        }

        case "ADMIN_UPDATE_MEMBER":
          if (payload.memberData && payload.memberData.userId) {
              const memberUid = String(payload.memberData.userId).trim();
              const currentMember = await safeGetKV(env, `USER_${memberUid}`, {});
              const currentIsTeacher = Boolean(currentMember.isTeacher) || currentMember.role === "teacher" || currentMember.crmRole === "teacher";
              const nextIsTeacher = Boolean(payload.memberData.isTeacher) || payload.memberData.role === "teacher" || payload.memberData.crmRole === "teacher";
              const permissionChanged = (
                Boolean(currentMember.isAdmin) !== Boolean(payload.memberData.isAdmin) ||
                Boolean(currentMember.crmSystem) !== Boolean(payload.memberData.crmSystem) ||
                Boolean(currentMember.crmOperator) !== Boolean(payload.memberData.crmOperator) ||
                currentIsTeacher !== nextIsTeacher ||
                String(currentMember.role || "") !== String(payload.memberData.role || "") ||
                String(currentMember.crmRole || "") !== String(payload.memberData.crmRole || "")
              );
              if (permissionChanged && !access.isAdmin) {
                throw new Error("任命或變更 CRM 權限時，必須使用總部管理白名單 Admin LINE UID 登入");
              }
              const currentIsPrivileged = currentIsTeacher || Boolean(currentMember.isAdmin) || Boolean(currentMember.crmSystem) || Boolean(currentMember.crmOperator) || ["admin", "system", "operator", "teacher"].includes(String(currentMember.role || "")) || ["admin", "system", "operator", "teacher"].includes(String(currentMember.crmRole || ""));
              if (!access.isAdmin && currentIsPrivileged) {
                throw new Error("操作員不能修改具權限身分的帳號");
              }
              const savedMember = {
                ...currentMember,
                ...payload.memberData,
                userId: memberUid,
                updatedAt: new Date().toISOString(),
              };
              if (payload.memberData.isDeleted === false) {
                delete savedMember.isDeleted;
                delete savedMember.deletedAt;
                delete savedMember.deletedBy;
                delete savedMember.deleteReason;
              }
              if (savedMember.isAdmin === true) {
                savedMember.crmRole = "admin";
                savedMember.role = "admin";
                savedMember.crmSystem = false;
                savedMember.crmOperator = false;
              } else if (savedMember.crmSystem === true) {
                savedMember.isAdmin = false;
                savedMember.crmOperator = false;
                savedMember.crmRole = "system";
                savedMember.role = "system";
              } else if (savedMember.crmOperator === true) {
                savedMember.isAdmin = false;
                savedMember.crmSystem = false;
                savedMember.crmRole = "operator";
                savedMember.role = "operator";
              } else if (savedMember.role === "admin" || savedMember.crmRole === "admin") {
                savedMember.isAdmin = true;
                savedMember.crmSystem = false;
                savedMember.crmRole = "admin";
                savedMember.role = "admin";
                savedMember.crmOperator = false;
              } else if (savedMember.role === "system" || savedMember.crmRole === "system") {
                savedMember.isAdmin = false;
                savedMember.crmSystem = true;
                savedMember.crmOperator = false;
                savedMember.crmRole = "system";
                savedMember.role = "system";
              } else if (savedMember.role === "operator" || savedMember.crmRole === "operator") {
                savedMember.isAdmin = false;
                savedMember.crmSystem = false;
                savedMember.crmOperator = true;
                savedMember.crmRole = "operator";
                savedMember.role = "operator";
              } else {
                savedMember.isAdmin = false;
                savedMember.crmSystem = false;
                savedMember.crmOperator = false;
                delete savedMember.crmRole;
                if (["system", "operator"].includes(savedMember.role)) delete savedMember.role;
              }
              if (savedMember.isTeacher === true) {
                if (!String(savedMember.memberTier || "").includes("導師")) savedMember.memberTier = "專業導師";
              }
              savedMember.memberTags = normalizeMemberTagList(savedMember.memberTags || savedMember.crmTags || []);
              delete savedMember.crmTags;
              await putUserKV(env, ctx, memberUid, savedMember);
              result.data = { success: true, memberData: savedMember };
          } else {
              throw new Error("Missing memberData.userId");
          }
          if (env.GAS_URL) ctx.waitUntil(fetch(env.GAS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
          touchLastUpdate(env, ctx, "Members");
          break;

        case "ADMIN_DELETE_MEMBER": {
          const targetUid = String(payload?.targetUid || "").trim();
          if (!targetUid) throw new Error("缺少學員 UID");
          const memberToDelete = await safeGetKV(env, `USER_${targetUid}`, null);
          if (!memberToDelete || !memberToDelete.userId) throw new Error("找不到要刪除的學員");
          const deletedMember = {
            ...memberToDelete,
            isDeleted: true,
            deletedAt: new Date().toISOString(),
            deletedBy: userId,
            deleteReason: String(payload?.reason || "後台名義刪除").trim(),
          };
          await putUserKV(env, ctx, targetUid, deletedMember);
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()).catch(e => console.error("[Members] SYS_LAST_UPDATE 寫入失敗", e)));
          result.data = { success: true, deletedUid: targetUid, memberData: deletedMember };
          break;
        }

        case "ADMIN_APPROVE_TEACHER":
          const { teacherUid, rentPrice, commissionRate } = payload;
          let targetUser = await safeGetKV(env, `USER_${teacherUid}`, null);
          if (targetUser) {
              if (!isTeacherRecord(targetUser)) throw new Error("此學員尚未勾選為專業講師，不能啟動導師分表模式");
              targetUser.memberTier = '專業導師';
              targetUser.isTeacher = true;
              targetUser.role = targetUser.role === "admin" ? "admin" : "teacher";
              targetUser.config = { rent: rentPrice, comm: commissionRate };
              await putUserKV(env, ctx, teacherUid, targetUser);
          }
          if (env.GAS_URL) ctx.waitUntil(fetch(env.GAS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()));
          result.data = { success: true };
          break;

        case "ADMIN_REMOVE_TEACHER":
          const removeUid = payload.teacherUid;
          let teacherToRemove = await safeGetKV(env, `USER_${removeUid}`, null);
          if (!teacherToRemove) throw new Error("Teacher not found");
          delete teacherToRemove.config;
          teacherToRemove.isTeacher = false;
          if (teacherToRemove.role === "teacher") teacherToRemove.role = "member";
          teacherToRemove.memberTier = payload.memberTier || "一般會員";
          await putUserKV(env, ctx, removeUid, teacherToRemove);
          if (env.GAS_URL) ctx.waitUntil(fetch(env.GAS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ADMIN_UPDATE_MEMBER", payload: { memberData: teacherToRemove } }) }));
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()));
          result.data = { success: true };
          break;

        case "ADMIN_GET_SLOTS":
          const slotData = await safeGetKV(env, "SLOTS", []);
          result.data = access.isAdmin ? slotData : slotData.filter(slot => slot && slot.teacherUid === userId);
          break;

        case "ADMIN_BATCH_TOGGLE_SLOTS":
          let currentSlots = await safeGetKV(env, "SLOTS", []);
          const { teacherUid: tUid, draftOpen, draftClose } = payload;
          if (!access.isAdmin) {
              if (tUid !== userId) throw new Error("Teacher scope mismatch");
              if ((draftOpen || []).some(slot => slot.uid !== userId) || (draftClose || []).some(slot => slot.uid !== userId)) {
                  throw new Error("Teacher scope mismatch");
              }
          }
          const openSlotsToCreate = Array.isArray(draftOpen) ? draftOpen : [];
          const closeSlotsToRemove = Array.isArray(draftClose) ? draftClose : [];
          const teacherForSlotCost = await safeGetKV(env, `USER_${tUid}`, null);
          const slotRent = Math.max(0, Number(teacherForSlotCost?.config?.rent || 0));
          const slotOpenCost = openSlotsToCreate.length * slotRent;
          if (slotOpenCost > 0) {
            const teacherPointData = await safeGetKV(env, `POINTS_${tUid}`, { balance: 0, logs: [] });
            if ((Number(teacherPointData.balance) || 0) < slotOpenCost) throw new Error(`講師點數不足，開通 ${openSlotsToCreate.length} 個時段需要 ${slotOpenCost} 點`);
            await this.updatePoints(env, ctx, tUid, -slotOpenCost, `開通預約時段：${payload.courseName || payload.courseId || "預約服務"} x ${openSlotsToCreate.length}`, {
              source: "slot_open",
              operatorUid: userId,
              operatorName: access.userData?.name || userProfile?.displayName || "",
              targetName: teacherForSlotCost?.name || "",
            });
          }
          closeSlotsToRemove.forEach(c => {
              currentSlots = currentSlots.filter(s => !(s.teacherUid === c.uid && s.date === c.date && s.time === c.time));
          });
          openSlotsToCreate.forEach(o => {
              currentSlots = currentSlots.filter(s => !(s.teacherUid === o.uid && s.date === o.date && s.time === o.time));
              currentSlots.push({
                teacherUid: o.uid,
                date: o.date,
                time: o.time,
                status: 'OPEN',
                courseId: o.courseId || payload.courseId || "",
                courseName: o.courseName || payload.courseName || "",
                coursePrice: Number(o.coursePrice || payload.coursePrice || 0),
                openCost: slotRent,
                openedAt: new Date().toISOString(),
              });
          });
          await env.ACTION_DATA.put("SLOTS", JSON.stringify(currentSlots));
          if (env.GAS_URL) ctx.waitUntil(fetch(env.GAS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
          ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()));
          result.data = { success: true };
          break;
          
        case "ADMIN_MANAGE_POINTS":
          const val = payload.type === 'MANUAL_DEDUCT' ? -Math.abs(payload.amount) : Math.abs(payload.amount);
          await this.updatePoints(env, ctx, payload.uid, val, payload.reason || "管理員手動調整");
          result.data = { success: true };
          break;

        case "ADMIN_RECONCILE_LOCAL_POINTS": {
          if (!access.isAdmin) throw new Error("Admin authorization required");
          const targetUid = String(payload?.targetUid || payload?.uid || "").trim();
          const targetBalance = Number(payload?.targetBalance);
          if (!targetUid) throw new Error("缺少會員 UID");
          if (!Number.isFinite(targetBalance) || targetBalance < 0) throw new Error("校正餘額格式錯誤");
          const currentPointData = await safeGetKV(env, `POINTS_${targetUid}`, { balance: 0, logs: [] });
          const currentBalance = Number(currentPointData.balance || 0);
          const delta = targetBalance - currentBalance;
          if (delta !== 0) {
            const logId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString();
            const createdTs = Date.now();
            const createdAt = new Date(createdTs).toLocaleString();
            const reason = payload?.reason || "校正手機母站顯示餘額";
            const nextPointData = {
              ...currentPointData,
              balance: targetBalance,
              logs: [
                {
                  logId,
                  amount: Math.abs(delta),
                  reason,
                  createdAt,
                  type: delta >= 0 ? "EARN" : "SPEND",
                  source: "local_reconcile",
                },
                ...(Array.isArray(currentPointData.logs) ? currentPointData.logs : []),
              ].slice(0, 50),
              reconciledAt: new Date().toISOString(),
              reconciledBy: userId,
            };
            await putPointKV(env, ctx, targetUid, nextPointData);
            await appendPointsLedger(env, {
              logId,
              uid: targetUid,
              type: delta >= 0 ? "EARN" : "SPEND",
              amount: delta,
              points: Math.abs(delta),
              reason,
              balanceAfter: targetBalance,
              createdAt,
              createdTs,
              source: "local_reconcile",
              operatorUid: userId,
              operatorName: access.userData?.name || access.lineProfile?.name || "",
            });
            if (ctx) observeHighRiskDualWrite(env, ctx, ["points", "point-ledger"]);
            else await observeHighRiskDualWrite(env, null, ["points", "point-ledger"]);
          }
          result.data = { success: true, uid: targetUid, oldBalance: currentBalance, balance: targetBalance, delta };
          break;
        }

        case "SYSTEM_HEALTH_CHECK":
          if (!access.isAdmin) throw new Error("Admin authorization required");
          const healthCfg = getWetwConfig(access.settings, env);
          const healthLogNew = [
            "Cloudflare Worker：正常",
            `KV ACTION_DATA：${env.ACTION_DATA ? "正常" : "未綁定"}`,
            `WordPress 同步開關：${healthCfg.enabled ? "啟用" : "停用"}`,
            `WordPress API Key：${healthCfg.apiKey ? "已設定" : "未設定"}`,
            `WordPress shop_id：${healthCfg.shopId || "未設定"}`,
            `WordPress point_type：${healthCfg.pointType}`,
            `WordPress 查詢 API：${getWetwPointUrl(access.settings, "query", env)}`,
            `WordPress 新增 API：${getWetwPointUrl(access.settings, "insert", env)}`,
          ];
          if (healthCfg.enabled && healthCfg.apiKey && healthCfg.shopId) {
            try {
              const testRes = await fetch(getWetwPointUrl(access.settings, "query", env), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ api_key: healthCfg.apiKey, shop_id: healthCfg.shopId, page: 1, per_page: 1 }),
              });
              const testText = await testRes.text();
              healthLogNew.push(`WordPress 查詢 API 連線：HTTP ${testRes.status}`);
              healthLogNew.push(`WordPress 查詢 API 回應：${testText.slice(0, 120)}`);
            } catch (e) {
              healthLogNew.push(`WordPress 查詢 API 連線失敗：${e.message}`);
            }
          }
          result.data = { success: true, log: healthLogNew };
          break;

        case "ADMIN_SYNC_WP_POINTS":
          const syncUidNew = String(payload.targetUid || "").trim();
          if (!syncUidNew) throw new Error("缺少會員 UID，無法補登舊點數");
          const syncMemberNew = await safeGetKV(env, `USER_${syncUidNew}`, null);
          if (!syncMemberNew) throw new Error("找不到會員資料，無法補登舊點數");
          const alreadySynced = await safeGetKV(env, `WP_SYNCED_${syncUidNew}`, null);
          if (alreadySynced?.importedAt) {
            result.data = { success: false, reason: "already_synced", imported: 0, message: `此會員已於 ${alreadySynced.importedAt} 補登過 ${alreadySynced.imported || 0} 點。` };
            break;
          }
          const currentPointsNew = await safeGetKV(env, `POINTS_${syncUidNew}`, { balance: 0, logs: [] });
          const currentBalanceNew = Number(currentPointsNew.balance) || 0;
          const legacyPointsNew = await queryWetwPointList(access.settings, syncMemberNew, env);
          if (!legacyPointsNew.ok) {
            result.data = { success: false, reason: legacyPointsNew.reason, imported: 0, balance: currentBalanceNew, message: legacyPointsNew.message || "外站點數查詢失敗" };
            break;
          }
          if (legacyPointsNew.balance <= 0) {
            result.data = { success: false, reason: "no_legacy_points", imported: 0, balance: currentBalanceNew, message: "外站查無可補登點數。" };
            break;
          }
          await this.updatePoints(env, ctx, syncUidNew, legacyPointsNew.balance, "舊系統點數補登", { skipWpSync: true });
          const importedAt = new Date().toISOString();
          await env.ACTION_DATA.put(`WP_SYNCED_${syncUidNew}`, JSON.stringify({ imported: legacyPointsNew.balance, importedAt, source: "wetw-point/query-user-point-list" }));
          result.data = { success: true, imported: legacyPointsNew.balance, balance: currentBalanceNew + legacyPointsNew.balance, importedAt };
          break;

        case "__LEGACY_SYSTEM_HEALTH_CHECK_DISABLED":
          const wpUrl = getWpApiUrl(access.settings);
          const healthLog = [
            "Cloudflare Worker：正常",
            `KV ACTION_DATA：${env.ACTION_DATA ? "正常" : "未綁定"}`,
            `WordPress 同步開關：${String(access.settings?.wp_sync_enabled || "").toLowerCase() === "true" ? "啟用" : "停用"}`,
            `WordPress API Key：${access.settings?.wp_api_key ? "已設定" : "未設定"}`,
            `WordPress shop_id：${access.settings?.wp_shop_id || "未設定"}`,
            `WordPress API URL：${wpUrl || "未設定"}`,
          ];
          if (wpUrl) {
            try {
              const healthRes = await fetch(wpUrl, { method: "GET" });
              healthLog.push(`WordPress API 連線：HTTP ${healthRes.status}`);
            } catch (e) {
              healthLog.push(`WordPress API 連線失敗：${e.message}`);
            }
          } else {
            healthLog.push("WordPress API 狀態：缺少 API URL，補登舊點數尚未可用");
          }
          result.data = { success: true, log: healthLog };
          break;

        case "__LEGACY_ADMIN_SYNC_WP_POINTS_DISABLED":
          const syncUid = String(payload.targetUid || "").trim();
          if (!syncUid) throw new Error("缺少會員 UID，無法補登舊點數");
          const syncMember = await safeGetKV(env, `USER_${syncUid}`, null);
          if (!syncMember) throw new Error("找不到會員資料，無法補登舊點數");
          const currentPoints = await safeGetKV(env, `POINTS_${syncUid}`, { balance: 0, logs: [] });
          const currentBalance = Number(currentPoints.balance) || 0;
          const wpEnabled = String(access.settings?.wp_sync_enabled || "").toLowerCase() === "true";
          const wpConfigured = !!(access.settings?.wp_api_key && access.settings?.wp_shop_id && getWpApiUrl(access.settings));
          if (currentBalance > 0) {
              result.data = {
                success: false,
                reason: "already_has_points",
                imported: 0,
                balance: currentBalance,
                message: `此會員目前已有 ${currentBalance} 點，不需要補登。`
              };
              break;
          }
          if (!wpEnabled || !wpConfigured) {
              result.data = {
                success: false,
                reason: "wp_not_configured",
                imported: 0,
                balance: currentBalance,
                message: "舊 WordPress 點數補登尚未完成後端 API 設定，目前沒有可執行的舊系統查詢。"
              };
              break;
          }
          result.data = {
            success: false,
            reason: "wp_api_missing",
            imported: 0,
            balance: currentBalance,
            message: "舊系統補登 API 尚未部署到後端，因此不是會員沒有點數，而是補登功能尚未接上。"
          };
          break;

        case "ADMIN_GET_RICH_MENU_SAVES": {
          const saves = await safeGetKV(env, "RICH_MENU_SAVES", []);
          result.data = Array.isArray(saves) ? saves : [];
          break;
        }

        case "ADMIN_SAVE_RICH_MENU": {
          const saves = await safeGetKV(env, "RICH_MENU_SAVES", []);
          const list = Array.isArray(saves) ? saves : [];
          const now = new Date();
          const id = String(payload?.id || Date.now()).trim();
          const entry = {
            id,
            name: String(payload?.name || "New Rich Menu").trim() || "New Rich Menu",
            date: now.toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
            updatedAt: now.toISOString(),
            updatedBy: userId,
            updatedByName: access.userData?.name || access.lineProfile?.name || "",
            data: payload?.data || {},
            image: payload?.image || "",
          };
          const idx = list.findIndex(item => item && String(item.id) === id);
          if (idx > -1) list[idx] = { ...list[idx], ...entry };
          else list.unshift(entry);
          const next = list.slice(0, 30);
          const storage = await safePutKV(env, "RICH_MENU_SAVES", next);
          result.data = { success: true, item: entry, saves: next, storage };
          break;
        }

        case "ADMIN_DELETE_RICH_MENU_SAVE": {
          const id = String(payload?.id || "").trim();
          if (!id) throw new Error("缺少圖文選單 ID");
          const saves = await safeGetKV(env, "RICH_MENU_SAVES", []);
          const next = (Array.isArray(saves) ? saves : []).filter(item => item && String(item.id) !== id);
          const storage = await safePutKV(env, "RICH_MENU_SAVES", next);
          result.data = { success: true, saves: next, storage };
          break;
        }

        case "UPLOAD_IMAGE":
          if (!env['act-image']) throw new Error("尚未綁定名為 'act-image' 的 R2 Bucket。");
          const base64 = payload.imageBase64;
          const contentTypeMatch = base64.match(/data:(image\/[^;]+);/);
          const contentType = contentTypeMatch ? contentTypeMatch[1] : 'image/webp';
          const ext = contentType.split('/')[1] || 'webp';
          const fileName = `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
          const b64Data = base64.split(',')[1];
          const bytes = Uint8Array.from(atob(b64Data), c => c.charCodeAt(0));
          await env['act-image'].put(fileName, bytes, { httpMetadata: { contentType } });
          result.data = { url: `https://${new URL(request.url).host}/img/${fileName}` };
          break;

        case "DEPLOY_RICH_MENU":
          const lineToken = getLineChannelAccessToken(env);
          if (!lineToken) throw new Error("Cloudflare 尚未綁定 LINE_CHANNEL_ACCESS_TOKEN 金鑰！");
          const richMenuConfig = payload.richMenuConfig || payload.menuObject || {
            size: payload.size,
            selected: true,
            name: payload.name,
            chatBarText: payload.chatBarText,
            areas: payload.areas,
          };
          if (!richMenuConfig?.size || !Array.isArray(richMenuConfig?.areas)) {
            throw new Error("圖文選單 JSON 格式有誤：缺少 size 或 areas。");
          }
          normalizeRichMenuSwitchActions(richMenuConfig);
          
          const createRes = await fetch("https://api.line.me/v2/bot/richmenu", {
              method: "POST",
              headers: { "Authorization": `Bearer ${lineToken}`, "Content-Type": "application/json" },
              body: JSON.stringify(richMenuConfig)
          });
          if (!createRes.ok) throw new Error("建立 LINE 選單失敗: " + await createRes.text());
          const richMenuId = (await createRes.json()).richMenuId;

          const richMenuImage = payload.imageBase64 || payload.image;
          if (richMenuImage) {
              const imageMatch = String(richMenuImage).match(/^data:(image\/(?:jpeg|jpg|png));base64,(.+)$/i);
              if (!imageMatch) throw new Error("圖文選單圖片格式有誤：請使用 JPG 或 PNG 圖片。");
              const lineImageContentType = imageMatch[1].toLowerCase() === "image/jpg" ? "image/jpeg" : imageMatch[1].toLowerCase();
              const base64DataImg = imageMatch[2];
              const binaryStr = atob(base64DataImg);
              const bytesImg = new Uint8Array(binaryStr.length);
              for (let i = 0; i < binaryStr.length; i++) bytesImg[i] = binaryStr.charCodeAt(i);
              
              const imgRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
                  method: "POST",
                  headers: { "Authorization": `Bearer ${lineToken}`, "Content-Type": lineImageContentType },
                  body: bytesImg
              });
              if (!imgRes.ok) throw new Error("上傳圖片至 LINE 失敗: " + await imgRes.text());
          }

          const defaultRes = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${lineToken}` }
          });
          if (!defaultRes.ok) throw new Error("設定 LINE 預設選單失敗: " + await defaultRes.text());

          const deployedAliasId = await upsertRichMenuAlias(lineToken, payload.aliasId || richMenuConfig.aliasId || richMenuConfig.name, richMenuId);

          result.data = { success: true, richMenuId, richMenuAliasId: deployedAliasId };
          break;

        case "GET_PAYMENT_PAYLOAD":
          const paymentOrderId = String(payload?.orderId || "").trim();
          if (!paymentOrderId) throw new Error("缺少訂單編號");
          const paymentOrders = await safeGetKV(env, "ORDERS", []);
          const paymentOrder = paymentOrders.find(o => o && o.orderId === paymentOrderId && o.userId === userId);
          if (!paymentOrder) throw new Error("找不到可付款的訂單");
          if (String(paymentOrder.status || "").toUpperCase() !== "PENDING") throw new Error("此訂單目前不可付款");
          const paymentAmount = Math.max(0, Number(paymentOrder.amount || 0));
          if (paymentAmount <= 0) throw new Error("此訂單不需要線上付款");
          result.data = await this.preparePayment({
            ...payload,
            orderId: paymentOrder.orderId,
            amount: paymentAmount,
            paymentMethod: payload?.paymentMethod || paymentOrder.paymentMethod || "NEWEBPAY",
            courseName: paymentOrder.type === "PRODUCT" ? (paymentOrder.productName || "商城商品") : (payload.courseName || paymentOrder.courseId || "HookTea課程"),
          }, env);
          break;

        default:
          if (!env.GAS_URL) {
              result = { status: "success", data: [] };
              break;
          }
          const proxyRes = await fetch(env.GAS_URL, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            redirect: "follow"
          });
          return new Response(await proxyRes.text(), { headers: corsHeaders });
      }

      if (shouldAuditAction(action, access)) {
        ctx.waitUntil(appendAuditLog(env, access, action, payload, request));
      }

      return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ status: "error", message: e.message }), { headers: corsHeaders });
    }
  },

  async sendTgMessage(env, text) {
    return sendTelegramNotification(env, text);
  },

  async prepareLinePayPayment(payload, env) {
    const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
    const cfg = getLinePayConfig(env, settings);
    const amount = Math.max(0, Math.floor(Number(payload.amount || 0)));
    if (amount <= 0) throw new Error("LINE Pay 付款金額必須大於 0");
    const orderId = String(payload.orderId || `HT${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
    const workerUrl = String(payload.workerUrl || "").replace(/\/+$/, "");
    if (!workerUrl) throw new Error("缺少 LINE Pay 回呼網址");
    const originalReturnUrl = String(payload.returnUrl || "");
    const confirmUrl = `${workerUrl}/linepay/confirm?orderId=${encodeURIComponent(orderId)}${originalReturnUrl ? `&redirect=${encodeURIComponent(originalReturnUrl)}` : ""}`;
    const cancelUrl = `${workerUrl}/linepay/cancel?orderId=${encodeURIComponent(orderId)}${originalReturnUrl ? `&redirect=${encodeURIComponent(originalReturnUrl)}` : ""}`;
    const productName = String(payload.courseName || "HookTea 訂單").slice(0, 400);
    const body = {
      amount,
      currency: cfg.currency,
      orderId,
      packages: [{
        id: "hooktea",
        amount,
        products: [{
          id: orderId,
          name: productName,
          quantity: 1,
          price: amount,
        }],
      }],
      redirectUrls: {
        confirmUrl,
        cancelUrl,
      },
    };
    const data = await callLinePayApi(env, settings, "POST", "/v3/payments/request", body);
    const transactionId = String(data?.info?.transactionId || "");
    await updateLinePayOrder(env, null, orderId, transactionId, {
      paymentMethod: "LINEPAY",
      paymentStatus: "LINEPAY_REQUESTED",
      linePayRequestedAt: new Date().toISOString(),
    });
    return {
      provider: "LINEPAY",
      orderId,
      transactionId,
      paymentUrl: data?.info?.paymentUrl || {},
      redirectUrl: data?.info?.paymentUrl?.web || data?.info?.paymentUrl?.app || "",
      mode: cfg.mode,
    };
  },

  async preparePayment(payload, env) {
    if (String(payload.paymentMethod || "").toUpperCase() === "LINEPAY") {
      return this.prepareLinePayPayment(payload, env);
    }
    const sets = await safeGetKV(env, "SYSTEM_SETTINGS", {});
    const mId = sets.newebpay_merchant_id;
    const hKey = sets.newebpay_hash_key;
    const hIv = sets.newebpay_hash_iv;

    if (!mId || !hKey || !hIv) throw new Error("藍新金流設定未完成 (請先至後台填寫)");

    const workerUrl = String(payload.workerUrl || "").replace(/\/$/, "");
    const originalReturnUrl = String(payload.returnUrl || "");
    const notifyUrl = payload.notifyUrl || (workerUrl ? `${workerUrl}?action=NEWEBPAY_NOTIFY` : "");
    const returnNotifyUrl = workerUrl
      ? `${workerUrl}?action=NEWEBPAY_NOTIFY${originalReturnUrl ? `&redirect=${encodeURIComponent(originalReturnUrl)}` : ""}`
      : originalReturnUrl;
    const merchantOrderNo = String(payload.orderId || `ACT${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30);
    const tradeInfo = {
      MerchantID: mId, RespondType: 'JSON', TimeStamp: Math.floor(Date.now() / 1000).toString(),
      Version: '2.0', MerchantOrderNo: merchantOrderNo, Amt: payload.amount,
      ItemDesc: String(payload.courseName || "人生進化課程").substring(0, 45),
      ReturnURL: returnNotifyUrl, NotifyURL: notifyUrl, ClientBackURL: originalReturnUrl, Email: payload.email || "", LoginType: 0
    };
    const tradeInfoStr = Object.keys(tradeInfo).map(k => `${k}=${encodeURIComponent(tradeInfo[k])}`).join('&');
    const encrypted = await aesEncrypt(tradeInfoStr, hKey, hIv);
    const sha = await sha256(`HashKey=${hKey}&${encrypted}&HashIV=${hIv}`);
    
    return {
      GatewayUrl: mId.includes('TEST') || mId.includes('DUMMY') ? "https://ccore.newebpay.com/MPG/mpg_gateway" : "https://core.newebpay.com/MPG/mpg_gateway",
      MerchantID: mId, TradeInfo: encrypted, TradeSha: sha, Version: '2.0'
    };
  },

  async updatePoints(env, ctx, uid, amount, reason, options = {}) {
    const key = `POINTS_${uid}`;
    let data = await safeGetKV(env, key, { balance: 0, logs: [] });
    const numericAmount = Number(amount || 0);
    data.balance = Number(data.balance || 0) + numericAmount;
    const typeStr = numericAmount >= 0 ? "EARN" : "SPEND";
    const createdTs = Date.now();
    const createdAt = new Date(createdTs).toLocaleString();
    const logId = crypto.randomUUID ? crypto.randomUUID() : createdTs.toString();
    data.logs.unshift({ logId, amount: Math.abs(numericAmount), reason, createdAt, type: typeStr });
    data.logs = data.logs.slice(0, 50);
    await putPointKV(env, ctx, uid, data);
    try {
      await appendPointsLedger(env, {
        logId,
        uid,
        type: typeStr,
        amount: numericAmount,
        points: Math.abs(numericAmount),
        reason,
        balanceAfter: data.balance,
        createdAt,
        createdTs,
        source: options.source || "system",
        operatorUid: options.operatorUid || "",
        operatorName: options.operatorName || "",
        targetName: options.targetName || "",
      });
    } catch (e) {
      console.error("[PointsLedger] Failed to append ledger", e);
    }
    if (ctx) observeHighRiskDualWrite(env, ctx, ["points", "point-ledger"]);
    else await observeHighRiskDualWrite(env, null, ["points", "point-ledger"]);

    if (env.GAS_URL && ctx) {
        ctx.waitUntil(fetch(env.GAS_URL, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "MANAGE_POINTS", payload: { uid, amount: Math.abs(numericAmount), type: typeStr, reason, operator: "System" } }),
            redirect: "follow"
        }).catch(e => console.error("GAS Points Sync Error", e)));
    }

    if (!options.skipWpSync && ctx) {
      ctx.waitUntil((async () => {
        const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
        const memberForWp = await safeGetKV(env, `USER_${uid}`, null).catch(() => null);
        const wpRes = await insertWetwPoint(settings, uid, numericAmount, reason, env, memberForWp);
        if (!wpRes.ok && !wpRes.skipped) console.error("WordPress Points Sync Error", wpRes);
      })());
    }
    
    if (ctx) ctx.waitUntil(env.ACTION_DATA.put("SYS_LAST_UPDATE", Date.now().toString()));
  },

  async handleLineWebhook(request, env, ctx) {
    if (request.method !== "POST") {
      await safePutKV(env, "LINE_WEBHOOK_PING_LAST", {
        receivedAt: new Date().toISOString(),
        method: request.method,
        url: request.url,
      }, { expirationTtl: 86400 }).catch(() => {});
      return new Response("HookTea LINE webhook endpoint", { status: 200 });
    }
    const rawText = await request.text();
    const signature = request.headers.get("x-line-signature") || "";
    try {
      let parsedPayload = {};
      if (rawText) parsedPayload = JSON.parse(rawText);
      const events = Array.isArray(parsedPayload?.events) ? parsedPayload.events : [];
      if (!events.length) {
        await safePutKV(env, "LINE_WEBHOOK_PING_LAST", {
          receivedAt: new Date().toISOString(),
          method: request.method,
          signaturePresent: !!signature,
          tokenConfigured: !!getLineChannelAccessToken(env),
        }, { expirationTtl: 86400 }).catch(() => {});
        return new Response("OK", { status: 200 });
      }
      const signatureCheck = await verifyLineWebhookSignature(env, rawText, signature).catch(error => ({
        configured: !!getLineChannelSecret(env),
        valid: false,
        reason: error?.message || String(error),
      }));
      if (signatureCheck.configured && !signatureCheck.valid) {
        await safePutKV(env, "LINE_WEBHOOK_REJECT_LAST", {
          receivedAt: new Date().toISOString(),
          eventCount: events.length,
          reason: signatureCheck.reason || "invalid_signature",
          texts: events.map(event => String(event?.message?.text || "").slice(0, 80)).filter(Boolean).slice(0, 10),
        }, { expirationTtl: 86400 }).catch(() => {});
        return new Response("INVALID_SIGNATURE", { status: 403 });
      }
      const unhandledEvents = [];
      await safePutKV(env, "LINE_WEBHOOK_LAST", {
        receivedAt: new Date().toISOString(),
        eventCount: events.length,
        tokenConfigured: !!getLineChannelAccessToken(env),
        signatureVerified: signatureCheck.configured ? signatureCheck.valid : null,
        texts: events.map(event => ({
          type: event?.type || "",
          userId: event?.source?.userId || "",
          messageType: event?.message?.type || "",
          text: event?.message?.type === "text" ? String(event.message.text || "").slice(0, 80) : "",
        })).slice(0, 10),
      }, { expirationTtl: 86400 });

      const motherKeywordEvents = events.filter(event => event?.type === "message" && event?.message?.type === "text" && isMotherSiteKeyword(event.message.text));
      if (motherKeywordEvents.length) {
        const sets = await safeGetKV(env, "SYSTEM_SETTINGS", {});
        const forwardWebhook = env.FORWARD_WEBHOOK_URL || env.SECOND_WEBHOOK_URL || sets.second_webhook_url || "https://aiwe.cc/index.php/line_login/9890/";
        const allEventsAreMotherKeywords = motherKeywordEvents.length === events.length;
        const preflightTask = Promise.all(motherKeywordEvents.map(async event => {
          const lineUid = String(event?.source?.userId || "").trim();
          const keyword = String(event?.message?.text || "").trim();
          if (!lineUid) return;
          await ensureLineOnlyCrmMember(env, ctx, lineUid, null, `mother_keyword_forward_only_${motherSiteKeywordType(keyword)}`).catch(() => {});
          await appendLineMonitorEvent(env, ctx, event).catch(e => console.error("LINE Monitor Append Error:", e));
          await safePutKV(env, `MOTHER_KEYWORD_RECEIVED_${lineUid}`, {
            lineUserId: lineUid,
            keyword,
            keywordType: motherSiteKeywordType(keyword),
            route: "forward_only",
            receivedAt: new Date().toISOString(),
          }, { expirationTtl: 86400 * 7 }).catch(() => {});
        }));
        if (ctx) ctx.waitUntil(preflightTask);
        else preflightTask.catch(() => {});

        await safePutKV(env, "WEBHOOK_FORWARD_DECISION_LAST", {
          receivedAt: new Date().toISOString(),
          route: "mother_keyword_forward_only",
          totalEvents: events.length,
          forwardedCount: motherKeywordEvents.length,
          localHandledCount: 0,
          texts: motherKeywordEvents.map(event => String(event?.message?.text || "").slice(0, 80)).filter(Boolean),
          keywordTypes: motherKeywordEvents.map(event => motherSiteKeywordType(event?.message?.text || "")),
        }, { expirationTtl: 86400 }).catch(() => {});

        const forwardPayload = allEventsAreMotherKeywords ? parsedPayload : { ...parsedPayload, events: motherKeywordEvents };
        const forwardBody = allEventsAreMotherKeywords ? rawText : JSON.stringify(forwardPayload);
        const forwardHeaders = {
          "Content-Type": "application/json",
          "x-hooktea-forwarded-by": "hooktea-mother-keyword-forward-only",
        };
        if (allEventsAreMotherKeywords && signature) forwardHeaders["x-line-signature"] = signature;
        const forwardTask = (async () => {
          await safePutKV(env, "WEBHOOK_FORWARD_ATTEMPT_LAST", {
            url: forwardWebhook,
            route: "mother_keyword_forward_only",
            eventCount: motherKeywordEvents.length,
            allEventsAreMotherKeywords,
            texts: motherKeywordEvents.map(event => String(event?.message?.text || "").slice(0, 80)).filter(Boolean),
            attemptedAt: new Date().toISOString(),
          }, { expirationTtl: 86400 }).catch(() => {});
          const response = await fetch(forwardWebhook, {
            method: "POST",
            headers: forwardHeaders,
            body: forwardBody,
            redirect: "follow",
            signal: AbortSignal.timeout(8000)
          });
          const responseText = await response.text().catch(error => `response_text_error:${error?.message || String(error)}`);
          await safePutKV(env, "WEBHOOK_FORWARD_LAST", {
            url: forwardWebhook,
            route: "mother_keyword_forward_only",
            status: response.status,
            ok: response.ok,
            fallback: false,
            eventCount: motherKeywordEvents.length,
            texts: motherKeywordEvents.map(event => String(event?.message?.text || "").slice(0, 80)).filter(Boolean),
            response: responseText.slice(0, 300),
            forwardedAt: new Date().toISOString(),
          }, { expirationTtl: 86400 }).catch(() => {});
        })().catch(async error => {
          await safePutKV(env, "WEBHOOK_FORWARD_LAST", {
            url: forwardWebhook,
            route: "mother_keyword_forward_only",
            ok: false,
            error: error?.message || String(error),
            fallback: false,
            eventCount: motherKeywordEvents.length,
            forwardedAt: new Date().toISOString(),
          }, { expirationTtl: 86400 }).catch(() => {});
        });
        await forwardTask;
        return new Response("OK", { status: 200 });
      }
      for (const event of events) {
        let handled = false;
        if (event?.type === "message" && event?.message?.type === "text") {
          const text = String(event?.message?.text || "").trim();
          const uid = String(event?.source?.userId || "").trim();
          if (isReferralInviteKeyword(text)) {
            const inviteUrl = buildReferralInviteUrl("2007674851-lQljb6Cm", uid, uid);
            const shareUrl = buildReferralShareUrl("2007674851-lQljb6Cm", uid, uid);
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=18&data=${encodeURIComponent(inviteUrl)}`;
            const replyToken = event?.replyToken || "";
            await safePutKV(env, `REFERRAL_WEBHOOK_DIRECT_${uid}`, { text, inviteUrl, qrUrl, receivedAt: new Date().toISOString() }, { expirationTtl: 86400 }).catch(() => {});
            const reply = await replyLineMessage(env, replyToken, [
              referralShareFlexMessage({ inviteUrl, shareUrl, qrUrl })
            ]).catch(e => ({ ok: false, error: e.message || String(e) }));
            await safePutKV(env, `REFERRAL_INVITE_LAST_${uid}`, { lineUid: uid, memberUid: uid, inviteUrl, shareUrl, qrUrl, reply, updatedAt: new Date().toISOString() }, { expirationTtl: 86400 * 7 }).catch(() => {});
            handled = true;
          }
        }
        await appendLineMonitorEvent(env, ctx, event).catch(e => {
          console.error("LINE Monitor Append Error:", e);
        });
        if (!handled && event?.type === "message" && event?.message?.type === "text") {
          handled = await handleLineMemberBindText(env, ctx, event).catch(e => {
            console.error("LINE Bind Error:", e);
            return false;
          });
        }
        if (!handled) unhandledEvents.push(event);
      }

      const forwardPayload = { ...parsedPayload, events: unhandledEvents };
      await safePutKV(env, "WEBHOOK_FORWARD_DECISION_LAST", {
        receivedAt: new Date().toISOString(),
        totalEvents: events.length,
        unhandledCount: unhandledEvents.length,
        texts: unhandledEvents.map(event => String(event?.message?.text || "").slice(0, 80)).filter(Boolean),
      }, { expirationTtl: 86400 }).catch(() => {});
      ctx.waitUntil((async () => {
        const promises = [];

        if (env.GAS_URL) {
          promises.push(
            fetch(env.GAS_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "LINE_WEBHOOK", payload: forwardPayload }),
              redirect: "follow"
            }).catch(e => console.error("GAS Webhook Error:", e))
          );
        }

        const sets = await safeGetKV(env, "SYSTEM_SETTINGS", {});
        const forwardWebhook = env.FORWARD_WEBHOOK_URL || env.SECOND_WEBHOOK_URL || sets.second_webhook_url || "https://aiwe.cc/index.php/line_login/9890/";
        
        if (forwardWebhook && unhandledEvents.length) {
          await safePutKV(env, "WEBHOOK_FORWARD_ATTEMPT_LAST", {
            url: forwardWebhook,
            eventCount: unhandledEvents.length,
            texts: unhandledEvents.map(event => String(event?.message?.text || "").slice(0, 80)).filter(Boolean),
            attemptedAt: new Date().toISOString(),
          }, { expirationTtl: 86400 }).catch(() => {});
          promises.push(
            fetch(forwardWebhook, {
              method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-line-signature": signature
            },
              body: rawText,
              redirect: "follow",
              signal: AbortSignal.timeout(8000)
            }).then(async response => {
              await safePutKV(env, "WEBHOOK_FORWARD_LAST", {
                url: forwardWebhook,
                status: response.status,
                ok: response.ok,
                eventCount: unhandledEvents.length,
                texts: unhandledEvents.map(event => String(event?.message?.text || "").slice(0, 80)).filter(Boolean),
                forwardedAt: new Date().toISOString(),
              }, { expirationTtl: 86400 }).catch(() => {});
              const responseText = await response.text().catch(() => "");
              await safePutKV(env, "WEBHOOK_FORWARD_LAST", {
                url: forwardWebhook,
                status: response.status,
                ok: response.ok,
                eventCount: unhandledEvents.length,
                texts: unhandledEvents.map(event => String(event?.message?.text || "").slice(0, 80)).filter(Boolean),
                response: responseText.slice(0, 300),
                forwardedAt: new Date().toISOString(),
              }, { expirationTtl: 86400 }).catch(() => {});
            }).catch(async e => {
              console.error("Forward Webhook Error:", e);
              await safePutKV(env, "WEBHOOK_FORWARD_LAST", {
                url: forwardWebhook,
                ok: false,
                error: e.message || String(e),
                eventCount: unhandledEvents.length,
                forwardedAt: new Date().toISOString(),
              }, { expirationTtl: 86400 }).catch(() => {});
            })
          );
        }

        await Promise.all(promises);
      })().catch(async error => {
        console.error("Webhook Forward WaitUntil Error:", error);
        await safePutKV(env, "WEBHOOK_FORWARD_LAST", {
          ok: false,
          error: error?.message || String(error),
          eventCount: unhandledEvents.length,
          forwardedAt: new Date().toISOString(),
        }, { expirationTtl: 86400 }).catch(() => {});
      }));
    } catch (err) {
      console.error("Webhook processing error:", err);
    }

    return new Response("OK", { status: 200 });
  },

  async handleLinePayConfirm(request, env, ctx) {
    const url = new URL(request.url);
    const orderId = String(url.searchParams.get("orderId") || "").trim();
    const redirectUrl = url.searchParams.get("redirect") || "";
    const queryTransactionId = String(url.searchParams.get("transactionId") || "").trim();
    try {
      if (!orderId) throw new Error("缺少 LINE Pay 訂單編號");
      const orders = await safeGetKV(env, "ORDERS", []);
      const order = (Array.isArray(orders) ? orders : []).find(o => o && String(o.orderId) === orderId);
      if (!order) throw new Error("找不到 LINE Pay 訂單");
      const transactionId = queryTransactionId || String(order.linePayTransactionId || "").trim();
      if (!transactionId) throw new Error("缺少 LINE Pay transactionId");
      const amount = Math.max(0, Math.floor(Number(order.amount || 0)));
      const settings = await safeGetKV(env, "SYSTEM_SETTINGS", {});
      const cfg = getLinePayConfig(env, settings);
      const data = await callLinePayApi(env, settings, "POST", `/v3/payments/${encodeURIComponent(transactionId)}/confirm`, {
        amount,
        currency: cfg.currency,
      });
      await updateLinePayOrder(env, ctx, orderId, transactionId, {
        status: "PAID",
        paymentStatus: "SUCCESS",
        linePayStatus: "SUCCESS",
        paidAt: new Date().toLocaleString(),
        paymentAmount: amount,
        linePayConfirmedAt: new Date().toISOString(),
        linePayPayInfo: data?.info?.payInfo || [],
      });
      await appendPaymentLog(env, {
        timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }),
        orderNo: orderId,
        amount,
        status: "SUCCESS",
        message: "LINE Pay 付款成功，訂單已更新為已付款",
        tradeNo: transactionId,
        source: "LINEPAY_CONFIRM",
      });
      if (redirectUrl) return Response.redirect(redirectUrl, 302);
      return new Response("LINE Pay OK", { status: 200 });
    } catch (e) {
      await appendPaymentLog(env, {
        timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }),
        orderNo: orderId,
        amount: 0,
        status: "LINEPAY_CONFIRM_ERROR",
        message: e?.message || String(e),
        tradeNo: queryTransactionId,
        source: "LINEPAY_CONFIRM",
      });
      if (redirectUrl) return Response.redirect(`${redirectUrl}${redirectUrl.includes("?") ? "&" : "?"}linepay=error`, 302);
      return new Response(`LINE Pay confirm failed: ${e.message}`, { status: 500 });
    }
  },

  async handleLinePayCancel(request, env, ctx) {
    const url = new URL(request.url);
    const orderId = String(url.searchParams.get("orderId") || "").trim();
    const redirectUrl = url.searchParams.get("redirect") || "";
    if (orderId) {
      try {
        const orders = await safeGetKV(env, "ORDERS", []);
        const order = (Array.isArray(orders) ? orders : []).find(o => o && String(o.orderId) === orderId);
        const pointsToRestore = Math.max(0, Math.floor(Number(order?.pointsUsed || 0)));
        const restoreUid = String(order?.pointsMemberUid || order?.memberUid || order?.userId || "").trim();
        const restorePatch = {};
        if (pointsToRestore > 0 && order?.pointsDeductedAt && !order?.pointsRestoredAt && restoreUid) {
          await this.updatePoints(env, ctx, restoreUid, pointsToRestore, `LINE Pay 取消回補：${orderId}`, {
            source: "linepay_cancel_restore",
            targetName: order?.name || order?.recipientName || "",
          });
          restorePatch.pointsRestoredAt = new Date().toISOString();
          restorePatch.pointRestoreReason = "LINEPAY_CANCEL";
        }
        await updateLinePayOrder(env, ctx, orderId, "", {
          paymentStatus: "CANCELLED",
          linePayStatus: "CANCELLED",
          ...restorePatch,
        });
        await appendPaymentLog(env, {
          timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }),
          orderNo: orderId,
          amount: 0,
          status: "CANCELLED",
          message: "使用者取消 LINE Pay 付款",
          tradeNo: "",
          source: "LINEPAY_CANCEL",
        });
      } catch (e) {
        console.error("LINE Pay cancel update failed", e);
      }
    }
    if (redirectUrl) return Response.redirect(`${redirectUrl}${redirectUrl.includes("?") ? "&" : "?"}linepay=cancel`, 302);
    return new Response("LINE Pay cancelled", { status: 200 });
  },

  async handleNewebpayNotify(request, env, ctx) {
    const url = new URL(request.url);
    const redirectUrl = url.searchParams.get("redirect") || "";
    const rawText = await request.text();
    const formData = new URLSearchParams(rawText);
    const tradeInfoHex = formData.get('TradeInfo') || url.searchParams.get('TradeInfo') || "";
    const receivedStatus = formData.get('Status') || url.searchParams.get('Status') || "";
    if (!tradeInfoHex) {
      const missingLog = appendPaymentLog(env, {
        timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }),
        orderNo: formData.get('MerchantOrderNo') || url.searchParams.get('MerchantOrderNo') || "",
        amount: Number(formData.get('Amt') || url.searchParams.get('Amt') || 0),
        status: receivedStatus || "MISSING_TRADE_INFO",
        message: "金流回傳未帶 TradeInfo，無法解密更新訂單",
        tradeNo: formData.get('TradeNo') || url.searchParams.get('TradeNo') || "",
        source: redirectUrl ? "RETURN_URL" : "NOTIFY_URL",
      });
      if (redirectUrl) await missingLog;
      else ctx.waitUntil(missingLog);
      if (redirectUrl) return Response.redirect(redirectUrl, 302);
      return new Response("OK", { status: 200 });
    }

    const task = (async () => {
      try {
          const sets = await safeGetKV(env, "SYSTEM_SETTINGS", {});
          if (sets.newebpay_hash_key && sets.newebpay_hash_iv) {
              const decrypted = await aesDecrypt(tradeInfoHex, sets.newebpay_hash_key, sets.newebpay_hash_iv);
              const data = JSON.parse(decrypted);
              const result = data?.Result || {};
              const orderId = String(result.MerchantOrderNo || "").trim();
              let orderUpdated = false;
              let message = "";

              if (data && data.Status === 'SUCCESS' && orderId) {
                  const orders = await safeGetKV(env, "ORDERS", []);
                  const idx = orders.findIndex(o => o && o.orderId === orderId);
                  if (idx > -1) {
                    orders[idx] = {
                      ...orders[idx],
                      status: "PAID",
                      paymentStatus: "SUCCESS",
                      newebpayStatus: "SUCCESS",
                      paidAt: new Date().toLocaleString(),
                      newebpayTradeNo: result.TradeNo || "",
                      newebpayMerchantOrderNo: orderId,
                      paymentAmount: Number(result.Amt || orders[idx].amount || 0),
                      updatedAt: new Date().toISOString(),
                    };
                    await putOrdersKV(env, ctx, orders);
                    orderUpdated = true;
                  } else {
                    message = "order_not_found";
                  }
              } else {
                message = data?.Status || "invalid_payment_status";
              }

              await appendPaymentLog(env, {
                timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }),
                orderNo: orderId || result.MerchantOrderNo || "",
                amount: Number(result.Amt || 0),
                status: data?.Status || "",
                message: orderUpdated ? "訂單已更新為已付款" : (message || "未更新訂單"),
                tradeNo: result.TradeNo || "",
                source: redirectUrl ? "RETURN_URL" : "NOTIFY_URL",
              });

              if (data && data.Status === 'SUCCESS' && env.TG_BOT_TOKEN) {
                  this.sendTgMessage(env, `💳 <b>藍新刷卡成功</b>\n單號：${orderId || result.MerchantOrderNo || "未知"}\n金額：$${result.Amt || ""}\n狀態：已完款`);
              }

              if (env.GAS_URL) {
                await fetch(env.GAS_URL, {
                  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "NEWEBPAY_NOTIFY_DECRYPTED", payload: { decryptedData: data } }), redirect: "follow"
                });
              }
          }
      } catch (e) {
        console.error("NewebPay decrypt error", e);
        await appendPaymentLog(env, {
          timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }),
          orderNo: "",
          amount: 0,
          status: "DECRYPT_ERROR",
          message: `金流回傳解密失敗：${e?.message || e}`,
          tradeNo: "",
          source: redirectUrl ? "RETURN_URL" : "NOTIFY_URL",
        });
      }
    })();

    if (redirectUrl) {
      await task;
      return Response.redirect(redirectUrl, 302);
    }
    ctx.waitUntil(task);
    return new Response("OK", { status: 200 });
  }
};

