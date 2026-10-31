/* ===========================================================
 * Steam 游戏速查面板 —— 后台服务（Service Worker）
 * 职责：发起跨域请求（扩展权限绕过 CORS）、解析数据、结果缓存
 * =========================================================== */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 汇率仅用于把美元史低折算成人民币做参考，标注为估算
const USD_CNY = 7.15;

// ITAD API key 不再内置，需用户自备：免费申请入口 https://isthereanydeal.com/apps/my/
// （注册/登录后在「My Apps」里生成 key；API 文档 https://docs.isthereanydeal.com/ ）

// 各类数据缓存时长（毫秒）
const TTL = {
  price: 6 * 3600 * 1000,
  owned: 10 * 60 * 1000,
  dlc: 12 * 3600 * 1000,
  xgp: 12 * 3600 * 1000,
  drm: 24 * 3600 * 1000,
  epic: 24 * 3600 * 1000,
  epicFail: 10 * 60 * 1000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 缓存 ---------------- */
async function cacheGet(key) {
  try {
    const o = await chrome.storage.local.get(key);
    const rec = o && o[key];
    if (rec && Date.now() - rec.t < rec.ttl) return { ...rec.v, _cached: true, _age: Date.now() - rec.t };
  } catch (e) {}
  return null;
}

async function cacheSet(key, v, ttl) {
  try {
    await chrome.storage.local.set({ [key]: { t: Date.now(), ttl, v } });
  } catch (e) {}
}

/* ---------------- HTTP ---------------- */
async function http(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout || 15000);
  const hasBody = opts.body != null;
  try {
    const res = await fetch(url, {
      // 带 body 时必须用 POST（ITAD 的 prices/historylow 等端点只接受 POST，GET 会 405）
      method: opts.method || (hasBody ? "POST" : "GET"),
      headers: {
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Accept: opts.accept || "application/json,text/plain,*/*",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers || {}),
      },
      body: hasBody ? opts.body : undefined,
      credentials: opts.credentials || "omit",
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const txt = await res.text();
    return opts.json ? JSON.parse(txt) : txt;
  } finally {
    clearTimeout(timer);
  }
}

/* 把 ITAD/接口的 HTTP 错误码翻译成人话 */
function httpHint(e) {
  const m = String((e && e.message) || e || "");
  if (m.includes("403")) return "key 无效、已过期或该端点未授权（403）";
  if (m.includes("404")) return "接口路径不存在（404）";
  if (m.includes("405")) return "请求方法不被接受（405）";
  if (m.includes("429")) return "触发限流（429），稍后重试";
  if (m.includes("451")) return "地区/反爬限制（451），无法自动抓取";
  return m;
}

const s = (v) => String(v == null ? "" : v);

/* ===========================================================
 * 1. 史低价格
 * 数据源：CheapShark（史低 / 第三方最低价）+ Steam 官方 appdetails（当前价）
 * =========================================================== */
// CheapShark 偶发 429 限流：失败后按间隔递增重试至多 3 次
async function fetchCheapSharkLowest(appid, out) {
  const url = "https://www.cheapshark.com/api/1.0/games?steamAppID=" + appid;
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const j = await http(url, { json: true, timeout: 12000 });
      const g = Array.isArray(j) && j[0] ? j[0] : null;
      if (!g) {
        out.errors.push("CheapShark 无该 app 的史低记录");
        return null;
      }
      out.name = (g.info && g.info.title) || null;
      out.cheapestNow = g.cheapest ? parseFloat(g.cheapest) : null;
      const l = g.cheapestPriceEver || null;
      if (l && l.price) {
        return {
          usd: parseFloat(l.price),
          cny: Math.round(parseFloat(l.price) * USD_CNY * 100) / 100,
          date: l.date ? new Date(l.date * 1000).toISOString().slice(0, 10) : null,
        };
      }
      return null;
    } catch (e) {
      lastErr = e;
      await sleep(1200 * (i + 1));
    }
  }
  throw lastErr || new Error("CheapShark 请求失败");
}

async function getPrice(appid) {
  const key = "price:" + appid;
  const hit = await cacheGet(key);
  if (hit) return hit;

  const out = { appid, name: null, lowest: null, cheapestNow: null, current: {}, errors: [] };

  try {
    out.lowest = await fetchCheapSharkLowest(appid, out);
  } catch (e) {
    out.errors.push("史低接口失败：" + e.message);
  }

  for (const cc of ["cn", "us"]) {
    try {
      const j = await http(
        `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=zh-cn&filters=price_overview`,
        { json: true }
      );
      const d = (j && j[appid] && j[appid].data) || null;
      if (!d) {
        out.current[cc] = { na: true };
      } else if (d.is_free) {
        out.current[cc] = { free: true };
      } else if (d.price_overview) {
        const p = d.price_overview;
        out.current[cc] = {
          final: p.final_formatted,
          initial: p.initial_formatted,
          discount: p.discount_percent,
          finalRaw: p.final / 100,
        };
      } else {
        out.current[cc] = { na: true };
      }
    } catch (e) {
      out.errors.push(`Steam ${cc.toUpperCase()} 当前价失败：${e.message}`);
    }
  }

  // 本地观测：每次检测记录国区当前价，累积出「观测到的最低价」
  const cnRaw = out.current.cn && out.current.cn.finalRaw;
  if (cnRaw) {
    try {
      out.observed = await recordObserved(appid, cnRaw);
    } catch (e) {}
  }

  // 国区史低：ITAD（需 key）优先，其次本地观测，最后 CheapShark 美元口径
  const itadKey = await getItadKey();
  if (itadKey) {
    try {
      out.itad = await fetchItadLow(appid, itadKey);
    } catch (e) {
      out.errors.push("ITAD 国区史低失败：" + e.message);
    }
  } else {
    out.itadNote = "国区史低需配置 ITAD key";
  }

  await cacheSet(key, out, TTL.price);
  return out;
}

