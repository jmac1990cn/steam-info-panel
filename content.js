/* ===========================================================
 * Steam 游戏速查面板 —— 内容脚本
 * 在 Steam 商店游戏页注入侧边面板，展示 5 项信息
 * =========================================================== */

(function () {
  "use strict";

  const PANEL_ID = "sip-panel";

  /* ---------- 从 URL 解析 appid ---------- */
  function getAppId() {
    const m = location.pathname.match(/\/(?:app|sub|bundle)\/(\d+)/);
    return m ? m[1] : null;
  }

  function getGameName() {
    const el =
      document.querySelector("#appHubAppName") ||
      document.querySelector(".apphub_AppName") ||
      document.querySelector("div.apphub_AppName");
    if (el && el.textContent.trim()) return el.textContent.trim();
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return og.content.replace(/\s+on Steam$/, "").trim();
    return document.title.replace(/\s*[-—|]\s*Steam.*$/, "").trim();
  }

  const appid = getAppId();
  if (!appid) return;
  if (document.getElementById(PANEL_ID)) return;

  const gameName = getGameName();

  /* ---------- 工具 ---------- */
  const esc = (v) =>
    String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function ask(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (r) => {
          resolve(r || { error: "无响应（请刷新页面重试）" });
        });
      } catch (e) {
        resolve({ error: String((e && e.message) || e) });
      }
    });
  }

  function money(v, cur) {
    if (v == null || isNaN(v)) return "—";
    return (cur === "cny" ? "¥" : "$") + Number(v).toFixed(2);
  }

  /* ---------- 面板骨架 ---------- */
  const ITEMS = [
    { key: "price", label: "史低价格", hint: "CheapShark 史低 + Steam 当前价" },
    { key: "owned", label: "家庭库是否已有", hint: "Steam 库存 / 家庭共享判定" },
    { key: "dlc", label: "DLC 是否单独下载", hint: "DLC 清单与下载方式推断" },
    { key: "xgp", label: "是否在 XGP 会员库", hint: "Xbox Game Pass 目录比对" },
    { key: "drm", label: "是否有 D 加密", hint: "Denuvo / DRM 检测" },
    { key: "epic", label: "是否在 Epic 免费过", hint: "Epic 历史免费记录（ITAD 数据源）" },
  ];

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div id="sip-head">
      <span class="sip-title">游戏速查面板</span>
      <span class="sip-toggle">▼</span>
    </div>
    <div id="sip-body">
      ${ITEMS.map(
        (it, i) => `
        <div class="sip-item" data-key="${it.key}">
          <div class="sip-row">
            <span class="sip-idx">${i + 1}</span>
            <span class="sip-main">
              <span class="sip-label">${esc(it.label)}</span>
              <span class="sip-sub" data-sub>${esc(it.hint)}</span>
            </span>
            <span class="sip-badge b-load" data-badge>检测中</span>
          </div>
          <div class="sip-detail" data-detail></div>
        </div>`
      ).join("")}
      <div id="sip-foot">
        <span>数据源：CheapShark / Steam / PCGamingWiki / SteamDB / GamePass / Epic</span>
        <a href="#" id="sip-refresh" title="清除缓存并重新检测">重新检测</a>
        <a href="#" id="sip-set-toggle" title="面板内设置">⚙ 设置</a>
      </div>
      <div id="sip-set" class="sip-hide">
        <div class="sip-set-row">
          <span class="sip-set-label">ITAD API key</span>
          <input id="sip-itad" type="text" placeholder="填入你的 ITAD API key（免费申请见下方链接）" />
          <button id="sip-itad-save" class="sip-set-btn">保存</button>
        </div>
        <div class="sip-set-row">
          <a href="https://isthereanydeal.com/apps/my/" target="_blank" rel="noreferrer" title="登录 IsThereAnyDeal 后在 My Apps 里免费创建/查看 API key">↗ 免费申请 / 查看 ITAD API key（isthereanydeal.com/apps/my）</a>
        </div>
        <div class="sip-set-row">
          <button id="sip-clear" class="sip-set-btn">清除全部缓存</button>
          <button id="sip-open-options" class="sip-set-btn sip-set-btn2">完整设置页（仅浏览器）</button>
        </div>
        <div class="sip-set-row">
          <a id="sip-open-ext" class="sip-set-btn sip-set-btn-wide" href="chrome://extensions" target="_blank" rel="noreferrer" title="浏览器：点击直接打开；Steam 客户端：请在此按钮上右键 → 在新选项卡中打开链接">管理扩展 (chrome://extensions)</a>
        </div>
        <div class="sip-set-hint">Steam 客户端里请在此按钮上【右键 → 在新选项卡中打开链接】；或点它复制地址后在地址栏粘贴访问。</div>
        <div class="sip-set-sep">Epic 免费检测（显示「是否在 Epic 免费过」）</div>
        <div class="sip-set-stat">数据源：ITAD 赠送记录，覆盖 Epic 自 2018 年起每周喜加一历史，免登录。需在上方填入自己的 ITAD API key 后生效（免费申请链接见上）。</div>
        <div class="sip-set-stat" id="sip-set-stat">设置仅保存在本机，不会上传。</div>
      </div>
    </div>`;

  /* ---------- 插入页面 ---------- */
  function mount() {
    const host =
      document.querySelector("div.rightcol") ||
      document.querySelector("#game_meta_data") ||
      document.querySelector(".game_meta_data");
    if (host) {
      host.insertBefore(panel, host.firstChild);
      return;
    }
    // 兜底：固定到视口右侧
    Object.assign(panel.style, {
      position: "fixed",
      top: "80px",
      right: "16px",
      width: "320px",
      zIndex: "99999",
    });
    document.body.appendChild(panel);
  }

  mount();

  panel.querySelector("#sip-head").addEventListener("click", () => {
    panel.classList.toggle("sip-collapsed");
  });

  panel.querySelectorAll(".sip-row").forEach((row) => {
    row.addEventListener("click", () => row.parentElement.classList.toggle("sip-open"));
  });

  panel.querySelector("#sip-refresh").addEventListener("click", async (e) => {
    e.preventDefault();
    await ask("clearCache");
    runAll();
  });

  /* ---------- 面板内嵌设置 ----------
   * Steam 客户端（Millennium + Extendium / CEF）里没有浏览器标签页，
   * 点击「扩展程序选项」会让宿主崩溃。因此把常用设置搬进面板，
   * 该环境下用户无需打开选项页。 */
  const setBox = panel.querySelector("#sip-set");
  const setStat = panel.querySelector("#sip-set-stat");
  const itadInput = panel.querySelector("#sip-itad");

  async function loadSettingsIntoPanel() {
    try {
      const r = await ask("getSettings");
      const k = (r && r.settings && r.settings.itadKey) || "";
      itadInput.value = k;
      setStat.textContent = k
        ? "ITAD 已配置，国区史低走 ITAD，Epic 免费检测可用。"
        : "未配置 ITAD key：国区史低用本地观测，Epic 免费检测不可用。点上方链接免费申请。";
    } catch (e) {
      setStat.textContent = "读取设置失败：" + String((e && e.message) || e);
    }
  }

  panel.querySelector("#sip-set-toggle").addEventListener("click", (e) => {
    e.preventDefault();
    const hidden = setBox.classList.toggle("sip-hide");
    if (!hidden) {
      loadSettingsIntoPanel();
    }
  });

  panel.querySelector("#sip-itad-save").addEventListener("click", async (e) => {
    e.preventDefault();
    const v = String(itadInput.value || "").trim();
    setStat.textContent = "保存中…";
    try {
      await ask("setSettings", { settings: { itadKey: v } });
      setStat.textContent = v ? "已保存，点「重新检测」生效。" : "已清空 ITAD key，国区精确史低与 Epic 免费检测停用。";
    } catch (err) {
      setStat.textContent = "保存失败：" + String((err && err.message) || err);
    }
  });

  panel.querySelector("#sip-clear").addEventListener("click", async (e) => {
    e.preventDefault();
    const r = await ask("clearCache");
    setStat.textContent = "已清除 " + ((r && r.cleared) || 0) + " 条缓存，正在重新检测…";
    runAll();
  });

  // 完整设置页只对浏览器环境安全（Steam 客户端里点它可能崩），失败时给出内嵌设置的指引
  panel.querySelector("#sip-open-options").addEventListener("click", (e) => {
    e.preventDefault();
    const tip = "当前环境无法打开设置页，请直接用上方内嵌设置。";
    try {
      if (chrome.runtime && typeof chrome.runtime.openOptionsPage === "function") {
        chrome.runtime.openOptionsPage();
        setStat.textContent = "已尝试打开设置页…";
        setTimeout(() => {
          if (setStat.textContent === "已尝试打开设置页…") setStat.textContent = tip;
        }, 1500);
      } else {
        setStat.textContent = tip;
      }
    } catch (err) {
      setStat.textContent = tip;
    }
  });

  // 打开扩展管理页（chrome://extensions）
  //  · 浏览器：走扩展 API（chrome.tabs）新标签打开，最可靠
  //  · Steam 客户端（CEF）：无 chrome.tabs、渲染器也禁止导航到 chrome://，
  //    唯一放行通道是宿主的「右键 → 在新选项卡中打开链接」——本元素就是为此而生的真实 <a href>。
  //    点击时额外兜底：window.open 试一次 + 复制地址供地址栏粘贴（Steam 客户端地址栏已验证可访问）。
  panel.querySelector("#sip-open-ext").addEventListener("click", async (e) => {
    e.preventDefault(); // 交给我们自己控制；右键菜单项不受影响
    setStat.textContent = "正在尝试打开扩展管理页…";

    // ① 浏览器环境：扩展 API
    let apiErr = "";
    try {
      const r = await ask("openExtensions");
      if (r && r.ok) {
        setStat.textContent = "已在浏览器新标签打开 chrome://extensions。";
        return;
      }
      apiErr = (r && r.error) || "未知原因";
    } catch (err) {
      apiErr = String((err && err.message) || err);
    }

    // ② CEF 兜底：window.open 试一次（部分宿主会放行，等同“新选项卡打开链接”）
    let opened = false;
    try {
      opened = !!window.open("chrome://extensions", "_blank");
    } catch (_) {}

    // ③ 兜底：复制地址，供地址栏粘贴
    let copied = false;
    try {
      await navigator.clipboard.writeText("chrome://extensions");
      copied = true;
    } catch (_) {}

    setStat.textContent =
      (opened ? "已尝试在新选项卡打开；若未出现，请" : "当前环境无法由扩展直接打开，请") +
      "在本按钮上【右键 → 在新选项卡中打开链接】" +
      (copied
        ? "，或在地址栏（Ctrl+L）粘贴已复制的 chrome://extensions 访问。"
        : "，或在地址栏手动输入 chrome://extensions 访问。");
  });

  /* ---------- Epic 免费检测：免登录，无面板设置（逻辑在 background.js getEpicFree） ---------- */
  /* ---------- 渲染 ---------- */
  function render(key, badge, cls, sub, detailHtml) {
    const item = panel.querySelector(`.sip-item[data-key="${key}"]`);
    if (!item) return;
    item.querySelector("[data-badge]").textContent = badge;
    item.querySelector("[data-badge]").className = "sip-badge " + cls;
    item.querySelector("[data-sub]").innerHTML = sub;
    item.querySelector("[data-detail]").innerHTML = detailHtml || "";
  }

  /* ---------- 1. 史低价格 ---------- */
  async function loadPrice() {
    const r = await ask("price", { appid });
    if (r.error && !r.lowest) {
      render("price", "失败", "b-warn", esc(r.error), "");
      return;
    }
    const l = r.lowest; // CheapShark：美元口径
    const itad = r.itad || null; // ITAD：Steam 商店国区史低
    const obs = r.observed || null; // 本地观测最低
    const cn = r.current && r.current.cn;
    const us = r.current && r.current.us;

    let sub = "";
    if (cn && cn.final) sub = `国区现价 <b>${esc(cn.final)}</b>${cn.discount ? "（-" + cn.discount + "%）" : ""}`;
    else if (cn && cn.free) sub = "Steam 国区：免费游戏";
    else if (us && us.final) sub = `美区现价 <b>${esc(us.final)}</b>`;
    else sub = "Steam 当前价不可得";

    // 国区史低：ITAD 优先，其次本地观测
    let cnLow = null;
    let cnLowSrc = "";
    if (itad && itad.cny != null) {
      cnLow = { cny: itad.cny, date: itad.date };
      // ITAD 的 storeLow=Steam 商店在国区的史低；historyLow.all=收录商店的全站史低（兜底）
      cnLowSrc = itad.scope === "all" ? "ITAD·全商店" : "ITAD·Steam";
    } else if (obs && obs.min != null) {
      cnLow = { cny: obs.min, date: obs.first };
      cnLowSrc = "本地观测";
    }

    let badge = "无史低",
      cls = "b-warn";
    if (cnLow) {
      badge = "国区史低 ¥" + Number(cnLow.cny).toFixed(2);
      cls = "b-info";
      sub += `　|　${cnLowSrc}${cnLow.date ? "（" + esc(cnLow.date) + "）" : ""}`;
    } else if (l) {
      badge = "史低 $" + l.usd.toFixed(2);
      cls = "b-info";
      sub += `　|　美元口径 ${esc(l.date || "—")}`;
    }

    const detail = `
      <div class="sip-kv"><span>国区史低</span><span>${
        cnLow
          ? `<b>¥${Number(cnLow.cny).toFixed(2)}</b>　来源：${cnLowSrc}${cnLow.date ? "　" + esc(cnLow.date) : ""}`
          : r.itadNote
          ? "未接入 ITAD（见下方说明）"
          : "—"
      }</span></div>
      ${
        itad && (itad.cur != null || itad.allCny != null || itad.discount != null)
          ? `<div class="sip-kv"><span>ITAD 国区</span><span>${[
              itad.cur != null ? `当前 ¥${Number(itad.cur).toFixed(2)}` : "",
              itad.discount ? `-${itad.discount}%` : "",
              itad.scope === "steam" && itad.allCny != null
                ? `全商店史低 ¥${Number(itad.allCny).toFixed(2)}`
                : "",
              itad.currency && itad.currency !== "CNY" ? `⚠ 币种为 ${esc(itad.currency)}` : "",
            ]
              .filter(Boolean)
              .join("　")}</span></div>`
          : ""
      }
      <div class="sip-kv"><span>本地观测</span><span>${
        obs ? `¥${Number(obs.min).toFixed(2)}（自 ${esc(obs.first)} 起，当前 ¥${Number(obs.cur).toFixed(2)}）` : "暂无"
      }</span></div>
      <div class="sip-kv"><span>美元史低</span><span>${
        l ? `$${l.usd.toFixed(2)}　${esc(l.date || "")}　约 ¥${l.cny.toFixed(2)}` : "—"
      }</span></div>
      <div class="sip-kv"><span>三方最低</span><span>${r.cheapestNow != null ? money(r.cheapestNow, "usd") : "—"}</span></div>
      <div class="sip-kv"><span>国区现价</span><span>${
        cn && cn.final ? esc(cn.final) + (cn.initial && cn.discount ? `（原价 ${esc(cn.initial)}）` : "") : cn && cn.free ? "免费" : "—"
      }</span></div>
      <div class="sip-kv"><span>美区现价</span><span>${us && us.final ? esc(us.final) : "—"}</span></div>
      ${
        cn && cn.finalRaw && cnLow
          ? `<div class="sip-kv"><span>与史低差</span><span>${
              cn.finalRaw > cnLow.cny
                ? `国区现价高于史低 <b>¥${(cn.finalRaw - cnLow.cny).toFixed(2)}</b>`
                : "国区现价已接近/低于史低"
            }</span></div>`
          : ""
      }
      ${
        r.itadNote
          ? `<div style="margin-top:6px;color:#8ba6bd">${esc(
              r.itadNote
            )}：填入免费的 ITAD key 即可得到 Steam 商店国区精确史低，<a href="https://isthereanydeal.com/apps/my/" target="_blank" rel="noreferrer">点此申请 / 查看 key →</a></div>`
          : ""
      }
      <div style="margin-top:6px"><a href="https://steamdb.info/app/${appid}/" target="_blank" rel="noreferrer">在 SteamDB 查看完整价格曲线 →</a></div>
      ${r.errors && r.errors.length ? `<div class="sip-err">${r.errors.map(esc).join("<br>")}</div>` : ""}`;

    render("price", badge, cls, sub, detail);
  }

  /* ---------- 2. 家庭库是否已有 ---------- */
  function collectHints() {
    let t = "";
    const sel = [
      "#game_area_purchase",
      ".game_area_already_owned",
      ".already_in_library",
      ".game_area_purchase_game",
      "#purchaseGameWrapper",
    ];
    sel.forEach((s) => {
      const el = document.querySelector(s);
      if (el && el.innerText) t += "\n" + el.innerText;
    });
    return t.slice(0, 4000);
  }

  async function loadOwned() {
    const hints = collectHints();
    const r = await ask("owned", { appid, hints });

    let badge = "未拥有",
      cls = "b-warn",
      sub = "库中未检出该游戏";

    if (r.error && !r.logged) {
      badge = "失败";
      cls = "b-warn";
      sub = esc(r.error);
    } else if (!r.logged) {
      badge = "未登录";
      cls = "b-load";
      sub = "未读取到登录态，也未导入本地客户端数据";
    } else if (r.borrowed) {
      badge = "家庭库共享";
      cls = "b-info";
      sub = r.source === "local" ? "本地客户端数据判定为家庭共享借入" : "检出为家庭共享/借用入库，非本人直接购买";
    } else if (r.owned) {
      badge = "已拥有";
      cls = "b-ok";
      sub = r.source === "local" ? "本地客户端库中已包含该游戏" : "本账号库中已包含该游戏";
    }

    if (r.wishlist) sub += "　|　已在愿望单";

    const srcText =
      r.source === "local"
        ? `本地客户端数据（导入于 ${esc(String(r.localAt || "").slice(0, 10))}）`
        : r.source === "web"
        ? "网页登录态"
        : "—";

    const detail = `
      <div class="sip-kv"><span>数据来源</span><span>${srcText}</span></div>
      <div class="sip-kv"><span>本人拥有</span><span>${r.owned ? "<b>是</b>" : "否"}</span></div>
      <div class="sip-kv"><span>家庭共享</span><span>${r.borrowed ? "<b>是</b>" : "未检出"}</span></div>
      ${
        r.source === "local"
          ? `<div class="sip-kv"><span>本地库</span><span>本人 ${r.total || 0} 款 / 共享 ${r.localBorrowed || 0} 款${
              r.steamId ? "（ID " + esc(r.steamId) + "）" : ""
            }</span></div>`
          : ""
      }
      <div class="sip-kv"><span>愿望单</span><span>${r.wishlist ? "是" : "否"}</span></div>
      <div style="margin-top:6px">
        <a href="https://store.steampowered.com/account/licenses/" target="_blank" rel="noreferrer">我的授权与家庭库 →</a>
      </div>
      <div style="margin-top:4px;color:#6d8296">说明：在扩展选项页导入 Steam 客户端的 localconfig.vdf / packageinfo.vdf 后，可离线判定「本人拥有」与「家庭共享借入」（后者依据 package 的 owner 字段）。</div>`;

    render("owned", badge, cls, sub, detail);
  }

  /* ---------- 3. DLC 是否单独下载 ---------- */
  async function loadDlc() {
    const r = await ask("dlc", { appid });
    if (r.error && !r.count) {
      render("dlc", "失败", "b-warn", esc(r.error), "");
      return;
    }
    if (!r.count) {
      render("dlc", "无 DLC", "b-ok", "该游戏没有 DLC", "Steam 官方接口未返回任何 DLC 条目。");
      return;
    }
    // 三分类：新游戏内容 / 无内容解锁类 / 原画音频类
    const cat = (d) => d.category || (d.standAlone ? "media" : "content");
    const GROUPS = [
      { key: "content", label: "新游戏内容 DLC", note: "需增量下载", cls: "pack" },
      { key: "unlock", label: "无内容解锁类 DLC", note: "无文件，无需下载", cls: "unlock" },
      { key: "media", label: "原画音频类 DLC", note: "独立媒体文件", cls: "alone" },
    ];
    const nOf = (k) => r.list.filter((d) => cat(d) === k).length;

    const blocks = GROUPS.map((g) => {
      const arr = r.list.filter((d) => cat(d) === g.key);
      if (!arr.length) return "";
      return (
        `<div class="sip-dlc-gtitle"><span class="v ${g.cls}">${arr.length}</span>${esc(g.label)}<em>${esc(g.note)}</em></div>` +
        arr.map((d) => `<div class="sip-dlc-row"><span class="t">${esc(d.name)}</span></div>`).join("")
      );
    }).join("");

    const nC = nOf("content"),
      nU = nOf("unlock"),
      nM = nOf("media");
    const detail = `
      <div>共 <b>${r.count}</b> 个 DLC（已解析 ${r.list.length} 个）：新内容 <b>${nC}</b> · 解锁类 <b>${nU}</b> · 原画音频 <b>${nM}</b></div>
      <div class="sip-dlc">${blocks}</div>
      <div style="margin-top:6px">判定依据：Steam 未公开 depot 归属接口，此处按 DLC 类型与名称推断
        （<b>无内容解锁类</b>为命名启发式，可能有个别误判）；精确判定请查看
        <a href="https://steamdb.info/app/${appid}/dlc/" target="_blank" rel="noreferrer">SteamDB DLC 页</a>
        （若 DLC 的 depot 挂在本体 app 下，则随本体一起下载）。</div>`;

    render("dlc", r.count + " 个 DLC", "b-info", `新内容 ${nC} · 解锁类 ${nU} · 原画音频 ${nM}`, detail);
  }

  /* ---------- 4. XGP ---------- */
  async function loadXgp() {
    const r = await ask("xgp", { appid, name: gameName });
    let badge = "未在库",
      cls = "b-warn",
      sub = "Game Pass 目录中未匹配到该游戏";

    if (r.unknown) {
      badge = "待确认";
      cls = "b-load";
      sub = "未能拉取 Game Pass 目录，请手动核验";
    } else if (r.included) {
      badge = "在 XGP 库";
      cls = "b-ok";
      sub = "匹配到：" + esc(r.matched);
    }

    const detail = `
      <div class="sip-kv"><span>比对名称</span><span>${esc(gameName)}</span></div>
      <div class="sip-kv"><span>目录条目</span><span>${r.scanned || 0} 条${r.updated ? "（更新于 " + esc(r.updated) + "）" : ""}</span></div>
      <div class="sip-kv"><span>匹配结果</span><span>${r.included ? "<b>" + esc(r.matched) + "</b>" : "未匹配"}</span></div>
      <div class="sip-kv"><span>数据范围</span><span>Game Pass 主机目录（含跨平台作品）</span></div>
      <div style="margin-top:6px">
        <a href="https://www.xbox.com/zh-CN/Search/Results?q=${encodeURIComponent(gameName)}" target="_blank" rel="noreferrer">在 Xbox 官网搜索 →</a>
      </div>
      ${r.unknown ? `<div class="sip-err">目录接口未返回数据（可能被网络或地区限制），请以官网搜索结果为准。</div>` : ""}`;

    render("xgp", badge, cls, sub, detail);
  }

  /* ---------- 5. D 加密（读 Steam 官方披露节点，零网络） ---------- */
  // Steam 商店页是 React 异步渲染：等元数据区就绪，并给 DRM 披露节点留渲染时间，避免误判「未披露」
  async function waitDrmReady(timeout) {
    const SHOP = "#category_block, .game_meta_data, .rightcol, #game_area_purchase";
    const NODE = ".DRM_notice, .drm_notice, [class*='DRM_notice'], [class*='drm_notice']";
    const t0 = Date.now();
    let shopAt = 0;
    const lim = timeout || 4500;
    while (Date.now() - t0 < lim) {
      if (document.querySelector(NODE)) return; // 已出现披露节点，立即开扫
      if (!shopAt && document.querySelector(SHOP)) shopAt = Date.now();
      if (shopAt && Date.now() - shopAt > 1500) return; // 主体就绪但仍无披露节点 → 判定未披露
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  function scanDomDrm() {
    // Steam 商店页右侧元数据区原生就带一块官方披露：div.DRM_notice
    //   中文：「包含第三方 DRM: Denuvo」  英文：「Incorporates 3rd-party DRM: Denuvo Anti-tamper」
    // 该字段由 Valve 强制要求发行商填写，读到即官方结论；无此节点 = Steam 未披露任何第三方 DRM。
    // 内容脚本本就在商店页上，零网络，浏览器与 Steam 客户端（CEF）均可用。
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    // 页面就绪判定：商店页主体（右侧元数据区）已渲染才可信，否则交给后台走兜底源
    const ready = !!document.querySelector(
      "#category_block, .game_meta_data, .rightcol, #game_area_purchase"
    );

    const SEL = [
      ".DRM_notice",
      ".drm_notice",
      "#game_area_drm_notice",
      ".game_area_drm_notice",
      "[class*='DRM_notice']",
      "[class*='drm_notice']",
    ];
    const seen = new Set();
    const notices = [];
    for (const s of SEL) {
      let nodes = [];
      try {
        nodes = document.querySelectorAll(s);
      } catch (e) {
        nodes = [];
      }
      nodes.forEach((el) => {
        const t = norm(el.innerText || el.textContent || "");
        // 只认 DRM 类披露（同页还有 EULA_notice 等相邻块，别混进来）
        if (t && /DRM/i.test(t) && !seen.has(t)) {
          seen.add(t);
          notices.push(t);
        }
      });
    }

    // 布局变动兜底：在右侧元数据区找含「包含第三方 DRM / 3rd-Party DRM」的最小文本块
    if (!notices.length && ready) {
      const scope =
        document.querySelector("#category_block") ||
        document.querySelector(".rightcol") ||
        document.querySelector(".game_meta_data");
      if (scope) {
        const all = scope.querySelectorAll("div, p, span, li");
        for (const el of all) {
          const t = norm(el.innerText || "");
          if (!t || t.length > 200) continue;
          if (/包含第三方\s*DRM|3rd-?Party\s*DRM|Incorporates\s+3rd/i.test(t)) {
            if (!seen.has(t)) {
              seen.add(t);
              notices.push(t);
            }
            break;
          }
        }
      }
    }

    const raw = notices.join(" ｜ ");
    const present = notices.length > 0;

    // 解析具体 DRM 名称（Steam 官方文本里通常直接写明品牌）
    const drms = [];
    const KNOWN = ["Denuvo", "SecuROM", "Arxan", "VMProtect", "StarForce", "SolidShield", "Tagès", "Rovi"];
    for (const k of KNOWN) {
      const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      if (re.test(raw) && drms.indexOf(k) === -1) drms.push(k);
    }
    if (!drms.length && present) {
      const m = raw.match(/(?:DRM)\s*[:：]\s*([^,，｜]+)/i);
      if (m && m[1]) drms.push(norm(m[1]).slice(0, 40));
    }

    const denuvo = /denuvo/i.test(raw);

    return {
      checked: true,
      ready,
      present,
      denuvo,
      thirdParty: present,
      drms,
      raw,
      snippet: raw.slice(0, 240),
    };
  }

  async function loadDrm() {
    await waitDrmReady();
    const dom = scanDomDrm();
    const r = await ask("drm", { appid, name: gameName, dom });
    // 其他 DRM = 除 Denuvo 外的第三方 DRM（Denuvo 已单列一行，避免重复展示）
    const otherDrms = (r.drms || []).filter((d) => !/denuvo/i.test(d));
    let badge = "未知",
      cls = "b-load",
      sub = "未能获取 DRM 信息";

    if (r.denuvo) {
      badge = "含 D 加密";
      cls = "b-bad";
      sub = "检出 Denuvo Anti-Tamper";
    } else if (r.official) {
      badge = "无 D 加密";
      cls = "b-ok";
      sub = "Steam 商店页未披露第三方 DRM";
    } else if (r.source) {
      badge = "无 D 加密";
      cls = "b-ok";
      sub = "未检出 Denuvo";
    }

    const detail = `
      <div class="sip-kv"><span>数据来源</span><span>${esc(r.source || "—")}</span></div>
      <div class="sip-kv"><span>条目校验</span><span>${
        r.official
          ? "官方披露（本页节点）"
          : r.appMatch === false
          ? "名称命中，appid 未校验"
          : r.appMatch
          ? "Steam appid 已核对"
          : "—"
      }</span></div>
      <div class="sip-kv"><span>Denuvo</span><span>${r.denuvo ? "<b style='color:#e05a5a'>是</b>" : "否"}</span></div>
      <div class="sip-kv"><span>其他 DRM</span><span>${otherDrms.length ? otherDrms.map(esc).join("、") : "—"}</span></div>
      ${r.evidence ? `<div style="margin-top:6px;color:#8ba6bd">${r.official ? "Steam 官方披露原文" : "证据片段"}：${esc(r.evidence.slice(0, 220))}</div>` : ""}
      ${
        r.wikiUrl
          ? `<div style="margin-top:6px"><a href="${esc(r.wikiUrl)}" target="_blank" rel="noreferrer">查看来源页 →</a></div>`
          : ""
      }
      ${r.note ? `<div style="margin-top:6px;color:#e0a85a">提示：${esc(r.note)}</div>` : ""}
      ${r.errors && r.errors.length ? `<div class="sip-err">${r.errors.map(esc).join("<br>")}</div>` : ""}`;

    render("drm", badge, cls, sub, detail);
  }

  /* ---------- 6. Epic 免费过 ---------- */
  function fmtEpicDate(s) {
    if (!s) return "—";
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(s).slice(0, 10);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  async function loadEpic() {
    const r = await ask("epic", { appid, name: gameName });
    let badge = "未在 Epic 免费",
      cls = "b-warn",
      sub = "Epic 历史免费记录未匹配到该游戏";
    if (r.givenAway) {
      const tag = r.status === "now" ? "（当前免费中）" : r.status === "soon" ? "（即将免费）" : "（曾免费 " + (r.count || 1) + " 次）";
      badge = "Epic 曾免费" + tag;
      cls = "b-ok";
      const win = r.latest ? fmtEpicDate(r.latest.publish) + " ~ " + fmtEpicDate(r.latest.expiry) : "—";
      sub = "最近一次免费：" + esc(win);
    }

    const listHtml = r.list && r.list.length
      ? r.list.map((g) => `
          <div class="sip-kv"><span>${esc(fmtEpicDate(g.publish))}</span><span>${g.url ? `<a href="${esc(g.url)}" target="_blank" rel="noreferrer">${esc(g.title || "领取记录")}</a>` : esc(g.title || "领取记录")}</span></div>`).join("")
      : "";

    const detail = `
      <div class="sip-kv"><span>比对名称</span><span>${esc(gameName)}</span></div>
      <div class="sip-kv"><span>免费次数</span><span>${r.count || 0} 次</span></div>
      <div class="sip-kv"><span>最近时段</span><span>${r.latest ? esc(fmtEpicDate(r.latest.publish) + " ~ " + fmtEpicDate(r.latest.expiry)) : "—"}</span></div>
      <div class="sip-kv"><span>数据范围</span><span>Epic 历史免费（ITAD 赠送记录，免登录）</span></div>
      ${listHtml}
      <div style="margin-top:6px">
        <a href="https://store.epicgames.com/zh-CN/browse?q=${encodeURIComponent(gameName)}" target="_blank" rel="noreferrer">在 Epic 商店搜索 →</a>
      </div>
      ${r.errors && r.errors.length ? `<div class="sip-err">${r.errors.map(esc).join("<br>")}</div>` : ""}`;

    render("epic", badge, cls, sub, detail);
  }

  /* ---------- 执行 ---------- */
  async function runAll() {
    ITEMS.forEach((it) => {
      const item = panel.querySelector(`.sip-item[data-key="${it.key}"]`);
      if (!item) return;
      item.querySelector("[data-badge]").textContent = "检测中";
      item.querySelector("[data-badge]").className = "sip-badge b-load";
    });
    loadPrice();
    loadOwned();
    loadDlc();
    loadXgp();
    loadDrm();
    loadEpic();
  }

  runAll();
})();
