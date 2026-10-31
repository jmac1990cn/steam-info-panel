/* ===========================================================
 * Steam 游戏速查面板 —— 设置页
 *
 * 加固要点（Steam 客户端 CEF / Extendium 等受限环境）：
 *  1. 先做 chrome.* API 可用性检测，缺失时只显示提示，不继续执行；
 *  2. 统一用回调式 sendMessage，避免 Promise 在无监听方时抛未捕获异常；
 *  3. 所有初始化步骤独立 try/catch，失败信息显示在页面上（不白屏）。
 * 说明：Steam 客户端里请改用商店页面板上的「⚙ 设置」，不要打开本页。
 * =========================================================== */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* ---------- 环境检测 ---------- */
  const env = {
    storage: !!(window.chrome && chrome.storage && chrome.storage.local),
    messaging: !!(window.chrome && chrome.runtime && typeof chrome.runtime.sendMessage === "function"),
  };
  const envOk = env.storage && env.messaging;

  function warn(text) {
    const box = $("envwarn");
    if (box) {
      box.textContent = text;
      box.style.display = "block";
    }
  }

  if (!envOk) {
    warn(
      "当前环境不支持扩展设置页（缺少 chrome." +
        (env.storage ? "runtime" : "storage") +
        "）。在 Steam 客户端里请直接使用商店页右侧面板的「⚙ 设置」。"
    );
    return;
  }

  /* ---------- 工具 ---------- */
  function sendMsg(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (r) => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ error: String(err.message || err) });
          else resolve(r || {});
        });
      } catch (e) {
        resolve({ error: String((e && e.message) || e) });
      }
    });
  }

  function setText(el, t) {
    if (el) el.textContent = t;
  }

  /* ---------- 缓存 ---------- */
  const stat = $("stat");
  const btn = $("clear");

  async function refresh() {
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all || {}).filter((k) => /^(price|owned|dlc|xgp|drm):/.test(k));
      setText(stat, `当前缓存条目：${keys.length} 条`);
    } catch (e) {
      setText(stat, "读取缓存失败：" + String((e && e.message) || e));
    }
  }

  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "清除中…";
      const r = await sendMsg({ type: "clearCache" });
      btn.textContent = `已清除 ${(r && r.cleared) || 0} 条`;
      btn.disabled = false;
      refresh();
    });
  }

  /* ---------- Game Pass 目录 ---------- */
  const xbtn = $("xgpupdate");
  const xstat = $("xgpstat");

  async function xgpStat() {
    try {
      const o = await chrome.storage.local.get("xgpCatalog");
      const c = o && o.xgpCatalog;
      setText(
        xstat,
        c
          ? `已缓存在线目录：${c.count} 条（更新于 ${c.updated}）· 每 7 天自动检查更新`
          : "当前使用内置目录（631 条，随插件分发）· 每 7 天自动检查更新"
      );
    } catch (e) {
      setText(xstat, "读取目录状态失败：" + String((e && e.message) || e));
    }
  }

  if (xbtn) {
    xbtn.addEventListener("click", async () => {
      xbtn.disabled = true;
      xbtn.textContent = "更新中（约 1–2 分钟）…";
      setText(xstat, "正在从 Xbox 目录拉取…");
      const r = await sendMsg({ type: "refreshXgp" });
      if (r && r.error) {
        setText(xstat, "更新失败：" + r.error);
        xbtn.textContent = "重试更新";
      } else {
        setText(xstat, `已更新：${r.count} 条（${r.updated}）`);
        xbtn.textContent = "在线更新目录";
      }
      xbtn.disabled = false;
    });
  }

  /* ---------- ITAD API key ---------- */
  const itadInput = $("itad");
  const itadBtn = $("saveitad");
  const itadStat = $("itadstat");

  async function loadSettings() {
    const r = await sendMsg({ type: "getSettings" });
    const k = (r && r.settings && r.settings.itadKey) || "";
    if (itadInput) itadInput.value = k;
    setText(
      itadStat,
      k
        ? "已配置自定义 key，国区史低走 ITAD，Epic 免费检测可用"
        : "未配置 key：国区史低用本地观测，Epic 免费检测不可用（免费申请：isthereanydeal.com/apps/my）"
    );
  }

  if (itadBtn) {
    itadBtn.addEventListener("click", async () => {
      const v = String((itadInput && itadInput.value) || "").trim();
      await sendMsg({ type: "setSettings", settings: { itadKey: v } });
      await loadSettings();
      setText(itadStat, v ? "已保存自定义 key" : "已清空，国区精确史低与 Epic 免费检测停用");
    });
  }

  /* ---------- Steam 客户端本地数据导入 ---------- */
  const flc = $("flc");
  const fpi = $("fpi");
  const localStat = $("localstat");
  const clearLocal = $("clearlocal");

  async function refreshLocalStat() {
    const r = await sendMsg({ type: "getLocalLibrary" });
    const lib = r && !r.error ? r : null;
    setText(
      localStat,
      lib && lib.owned
        ? `已导入：本人 ${lib.owned.length} 款 / 共享借入 ${(lib.borrowed || []).length} 款　导入于 ${String(
            lib.importedAt || ""
          ).slice(0, 10)}`
        : "未导入"
    );
  }

  async function handleFile(input, kind) {
    const f = input && input.files && input.files[0];
    if (!f) return;
    setText(localStat, `正在解析 ${f.name} …`);
    try {
      let payload;
      if (kind === "localconfig") {
        payload = { kind, text: await f.text() };
      } else {
        payload = { kind, bytes: await f.arrayBuffer() };
      }
      const r = await sendMsg(Object.assign({ type: "importVdf" }, payload));
      if (r && r.error) throw new Error(r.error);
      setText(
        localStat,
        `已解析 ${f.name}：新增 ${r.added || 0} 条，当前本人 ${(r.owned || []).length} 款 / 共享 ${
          (r.borrowed || []).length
        } 款`
      );
    } catch (e) {
      setText(localStat, "解析失败：" + String((e && e.message) || e));
    }
    input.value = "";
  }

  if (flc) flc.addEventListener("change", () => handleFile(flc, "localconfig"));
  if (fpi) fpi.addEventListener("change", () => handleFile(fpi, "packageinfo"));
  if (clearLocal) {
    clearLocal.addEventListener("click", async () => {
      await sendMsg({ type: "clearLocalLibrary" });
      refreshLocalStat();
    });
  }

  /* ---------- Epic 免费检测：免登录，选项页无设置项（逻辑在 background.js getEpicGiveaways，走 ITAD 赠送记录） ---------- */
  /* ---------- 初始化：每步独立容错 ---------- */
  const steps = [
    ["缓存", refresh],
    ["目录状态", xgpStat],
    ["ITAD 设置", loadSettings],
    ["本地库", refreshLocalStat],
  ];
  (async () => {
    const failed = [];
    for (const [name, fn] of steps) {
      try {
        await fn();
      } catch (e) {
        failed.push(`${name}（${String((e && e.message) || e)}）`);
      }
    }
    if (failed.length) warn("以下模块加载失败：" + failed.join("、"));
  })();

  // 打开设置页时顺带检查一次目录更新（无 alarms 环境的兜底路径）
  sendMsg({ type: "ensureXgpFresh" }).then((r) => {
    if (r && r.updated) xgpStat();
  });
})();