/* 本地观测最低价（无任何外部依赖，越用越准） */
async function recordObserved(appid, priceCny) {
  const k = "obs:" + appid;
  const o = await chrome.storage.local.get(k);
  const today = new Date().toISOString().slice(0, 10);
  const rec = (o && o[k]) || { min: priceCny, first: today, last: today, cur: priceCny };
  rec.cur = priceCny;
  rec.min = Math.min(rec.min || priceCny, priceCny);
  rec.last = today;
  await chrome.storage.local.set({ [k]: rec });
  return rec;
}

async function getItadKey() {
  try {
    const o = await chrome.storage.local.get("settings");
    return (o && o.settings && o.settings.itadKey) || "";
  } catch (e) {
    return "";
  }
}

/* ===========================================================
 * ITAD：Steam 商店（shop 61）在中国区的历史最低价
 *
 * ITAD API v2 正确链路（旧版用的 /games/lowest/v2 路径不存在=404，
 * 且把 POST 端点当 GET 调=405，这里已修正）：
 *   1) GET  /games/lookup/v1?key=&appid=   → {found:true, game:{id}}
 *   2) POST /games/prices/v3?key=&country=CN&shops=61
 *      body: ["<game-uuid>"]
 *      → [{ historyLow:{all,y1,m3}, deals:[{shop:{id,name}, price, regular,
 *                                            cut, storeLow, timestamp}] }]
 *   注意：lookup/v1 是 GET；prices/v3 是 POST（GET 必 405）。
 * =========================================================== */
async function fetchItadLow(appid, apiKey) {
  const k = encodeURIComponent(apiKey);

  try {
    // 1) Steam appid → ITAD 游戏 ID（uuid）
    const lk = await http(`https://api.isthereanydeal.com/games/lookup/v1?key=${k}&appid=${appid}`, {
      json: true,
      timeout: 12000,
    });
    if (!lk || lk.found !== true || !lk.game || !lk.game.id) {
      throw new Error("ITAD 未收录该游戏（无对应条目）");
    }
    const gid = lk.game.id;

    // 2) 取国区（CN）价格：POST + JSON 数组 body
    const res = await http(
      `https://api.isthereanydeal.com/games/prices/v3?key=${k}&country=CN&shops=61`,
      { json: true, method: "POST", body: JSON.stringify([gid]), timeout: 12000 }
    );
    const rec = Array.isArray(res) ? res[0] : res && res[gid];
    if (!rec) throw new Error("ITAD 无价格数据");

    const amt = (p) => (p && p.amount != null ? Number(p.amount) : null);

    // Steam 商店那一档（shops=61 时 deals 里只有 Steam）
    const deal = (rec.deals || []).find((d) => d && d.shop && Number(d.shop.id) === 61) || null;

    const steamLow = deal ? amt(deal.storeLow) : null; // Steam 在国区的历史最低
    const allLow = rec.historyLow ? amt(rec.historyLow.all) : null; // 全商店历史最低（参考）
    const lowAmount = steamLow != null ? steamLow : allLow;
    if (lowAmount == null) throw new Error("ITAD 无历史低价记录");

    const priceObj = (deal && deal.price) || (rec.historyLow && rec.historyLow.all) || null;

    return {
      cny: lowAmount, // 兼容字段：国区史低（元）
      date: null, // ITAD 的 storeLow 不带发生日期，不再伪造
      shop: (deal && deal.shop && deal.shop.name) || "Steam",
      currency: (priceObj && priceObj.currency) || "CNY",
      scope: steamLow != null ? "steam" : "all", // steam=Steam 商店史低 / all=全商店史低兜底
      cur: deal ? amt(deal.price) : null, // Steam 国区当前价
      regular: deal ? amt(deal.regular) : null,
      discount: deal && deal.cut != null ? Number(deal.cut) : null,
      allCny: allLow, // 全商店史低（对比参考）
      itadTitle: (lk.game && lk.game.title) || null,
    };
  } catch (e) {
    throw new Error(httpHint(e));
  }
}


/* ===========================================================
 * 2. 家庭库 / 是否已有
 * 数据源：store.steampowered.com/dynamicstore/userdata（同域，带 Cookie）
 *         + content script 传入的页面文本提示
 * =========================================================== */
async function getOwned(appid) {
  const key = "owned:" + appid;
  const hit = await cacheGet(key);
  if (hit) return hit;

  const out = {
    logged: false,
    owned: false,
    wishlist: false,
    borrowed: false,
    total: 0,
    error: null,
    source: null,
  };

  // ① 本地客户端数据（优先，离线可用，可区分家庭共享借入）
  const local = await loadLocalLibrary();
  if (local && ((local.owned || []).length || (local.borrowed || []).length)) {
    out.source = "local";
    out.logged = true;
    out.owned = (local.owned || []).map(s).includes(s(appid));
    out.borrowed = (local.borrowed || []).map(s).includes(s(appid));
    out.total = (local.owned || []).length;
    out.localBorrowed = (local.borrowed || []).length;
    out.localAt = local.importedAt || null;
    out.steamId = local.steamId || null;
  }

  // ② 网页登录态（补充：愿望单、本人拥有）
  try {
    const j = await http("https://store.steampowered.com/dynamicstore/userdata/", {
      credentials: "include",
      json: true,
    });
    const apps = (j.rgOwnedApps || []).map(s);
    if (apps.length) {
      if (!out.source) {
        out.source = "web";
        out.logged = true;
        out.owned = apps.includes(s(appid));
        out.total = apps.length;
      } else {
        out.webOwned = apps.includes(s(appid));
        out.webTotal = apps.length;
      }
      out.wishlist = (j.rgWishlist || []).map(s).includes(s(appid));
    }
  } catch (e) {
    if (!out.source) out.error = e.message;
  }

  out.ownedAny = !!(out.owned || out.borrowed);
  await cacheSet(key, out, TTL.owned);
  return out;
}

/* ----------------------------------------------------------
 * 本地 Steam 客户端数据：离线判定「家庭库是否已有」
 *  - localconfig.vdf（文本 VDF）  ：Steam\userdata\<id>\config\localconfig.vdf
 *  - packageinfo.vdf（二进制 VDF）：Steam\appcache\packageinfo.vdf，按 owner 区分本人与共享借入
 * ---------------------------------------------------------- */
let localLibMem = null;

async function loadLocalLibrary() {
  if (localLibMem) return localLibMem;
  try {
    const o = await chrome.storage.local.get("localLibrary");
    if (o && o.localLibrary && (o.localLibrary.owned || o.localLibrary.borrowed)) {
      localLibMem = o.localLibrary;
      return localLibMem;
    }
  } catch (e) {}
  return null;
}

/* 文本 VDF */
function parseVdfText(text) {
  const src = String(text || "").replace(/^\s*\/\/.*$/gm, "");
  let i = 0;
  const skip = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const readStr = () => {
    skip();
    if (src[i] !== '"') {
      let s = "";
      while (i < src.length && !/[\s{}]/.test(src[i])) {
        s += src[i];
        i++;
      }
      return s;
    }
    i++;
    let s = "";
    while (i < src.length && src[i] !== '"') {
      if (src[i] === "\\" && i + 1 < src.length) {
        s += src[i + 1];
        i += 2;
      } else {
        s += src[i];
        i++;
      }
    }
    i++;
    return s;
  };
  const parseObj = () => {
    const o = {};
    for (;;) {
      skip();
      if (i >= src.length) return o;
      if (src[i] === "}") {
        i++;
        return o;
      }
      const k = readStr();
      skip();
      if (i >= src.length) return o;
      if (src[i] === "{") {
        i++;
        o[k] = parseObj();
      } else if (src[i] === "}") {
        i++;
        return o;
      } else {
        o[k] = readStr();
      }
    }
  };
  const root = {};
  while (i < src.length) {
    skip();
    if (i >= src.length) break;
    if (src[i] === "}") {
      i++;
      continue;
    }
    const k = readStr();
    skip();
    if (i >= src.length) break;
    if (src[i] === "{") {
      i++;
      root[k] = parseObj();
    } else {
      root[k] = readStr();
    }
  }
  return root;
}

/* 在 VDF 树中找出键为 apps 且子键全为数字的映射 */
function findAppMaps(node, out, depth) {
  if (!node || typeof node !== "object" || depth > 12) return out;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      if (String(k).toLowerCase() === "apps" && keys.length && keys.every((x) => /^\d+$/.test(x))) {
        keys.forEach((x) => out.add(x));
      }
      findAppMaps(v, out, depth + 1);
    }
  }
  return out;
}

/* 二进制 VDF */
function parseBinaryVdf(buffer) {
  const dv = new DataView(buffer);
  let p = 0;
  const readCStr = () => {
    let s = "";
    while (p < dv.byteLength && dv.getUint8(p) !== 0) {
      s += String.fromCharCode(dv.getUint8(p));
      p++;
    }
    p++;
    return s;
  };
  const readValue = (t) => {
    if (t === 1) return readCStr();
    if (t === 2) {
      const v = dv.getInt32(p, true);
      p += 4;
      return v;
    }
    if (t === 3) {
      const v = dv.getFloat32(p, true);
      p += 4;
      return v;
    }
    if (t === 7 || t === 10) {
      const lo = dv.getUint32(p, true);
      const hi = dv.getUint32(p + 4, true);
      p += 8;
      return hi * 4294967296 + lo;
    }
    return readCStr();
  };
  const parseMap = () => {
    const o = {};
    while (p < dv.byteLength) {
      const t = dv.getUint8(p);
      p++;
      if (t === 8) break;
      if (t === 0) {
        const k = readCStr();
        o[k] = parseMap();
      } else {
        const k = readCStr();
        o[k] = readValue(t);
      }
    }
    return o;
  };
  const rootKey = readCStr();
  // 部分 VDF 文件在根 key 后会写一个 0x00 作为表起始标记，容错跳过
  if (p < dv.byteLength && dv.getUint8(p) === 0) p++;
  const root = {};
  root[rootKey] = parseMap();
  return root;
}

/* 从 packageinfo 提取 appid → owner */
function extractOwners(tree) {
  const appOwner = {};
  const ownerCount = {};
  if (!tree || typeof tree !== "object") return { appOwner, ownerCount };
  const first = Object.keys(tree)[0];
  const root = tree.PackageInfo || tree.packageinfo || tree[first] || {};
  for (const pkg of Object.values(root)) {
    if (!pkg || typeof pkg !== "object") continue;
    const owner = pkg.owner != null ? String(pkg.owner) : null;
    const appids = pkg.appids || pkg.appIds || {};
    const list = typeof appids === "object" ? Object.values(appids) : [appids];
    list.forEach((a) => {
      if (a == null || !owner) return;
      appOwner[String(a)] = owner;
      ownerCount[owner] = (ownerCount[owner] || 0) + 1;
    });
  }
  return { appOwner, ownerCount };
}

async function importVdf(kind, text, bytes) {
  const cur = (await loadLocalLibrary()) || { owned: [], borrowed: [], installed: [] };
  const owned = new Set(cur.owned || []);
  const borrowed = new Set(cur.borrowed || []);
  const installed = new Set(cur.installed || []);
  const info = { kind };

  if (kind === "localconfig") {
    const tree = parseVdfText(text);
    const apps = findAppMaps(tree, new Set(), 0);
    apps.forEach((a) => {
      if (!owned.has(a)) info.added = (info.added || 0) + 1;
      owned.add(a);
    });
    info.count = apps.size;
  } else if (kind === "packageinfo") {
    let buf = bytes;
    if (!buf && text) {
      const arr = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) arr[i] = text.charCodeAt(i) & 0xff;
      buf = arr.buffer;
    }
    if (!buf) throw new Error("未收到文件内容");
    const { appOwner, ownerCount } = extractOwners(parseBinaryVdf(buf));
    let me = null;
    let best = 0;
    Object.entries(ownerCount).forEach(([o, c]) => {
      if (c > best) {
        best = c;
        me = o;
      }
    });
    Object.entries(appOwner).forEach(([app, owner]) => {
      if (owner === me) {
        if (!owned.has(app)) info.added = (info.added || 0) + 1;
        owned.add(app);
      } else {
        if (!borrowed.has(app)) info.added = (info.added || 0) + 1;
        borrowed.add(app);
      }
    });
    info.count = Object.keys(appOwner).length;
    info.borrowed = borrowed.size;
    info.steamId = me;
  } else {
    throw new Error("未知文件类型：" + kind);
  }

  const lib = {
    importedAt: new Date().toISOString(),
    owned: [...owned],
    borrowed: [...borrowed],
    installed: [...installed],
    steamId: info.steamId || cur.steamId || null,
  };
  localLibMem = lib;
  await chrome.storage.local.set({ localLibrary: lib });
  return Object.assign(info, lib);
}

// content script 会把页面上的库存/共享提示文本传过来做二次判定
function judgeFamily(owned, hints) {
  const t = (hints || "").toLowerCase();
  const familyMark =
    /family sharing|家庭共享|家庭库|借用|已借用|borrowed|shared library|共享库/.test(t);
  const inLibMark = /已在库中|已在你的库中|in library|已拥有|play game|开始游戏/.test(t);
  return {
    borrowed: !!(familyMark || (inLibMark && !owned)),
    inLibMark,
  };
}

/* ===========================================================
 * 3. DLC 是否需要单独下载 —— 三分类
 * 数据源：Steam appdetails 的 dlc 列表 + 每个 DLC 的类型/名称推断
 *   content  新游戏内容 DLC   —— 关卡/剧情/角色等实际内容，需增量下载
 *   unlock   无内容解锁类 DLC —— 预购/创始人/奖励/货币等「权益解锁」型，无独立文件、通常无需下载
 *   media    原画/音频类 DLC —— 原声带/画集/壁纸等独立媒体文件，本体安装不含
 * 说明：Steam 未提供公开的 depot 归属接口，unlock / media 依据「类型 + 名称」启发式判定，
 *       结论附 SteamDB DLC 页供人工复核。
 * =========================================================== */
const AUDIO_RE = /soundtrack|ost\b|原声|音乐集|music|artbook|画集|wallpaper|壁纸|digital\s*art|\bOST\b/i;
// 无内容解锁类的常见命名信号（预购/创始人/奖励/货币/礼物/免费解锁 等）
const UNLOCK_RE = /pre-?order|preorder|founder|bonus|unlock|currency|coins?\b|tokens?\b|credits?\b|gift|免费/i;

function classifyDlc(name, type) {
  if (type === "music" || AUDIO_RE.test(name)) return "media";
  if (UNLOCK_RE.test(name)) return "unlock";
  return "content";
}

const DLC_VERDICT = {
  content: "新游戏内容：需增量下载（可在「属性 → DLC」中取消勾选）",
  unlock: "无内容解锁类：无独立文件，通常无需下载（按命名推断）",
  media: "原画/音频类：独立媒体文件，本体安装不含",
};

async function getDlc(appid) {
  const key = "dlc:" + appid;
  const hit = await cacheGet(key);
  if (hit) return hit;

  const out = { count: 0, list: [], error: null, groups: { content: 0, unlock: 0, media: 0 } };
  try {
    const j = await http(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=zh-cn`, {
      json: true,
    });
    const data = (j && j[appid] && j[appid].data) || null;
    const ids = ((data && data.dlc) || []).map(Number).filter(Boolean);
    out.count = ids.length;
    const target = ids.slice(0, 30);

    // 注意：Steam 的 appdetails 端点【只接受单个 appid】，逗号分隔的多 appid 会返回 HTTP 400
    //      （旧实现按 8 个一批请求 → 逐条解析恒为空）。这里改为逐条请求，并用小延时避免限流。
    for (let i = 0; i < target.length; i++) {
      const id = target[i];
      try {
        const jj = await http(`https://store.steampowered.com/api/appdetails?appids=${id}&l=zh-cn`, { json: true });
        const rec = jj && jj[id];
        if (!rec || !rec.success) continue;
        const d = rec.data || {};
        const name = d.name || "DLC " + id;
        const type = d.type || "dlc";
        const category = classifyDlc(name, type);
        out.list.push({
          appid: id,
          name,
          type,
          category, // content | unlock | media
          standAlone: category === "media", // 兼容旧字段
          verdict: DLC_VERDICT[category],
        });
      } catch (e) {
        out.error = e.message;
      }
      if (i + 1 < target.length) await sleep(120);
    }
  } catch (e) {
    out.error = e.message;
  }
  // 三类计数（基于已解析出的条目）
  out.groups = { content: 0, unlock: 0, media: 0 };
  out.list.forEach((d) => {
    if (out.groups[d.category] != null) out.groups[d.category]++;
  });
  await cacheSet(key, out, TTL.dlc);
  return out;
}

/* ===========================================================
 * 4. 是否在 XGP 会员库
 * 数据源：catalog.gamepass.com 目录接口（多组列表 ID 容错）
 * =========================================================== */
// 实测可用的 Game Pass 目录 ID（All Console Games，约 630+ 条）
const XGP_SIGL = "f6f1f99f-9b49-4ccd-b3bf-4d9767a77f5e";

function normTitle(t) {
  let x = s(t).toLowerCase().replace(/[®™©]/g, " ").replace(/[：:–—\-–]/g, " ");
  x = x.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const cut = x.split(" ");
  return x;
}

function titleMatch(a, b) {
  const A = normTitle(a);
  const B = normTitle(b);
  if (!A || !B) return false;
  if (A === B) return true;
  if (A.length >= 6 && B.includes(A)) return true;
  if (B.length >= 6 && A.includes(B)) return true;
  return false;
}

/* 内置目录（随插件分发）优先，避免每次打开页面都联网 */
let xgpCatalogMem = null;

async function loadXgpCatalog() {
  if (xgpCatalogMem) return xgpCatalogMem;
  try {
    const o = await chrome.storage.local.get("xgpCatalog");
    if (o && o.xgpCatalog && o.xgpCatalog.items && o.xgpCatalog.items.length) {
      xgpCatalogMem = o.xgpCatalog;
      return xgpCatalogMem;
    }
  } catch (e) {}
  try {
    const j = await http(chrome.runtime.getURL("xgp-catalog.json"), { json: true });
    if (j && j.items && j.items.length) {
      xgpCatalogMem = j;
      return j;
    }
  } catch (e) {}
  return null;
}

/* 在线重建目录：sigls 取产品 ID → displaycatalog 每 20 个换名 */
async function refreshXgpCatalog() {
  const j = await http(
    `https://catalog.gamepass.com/sigls/v2?id=${XGP_SIGL}&market=US&language=en-us`,
    { json: true, timeout: 20000 }
  );
  const ids = (Array.isArray(j) ? j : []).map((e) => e && e.id).filter(Boolean);
  if (!ids.length) throw new Error("Game Pass 目录为空");

  const items = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const r = await http(
        "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" +
          chunk.join(",") +
          "&market=US&languages=en-us&fieldsTemplate=StoreSDK",
        { json: true, timeout: 25000 }
      );
      ((r && r.Products) || []).forEach((p) => {
        const lp = (p.LocalizedProperties || [{}])[0] || {};
        if (lp.ProductTitle) items.push({ id: p.ProductId, title: lp.ProductTitle });
      });
    } catch (e) {
      /* 该批次失败则跳过 */
    }
    await sleep(250);
  }
  if (!items.length) throw new Error("未能获取目录名称");

  const data = {
    updated: new Date().toISOString().slice(0, 10),
    source: "online",
    count: items.length,
    items,
  };
  xgpCatalogMem = data;
  await chrome.storage.local.set({ xgpCatalog: data });
  return data;
}

/* 每周更新：alarm 在 Chrome/Edge 下可用，Extendium（Steam 客户端）不支持，
   因此同时保留「加载时按更新时间判断」的兜底路径，两种环境下都能自动刷新 */
const XGP_MAX_AGE_DAYS = 7;

function daysSince(dateStr) {
  if (!dateStr) return 999;
  const t = Date.parse(dateStr);
  if (isNaN(t)) return 999;
  return (Date.now() - t) / 86400000;
}

async function ensureXgpFresh(force) {
  try {
    const cat = await loadXgpCatalog();
    const age = daysSince(cat && (cat.updated || (cat.builtAt ? String(cat.builtAt).slice(0, 10) : null)));
    if (!force && age <= XGP_MAX_AGE_DAYS) return { skipped: true, age: Math.round(age) };
    const r = await refreshXgpCatalog();
    return { updated: true, count: r.count, updated_at: r.updated };
  } catch (e) {
    return { error: s(e && e.message) };
  }
}

if (chrome.alarms && chrome.alarms.create) {
  try {
    chrome.alarms.create("xgp-weekly", { periodInMinutes: 7 * 24 * 60 });
    chrome.alarms.onAlarm.addListener((a) => {
      if (a && a.name === "xgp-weekly") ensureXgpFresh(true);
    });
  } catch (e) {}
}

// 唤醒时按需刷新：Steam 客户端（Extendium）环境没有 alarms，靠这条兜底
try {
  ensureXgpFresh(false);
} catch (e) {}

async function getXgp(name, appid) {
  const key = "xgp:" + appid;
  const hit = await cacheGet(key);
  if (hit) return hit;

  const out = { included: false, matched: null, scanned: 0, unknown: false, updated: null, errors: [] };
  const cat = await loadXgpCatalog();

  if (!cat || !cat.items || !cat.items.length) {
    out.unknown = true;
    out.errors.push("Game Pass 目录未加载");
  } else {
    out.scanned = cat.items.length;
    out.updated = cat.updated || null;
    if (name) {
      for (const it of cat.items) {
        if (titleMatch(name, it.title)) {
          out.included = true;
          out.matched = it.title;
          break;
        }
      }
    }
  }

  await cacheSet(key, out, TTL.xgp);
  return out;
}

/* ===========================================================
 * 5. 是否有 D 加密（Denuvo）
 * 数据源：PCGamingWiki Cargo API（首选） → SteamDB 页面（兜底）
 * =========================================================== */
async function getDrm(appid, name, dom) {
  const key = "drm:" + appid;
  const hit = await cacheGet(key);
  if (hit) return hit;

  const out = { denuvo: false, drms: [], source: null, evidence: null, wikiUrl: null, errors: [], unknown: false, note: null };

  // ①【首选·权威】Steam 商店页官方披露节点 div.DRM_notice
  //    Valve 强制发行商填写，是官方口径：有该节点 = 披露了第三方 DRM；无该节点 = 未披露任何第三方 DRM。
  //    页面就绪时命中即返回 —— 零第三方请求，彻底绕开 SteamDB 451 与 PCGW 偶发失败。
  if (dom && dom.checked && dom.ready) {
    out.denuvo = !!dom.denuvo;
    out.drms = dom.drms && dom.drms.length ? dom.drms : dom.denuvo ? ["Denuvo"] : [];
    out.source = dom.present
      ? "Steam 商店页（官方披露）"
      : "Steam 商店页（未披露第三方 DRM）";
    out.evidence = dom.raw || dom.snippet || null;
    out.appMatch = true;
    out.official = true;
    await cacheSet(key, out, TTL.drm);
    return out;
  }

  // ①b 仅当页面未就绪（DOM 不完整）才继续走下方第三方兜底
  const domAnswered = false;

  // ② PCGamingWiki：权威交叉校验 / 补全其他 DRM（尽力而为）
  //    - PCGW 精确命中该游戏（appMatch）且无 Denuvo 时，可纠正本页 DOM 的偶发误报
  //    - PCGW 命中则补全 drms 列表，并作为数据来源
  try {
    const r = await pcgwLookup(appid, name);
    if (r) {
      if (r.denuvo) out.denuvo = true;
      else if (r.appMatch) out.denuvo = false; // 精确页确认无 Denuvo，覆盖本页误报
      const set = new Set(out.drms || []);
      (r.drms || []).forEach((d) => set.add(d));
      out.drms = [...set];
      out.wikiUrl = r.url;
      out.appMatch = r.appMatch;
      if (!out.evidence && r.evidence) out.evidence = r.evidence;
      out.source = domAnswered ? "Steam 商店页 + PCGamingWiki" : "PCGamingWiki";
    }
  } catch (e) {
    out.errors.push((domAnswered ? "PCGW 校验失败：" : "PCGW 查询失败：") + e.message);
  }

  // ③ SteamDB 兜底：仅当前两者都无结论时才尝试；被 Cloudflare/地区反爬（451/403）拦截时
  //    不再抛出吓人的「未知」，仅提示手动核查（service worker 无 Cookie/Cloudflare clearance，直抓必被挡）
  if (!out.source) {
    try {
      const html = await http("https://steamdb.info/app/" + appid + "/", {
        accept: "text/html,application/xhtml+xml",
        timeout: 12000,
      });
      out.source = "SteamDB";
      out.wikiUrl = "https://steamdb.info/app/" + appid + "/";
      out.denuvo = /Denuvo/i.test(html);
      if (out.denuvo) {
        const i = html.toLowerCase().indexOf("denuvo");
        out.evidence = html
          .slice(Math.max(0, i - 120), i + 160)
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      const dm = html.match(/DRM[\s\S]{0,120}?Denuvo[^<]{0,40}/i);
      if (dm) out.drms.push("Denuvo");
    } catch (e) {
      out.errors.push("SteamDB 不可达（" + httpHint(e) + "），请手动在来源页核查");
    }
  }

  if (!out.source) {
    out.unknown = true;
    out.note = "本页与 PCGamingWiki 均未检出，SteamDB 被反爬拦截；请手动在来源页确认。";
  }
  await cacheSet(key, out, TTL.drm);
  return out;
}

/* PCGamingWiki：搜索条目并解析渲染后的 HTML */
async function pcgwSearch(q) {
  const u =
    "https://www.pcgamingwiki.com/w/api.php?action=query&list=search&srsearch=" +
    encodeURIComponent(q) +
    "&format=json&formatversion=2&srlimit=5&redirects=1";
  const j = await http(u, { json: true });
  return ((j && j.query && j.query.search) || []).map((x) => x.title).filter(Boolean);
}

async function pcgwParse(title) {
  const u =
    "https://www.pcgamingwiki.com/w/api.php?action=parse&page=" +
    encodeURIComponent(title) +
    "&prop=text&format=json&formatversion=2&redirects=1";
  const j = await http(u, { json: true, timeout: 20000 });
  return (j && j.parse && j.parse.text) || "";
}

async function pcgwLookup(appid, name) {
  // Steam API 不带 l 参数时返回英文原名，用于提升 PCGW 检索命中率
  let enName = null;
  try {
    const j = await http(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`, {
      json: true,
    });
    enName = (j && j[appid] && j[appid].data && j[appid].data.name) || null;
  } catch (e) {}

  const queries = [];
  [name, enName].forEach((n) => {
    if (n && !queries.includes(n)) queries.push(n);
  });
  if (!queries.length) return null;

  let fallback = null;
  for (const q of queries) {
    let titles = [];
    try {
      titles = await pcgwSearch(q);
    } catch (e) {
      continue;
    }
    for (const t of titles.slice(0, 3)) {
      let html = "";
      try {
        html = await pcgwParse(t);
      } catch (e) {
        continue;
      }
      if (!html) continue;

      const appMatch = html.indexOf("app/" + appid) > -1;
      const denuvo = /denuvo/i.test(html);
      const set = new Set();
      const re = /\/wiki\/DRM:([A-Za-z0-9_%.\-]+)/g;
      let m;
      while ((m = re.exec(html))) {
        try {
          set.add(decodeURIComponent(m[1]).replace(/_/g, " "));
        } catch (e) {
          set.add(m[1]);
        }
      }
      if (denuvo) set.add("Denuvo");

      let evidence = null;
      if (denuvo) {
        const i = html.toLowerCase().indexOf("denuvo");
        evidence = html
          .slice(Math.max(0, i - 150), i + 150)
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      const rec = {
        title: t,
        url: "https://www.pcgamingwiki.com/wiki/" + encodeURIComponent(t.replace(/ /g, "_")),
        denuvo,
        drms: [...set],
        evidence,
        appMatch,
      };
      if (appMatch) return rec; // Steam appid 校验通过，直接采纳
      if (!fallback) fallback = rec;
    }
  }
  return fallback;
}


/* ===========================================================
/* ===========================================================
 * 6. 是否在 Epic 免费过（免登录，走 ITAD 赠送记录）
 * 数据源：IsThereAnyDeal「Giveaways」接口（需在设置中填入用户自己的 ITAD key）
 *   - Steam appid → ITAD 游戏 UUID（/games/lookup/v1?key=&appid=）
 *   - 取该游戏全部赠送记录（含历史，/games/giveaways/v1?expired=true）
 *   - 判定「Epic 免费」：shop.id===16，或 shop.name 含 "epic"，
 *     或 title 含 "epic"（早期记录 shop 为 null，平台写在标题里）
 *   ⚠️ ITAD 赠送记录从 2018 年起完整覆盖 Epic 每周喜加一；
 *      Epic 官方 freeGamesPromotions 仅返回当前/即将免费（无历史），
 *      故改用 ITAD 作为数据源，免登录、无需授权（key 由用户自行申请）。
 * =========================================================== */

// 该条赠送记录是否归属 Epic（早期记录 shop 为 null，需从标题判断）
function epicShopMatch(g) {
  if (!g) return false;
  const shop = g.shop || {};
  if (Number(shop.id) === 16) return true;
  if (shop.name && /epic/i.test(shop.name)) return true;
  if (g.title && /epic/i.test(g.title)) return true;
  return false;
}

// 面板主入口：查该游戏是否在 Epic 历史免费过
async function getEpicGiveaways(appid) {
  const key = "epic:" + appid;
  const hit = await cacheGet(key);
  if (hit) return hit;

  const out = { givenAway: false, count: 0, status: null, latest: null, list: [], scanned: 0, errors: [] };
  try {
    const itadKey = await getItadKey();
    if (!itadKey) {
      out.errors.push("未配置 ITAD key：在面板「⚙ 设置」或扩展选项页填入（免费申请：isthereanydeal.com/apps/my）");
      await cacheSet(key, out, TTL.epicFail);
      return out;
    }
    const k = encodeURIComponent(itadKey);

    // 1) Steam appid → ITAD UUID
    const lk = await http(`https://api.isthereanydeal.com/games/lookup/v1?key=${k}&appid=${appid}`, {
      json: true,
      timeout: 12000,
    });
    if (!lk || lk.found !== true || !lk.game || !lk.game.id) {
      out.errors.push("ITAD 未收录该游戏（无对应条目）");
      await cacheSet(key, out, TTL.epicFail);
      return out;
    }
    const gid = lk.game.id;

    // 2) 取全部赠送记录（含历史）
    const arr = await http(`https://api.isthereanydeal.com/games/giveaways/v1?key=${k}&id=${gid}&expired=true`, {
      json: true,
      timeout: 15000,
    });
    const all = Array.isArray(arr) ? arr : [];
    const list = all.filter(epicShopMatch);
    out.scanned = list.length;
    out.givenAway = list.length > 0;
    out.count = list.length;

    if (list.length) {
      const now = Date.now();
      const parse = (s) => (s ? Date.parse(s) : NaN);
      const sorted = list.slice().sort((a, b) => (parse(b.publish) || 0) - (parse(a.publish) || 0));
      out.list = sorted.slice(0, 6).map((g) => ({
        title: g.title || "",
        publish: g.publish || null,
        expiry: g.expiry || null,
        url: g.url || g.details || null,
      }));
      // 状态：优先「当前免费中」>「即将免费」>「曾免费」
      let status = null;
      for (const g of list) {
        const s = parse(g.publish), e = parse(g.expiry);
        if (!isNaN(s) && !isNaN(e)) {
          if (now >= s && now <= e) { status = "now"; break; }
          if (now < s && status !== "now") status = "soon";
          else if (status === null) status = "past";
        } else if (status === null) status = "past";
      }
      out.status = status || "past";
      out.latest = out.list[0];
    }
    await cacheSet(key, out, TTL.epic);
  } catch (e) {
    out.errors.push("Epic 免费记录读取失败：" + httpHint(e));
    await cacheSet(key, out, TTL.epicFail);
  }
  return out;
}

/* ===========================================================
 * 消息路由
 * =========================================================== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = async () => {
    switch (msg.type) {
      case "price":
        return await getPrice(msg.appid);
      case "owned": {
        const r = await getOwned(msg.appid);
        if (msg.hints) {
          const f = judgeFamily(r.owned, msg.hints);
          r.borrowed = r.borrowed || f.borrowed; // 本地客户端判定优先
          r.inLibMark = f.inLibMark;
        }
        return r;
      }
      case "dlc":
        return await getDlc(msg.appid);
      case "xgp":
        return await getXgp(msg.name, msg.appid);
      case "refreshXgp":
        return await refreshXgpCatalog();
      case "drm":
        return await getDrm(msg.appid, msg.name, msg.dom);
      case "epic":
        return await getEpicGiveaways(msg.appid);
      case "getSettings": {
        const o = await chrome.storage.local.get("settings");
        return { settings: (o && o.settings) || {} };
      }
      case "setSettings": {
        const cur = await chrome.storage.local.get("settings");
        const merged = Object.assign({}, (cur && cur.settings) || {}, msg.settings || {});
        await chrome.storage.local.set({ settings: merged });
        return { ok: true, settings: merged };
      }
      case "importVdf":
        return await importVdf(msg.kind, msg.text, msg.bytes);
      case "getLocalLibrary":
        return await loadLocalLibrary();
      case "clearLocalLibrary": {
        await chrome.storage.local.remove(["localLibrary", "localLibraryRaw"]);
        localLibMem = null;
        return { ok: true };
      }
      case "ensureXgpFresh":
        return await ensureXgpFresh(!!msg.force);
      case "clearCache": {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter((k) => /^(price|owned|dlc|xgp|drm|epic):/.test(k));
        if (keys.length) await chrome.storage.local.remove(keys);
        return { cleared: keys.length };
      }
      case "openExtensions": {
        // 在浏览器 / Steam 客户端里打开扩展管理页，方便直接启用/停用/重载本扩展
        try {
          if (chrome.tabs && typeof chrome.tabs.create === "function") {
            await chrome.tabs.create({ url: "chrome://extensions", active: true });
            return { ok: true };
          }
        } catch (e) {
          return { error: "打开失败：" + (e && e.message ? e.message : String(e)) };
        }
        return { error: "当前环境不支持 chrome.tabs，无法打开扩展管理页" };
      }
      default:
        return { error: "unknown message" };
    }
  };
  run().then(sendResponse).catch((e) => sendResponse({ error: s(e && e.message) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installedAt: Date.now() });
});
