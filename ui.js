// 复扫雷 Complexweeper · 界面与交互
// 依赖 game.js（window.Complexweeper）
// 原作（Zig + Win32）：https://github.com/Yueqing-Chen/complexweeper-A-minesweeper-game

(function () {
  "use strict";
  const C = window.Complexweeper;
  const Game = C.Game;
  const Msg = C.Msg;
  const PRESETS = C.PRESETS;
  const D_LABEL = C.D_LABEL;

  const g = new Game();
  let cells = [];        // DOM 元素数组，下标 = cell id
  let selectedFlag = 0;  // 旗帜条模式：0 揭开 / 1..4 插旗
  let timerHandle = null;
  let frozenTime = 0;    // 游戏结束时冻结的秒数
  // 视口模型：viewportEl 是可见区域；雷盘绝对定位于其内
  //   Vw/Vh   = 视口宽/高（px）；正常模式 Vw==Vh==正方形；全屏模式为屏幕比例
  //   cellSize = 当前每格像素（null = 适配模式：雷盘填满视口短边）
  //   panX/panY = 雷盘相对视口左上角的平移（px）
  //   雷盘 > 视口时可拖动平移；雷盘 ≤ 视口时居中
  let cellSize = null;
  let panX = 0, panY = 0;
  let Vw = 0, Vh = 0;
  let isFullscreen = false;

  // ---------------- DOM 引用 ----------------
  const boardEl = document.getElementById("board");
  const viewportEl = document.getElementById("boardViewport");
  const appEl = document.querySelector(".app");
  const faceIcon = document.getElementById("faceIcon");
  const faceBtn = document.getElementById("face");
  const presetSel = document.getElementById("preset");
  const seedInput = document.getElementById("seed");
  const statusEl = document.getElementById("status");
  const seedInfo = document.getElementById("seedInfo");
  const mineLeds = document.getElementById("mineLeds");
  const timerEl = document.getElementById("timer");
  const flagbar = document.getElementById("flagbar");
  const zoomInBtn = document.getElementById("zoomIn");
  const zoomOutBtn = document.getElementById("zoomOut");
  const zoomResetBtn = document.getElementById("zoomReset");
  const zoomLevelEl = document.getElementById("zoomLevel");
  const zoomGroupEl = document.getElementById("zoomGroup");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const fsToolbarEl = document.getElementById("fsToolbar");

  // ---------------- 工具 ----------------
  function randSeed() { return Math.floor(Math.random() * 0xFFFFFFFF) >>> 0; }

  function ledText(v) {
    // 3 位带符号显示（-99 .. 999）
    if (v >= 0) {
      if (v > 999) v = 999;
      return String(v).padStart(3, "0");
    }
    const a = -v;
    if (a > 99) return "-99";
    return "-" + String(a).padStart(2, "0");
  }

  function buildMineLeds() {
    mineLeds.innerHTML = "";
    const defs = [
      { t: 1, cap: "+1", imag: false },
      { t: 2, cap: "−1", imag: false },
      { t: 3, cap: "+i", imag: true },
      { t: 4, cap: "−i", imag: true },
    ];
    for (const d of defs) {
      const led = document.createElement("div");
      led.className = "led";
      led.innerHTML =
        `<div class="digits${d.imag ? " imag" : ""}" id="led${d.t}">000</div>
         <div class="cap">${d.cap}</div>`;
      mineLeds.appendChild(led);
    }
  }

  // ---------------- 构建棋盘 ----------------
  function buildGrid() {
    boardEl.innerHTML = "";
    boardEl.style.gridTemplateColumns = `repeat(${g.w}, var(--cell))`;
    cells = new Array(g.n);
    for (let i = 0; i < g.n; i++) {
      const el = document.createElement("div");
      el.className = "cell";
      el.dataset.i = i;
      cells[i] = el;
      boardEl.appendChild(el);
    }
  }

  // ---------------- 视口尺寸与缩放 ----------------
  const MIN_CELL = 8;     // 最小每格像素
  const MAX_CELL = 200;   // 最大每格像素
  const VIEWPORT_CAP = 720; // 视口边长上限，避免巨屏过大

  // 雷盘（含 gap）边长 = cols * cell + (cols-1) * gap；此处 gap=0
  function boardPx(cell) { return g.w * cell; }
  // 适配模式下的每格像素：雷盘正好填满视口短边（保持正方形雷盘）
  function fitCell() {
    const minSide = Math.min(Vw, Vh);
    return minSide / (g.w || 9);
  }
  // 当前实际每格像素
  function curCell() { return cellSize !== null ? cellSize : fitCell(); }

  // 计算视口可用宽度：优先用雷盘面板的内部宽度（桌面端两栏时为右栏）
  function availableWidth() {
    const panel = viewportEl.closest(".board-panel");
    if (panel) {
      const cs = getComputedStyle(panel);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const inner = panel.clientWidth - padX;
      if (inner > 0) return inner;
    }
    const reserved = 64; // body padding + app border + wrap padding ≈ 64
    return Math.max(160, window.innerWidth - reserved);
  }
  function computeViewport() {
    if (isFullscreen) {
      // 全屏：屏幕宽度；高度减去悬浮条占用（top 12 + 条高 + 间距 12）
      const barH = parseFloat(getComputedStyle(document.body).getPropertyValue("--fs-bar-h")) || 0;
      return { w: window.innerWidth, h: Math.max(120, window.innerHeight - barH) };
    }
    // 正常：正方形视口，宽度受面板内宽与上限约束
    const s = Math.min(availableWidth(), VIEWPORT_CAP);
    return { w: s, h: s };
  }

  // 应用变换：写 --cell / --vp-w / --vp-h / --pan-x / --pan-y，并 clamp pan
  function applyTransform() {
    const cell = curCell();
    document.documentElement.style.setProperty("--cell", cell + "px");
    viewportEl.style.setProperty("--vp-w", Vw + "px");
    viewportEl.style.setProperty("--vp-h", Vh + "px");
    const B = boardPx(cell);
    // X、Y 维度独立判断：每边雷盘小于视口就居中，大于视口才在可拖动范围内 clamp
    let noPanX = B <= Vw;
    let noPanY = B <= Vh;
    if (noPanX) panX = (Vw - B) / 2;
    else panX = Math.max(Vw - B, Math.min(0, panX));
    if (noPanY) panY = (Vh - B) / 2;
    else panY = Math.max(Vh - B, Math.min(0, panY));
    viewportEl.classList.toggle("no-pan", noPanX && noPanY);
    viewportEl.style.setProperty("--pan-x", panX + "px");
    viewportEl.style.setProperty("--pan-y", panY + "px");
    updateZoomLabel();
  }

  function updateZoomLabel() {
    if (cellSize === null) {
      zoomLevelEl.textContent = "适配";
    } else {
      const fit = fitCell();
      const pct = fit > 0 ? Math.round((cellSize / fit) * 100) : 100;
      zoomLevelEl.textContent = pct + "%";
    }
  }

  // 重算视口尺寸并应用（窗口缩放 / 全屏切换 时调用）
  function fitBoard() {
    const sz = computeViewport();
    Vw = sz.w; Vh = sz.h;
    applyTransform();
  }

  // 缩放：保持视口中心在雷盘上的位置不变
  // delta 为每格像素增量；可选 anchorX/Y 为视口坐标，缩放围绕该点
  // （省略时围绕视口中心，与滚轮缩放保持一致）
  function zoomBy(delta, anchorX, anchorY) {
    const sz = computeViewport();
    Vw = sz.w; Vh = sz.h;
    const oldCell = curCell();
    if (oldCell <= 0) return;
    let next = oldCell + delta;
    if (next < MIN_CELL) next = MIN_CELL;
    if (next > MAX_CELL) next = MAX_CELL;
    if (next === oldCell && cellSize !== null) return;
    // 锚点在雷盘上的坐标（px，相对雷盘左上）
    const ax = (anchorX !== undefined) ? (anchorX - panX) : (Vw / 2 - panX);
    const ay = (anchorY !== undefined) ? (anchorY - panY) : (Vh / 2 - panY);
    const ratio = next / oldCell;
    const newAx = ax * ratio;
    const newAy = ay * ratio;
    cellSize = next;
    if (anchorX !== undefined) {
      panX = anchorX - newAx;
      panY = anchorY - newAy;
    } else {
      panX = Vw / 2 - newAx;
      panY = Vh / 2 - newAy;
    }
    applyTransform();
  }

  function resetZoom() {
    const sz = computeViewport();
    Vw = sz.w; Vh = sz.h;
    cellSize = null;
    panX = 0; panY = 0;
    applyTransform();
  }

  // ---------------- 全屏切换 ----------------
  // 进入全屏时把这些节点移入悬浮条；退出时还原。保存原位（父节点 + 后继兄弟）。
  // 第 1 行：controlbar（计数器 / 脸 / 计时器）
  // 第 2 行：缩放控件 + 旗帜条（用 .fs-row2 包裹以便整体居中）
  // 第 3 行：状态行
  // 关闭按钮单独 fixed 在右上角（脱离悬浮条流）
  const controlbarEl = document.getElementById("controlbar");
  const fsNodes = [fullscreenBtn, controlbarEl, zoomGroupEl, flagbar, statusEl];
  const fsOrigSlots = new Map();
  for (const n of fsNodes) fsOrigSlots.set(n, { parent: n.parentElement, next: n.nextSibling });

  function restoreNode(node) {
    const slot = fsOrigSlots.get(node);
    if (!slot) return;
    if (slot.next && slot.next.parentElement === slot.parent) slot.parent.insertBefore(node, slot.next);
    else slot.parent.appendChild(node);
  }

  // 监听悬浮条高度变化 → 写 --fs-bar-h（top 12 + 高度 + 间距 12）
  const fsResizeObs = new ResizeObserver(() => {
    if (!isFullscreen) return;
    const h = fsToolbarEl.offsetHeight;
    document.body.style.setProperty("--fs-bar-h", (h + 24) + "px");
  });
  fsResizeObs.observe(fsToolbarEl);

  function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    document.body.classList.toggle("board-fullscreen", isFullscreen);
    if (isFullscreen) {
      // 关闭按钮移到右上角（CSS 已 fixed）
      fsToolbarEl.before(fullscreenBtn);
      // 第 2 行容器：包裹缩放 + 旗帜条以便居中
      const row2 = document.createElement("div");
      row2.className = "fs-row2";
      row2.append(zoomGroupEl, flagbar);
      // 注入到悬浮条：controlbar → row2(缩放+旗帜) → 状态行
      fsToolbarEl.append(controlbarEl, row2, statusEl);
      fsToolbarEl.hidden = false;
      fullscreenBtn.textContent = "✕";
      fullscreenBtn.title = "退出全屏（Esc）";
    } else {
      // 还原到原位置（row2 容器内已空，删除即可）
      for (const n of fsNodes) restoreNode(n);
      const row2 = fsToolbarEl.querySelector(".fs-row2");
      if (row2) row2.remove();
      // 关闭按钮还原到雷盘面板内原位
      restoreNode(fullscreenBtn);
      fsToolbarEl.hidden = true;
      document.body.style.removeProperty("--fs-bar-h");
      fullscreenBtn.textContent = "⛶";
      fullscreenBtn.title = "雷盘全屏（Esc 退出）";
    }
    // 等下一帧布局完成后再测量悬浮条高度并适配
    requestAnimationFrame(() => {
      if (isFullscreen) {
        const h = fsToolbarEl.offsetHeight;
        document.body.style.setProperty("--fs-bar-h", (h + 24) + "px");
      }
      resetZoom();
    });
  }

  // ---------------- 单元格内容 ----------------
  function flagHtml(t) {
    const sign = t === 1 ? "+1" : t === 2 ? "−1" : t === 3 ? "+i" : "−i";
    return `<div class="flag f${t}">${sign}</div>`;
  }
  function mineHtml(t) {
    return `<div class="mine m${t}"><div class="core"></div></div>`;
  }
  function openedInner(i) {
    if (g.mine[i] !== 0) return mineHtml(g.mine[i]);
    if (g.isBlank(i)) return "";
    const D = g.clue[i];
    if (D === 0) return `<span class="v0">0</span>`;
    const label = D_LABEL[D] ?? "?";
    return `<span class="v${D} surd">${label}</span>`;
  }

  function cellInner(i) {
    const mine = g.mine[i];
    const flag = g.flag[i];
    const opened = g.open[i] !== 0;

    if (g.over) {
      if (g.win) {
        // 胜利：所有雷按正确类型显示为旗
        if (mine !== 0) return flagHtml(mine);
        return openedInner(i);
      } else {
        // 失败
        if (i === g.boom) return mineHtml(mine);
        if (mine !== 0) return mineHtml(mine);
        if (flag !== 0) {
          // 标错的旗（插在非雷格上）
          return flagHtml(flag) + '<div class="wrongflag"></div>';
        }
        if (opened) return openedInner(i);
        return "";
      }
    }

    if (opened) return openedInner(i);
    if (flag !== 0) return flagHtml(flag);
    return "";
  }

  // ---------------- 渲染 ----------------
  function render() {
    // 游戏结束 → 冻结计时
    if (g.over && timerHandle) {
      stopTimer();
      frozenTime = Math.floor((Date.now() - g.t0) / 1000);
      if (frozenTime > 999) frozenTime = 999;
      if (frozenTime < 0) frozenTime = 0;
    }
    for (let i = 0; i < g.n; i++) {
      const el = cells[i];
      const opened = g.open[i] !== 0;
      let cls = "cell";
      if (g.over && g.win && g.mine[i] !== 0) {
        cls += " open"; // 雷格以"已翻开"样式显示正确旗
      } else if (opened) {
        cls += " open";
        if (g.isBlank(i)) cls += " blank";
      }
      if (g.over && !g.win && i === g.boom) cls += " boom";
      el.className = cls;
      el.innerHTML = cellInner(i);
    }
    renderHud();
    renderStatus();
    renderFace();
  }

  function renderHud() {
    for (let t = 1; t <= 4; t++) {
      const el = document.getElementById("led" + t);
      if (el) el.textContent = ledText(g.unmarked(t));
    }
    let secs;
    if (g.started && !g.over) secs = Math.floor((Date.now() - g.t0) / 1000);
    else secs = frozenTime;
    if (secs > 999) secs = 999;
    if (secs < 0) secs = 0;
    timerEl.textContent = String(secs).padStart(3, "0");
  }

  function renderStatus() {
    let txt = "";
    let cls = "";
    if (g.over && g.win) {
      txt = `胜利！已翻开全部 ${g.safeCount()} 个非雷格子。`;
      cls = "ok";
    } else if (g.over && !g.win) {
      txt = `踩雷了 — 种子 ${g.seed}，点脸重开。`;
      cls = "bad";
    } else if (!g.started) {
      txt = "点击任意格子开局（首点击必为安全区）。";
    } else {
      if (g.msg === Msg.flag_misplaced) {
        txt = "展开中止：有旗帜插在非雷格上（位置不对，不踩雷，可继续调整）。";
        cls = "bad";
      } else if (g.msg === Msg.modulus_fail) {
        txt = "判据不通过：旗帜复数模长 ≠ 真实雷模长（不踩雷，可继续调整）。";
        cls = "bad";
      } else if (g.msg === Msg.judge_fail) {
        txt = "判据不通过：旗数 ≠ 真实雷数，或实/虚比例不符（不踩雷，可继续试探）。";
        cls = "bad";
      } else if (g.msg === Msg.expand_ok) {
        txt = `展开成功，翻开 ${g.msg_arg} 格。`;
        cls = "ok";
      } else {
        txt = `已翻开 ${g.openedCount()} / ${g.safeCount()} · 种子 ${g.seed}`;
      }
    }
    statusEl.innerHTML = `<span class="${cls}">${txt}</span>`;
    seedInfo.textContent = (g.started || g.over) ? "种子 " + g.seed : "";
  }

  function renderFace() {
    if (g.over && g.win) faceIcon.textContent = "😎";
    else if (g.over && !g.win) faceIcon.textContent = "😵";
    else faceIcon.textContent = "🙂";
  }

  // ---------------- 操作 ----------------
  function startGameIfNot(cell) {
    if (!g.started) {
      g.startAt(cell, Date.now());
      startTimer();
    }
  }

  function leftClick(i) {
    if (g.over) return;
    g.setMsg(Msg.none);
    const opened = g.open[i] !== 0;
    if (opened) {
      // 已翻开的数字格：双击展开
      if (g.mine[i] === 0) g.tryExpand(i);
      return;
    }
    if (selectedFlag !== 0) {
      // 插旗模式：左键直接设定该型旗（同型再点 = 清除）
      if (g.flag[i] === selectedFlag) g.setFlag(i, 0);
      else g.setFlag(i, selectedFlag);
      return;
    }
    // 揭开模式：旗保护的格子翻不开
    if (g.flag[i] !== 0) return;
    startGameIfNot(i);
    if (g.started && !g.over) g.reveal(i, Date.now());
  }

  function rightClick(i) {
    if (g.over) return;
    if (g.open[i] !== 0) return;
    g.setMsg(Msg.none);
    // 右键循环插旗：空 → +1 → −1 → +i → −i → 空（未开局也允许）
    g.cycleFlag(i);
  }

  function middleClick(i) {
    if (g.over) return;
    if (g.open[i] === 0 || g.mine[i] !== 0) return;
    g.setMsg(Msg.none);
    g.tryExpand(i);
  }

  // ---------------- 指针交互（鼠标 + 触摸统一） ----------------
  // 拖动阈值：移动超过此距离视为平移而非点击
  const DRAG_THRESHOLD = 5;
  const LONG_PRESS_MS = 380;
  // 单一指针状态
  let pointer = null;
  // { startX, startY, lastX, lastY, moved, button, longTimer, longFired, panning, cellIdx }
  let suppressClick = false; // 拖动/长按后阻止下一次 click

  function cellAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const c = el.closest && el.closest(".cell");
    return c ? +c.dataset.i : null;
  }

  // 开始一次指针按下
  function onPointerDown(x, y, button) {
    const idx = cellAtPoint(x, y);
    pointer = {
      startX: x, startY: y,
      lastX: x, lastY: y,
      moved: false,
      button,
      longTimer: null,
      longFired: false,
      panning: false,
      cellIdx: idx === null ? -1 : idx,
    };
    // 仅触屏启动长按计时（鼠标无长按）
    // （在 touch 分支中单独设置）
  }

  // 指针移动：拖动平移 + 阈值判定
  function onPointerMove(x, y) {
    if (!pointer) return;
    const dx = x - pointer.lastX;
    const dy = y - pointer.lastY;
    const total = Math.hypot(x - pointer.startX, y - pointer.startY);
    if (total > DRAG_THRESHOLD) {
      pointer.moved = true;
      if (pointer.longTimer) { clearTimeout(pointer.longTimer); pointer.longTimer = null; }
    }
    // 雷盘任一边大于视口时，移动即平移
    const cell = curCell();
    const B = boardPx(cell);
    if ((B > Vw || B > Vh) && pointer.moved) {
      pointer.panning = true;
      viewportEl.classList.add("panning");
      panX += dx;
      panY += dy;
      const loX = Vw - B;
      const loY = Vh - B;
      panX = Math.max(loX, Math.min(0, panX));
      panY = Math.max(loY, Math.min(0, panY));
      viewportEl.style.setProperty("--pan-x", panX + "px");
      viewportEl.style.setProperty("--pan-y", panY + "px");
    }
    pointer.lastX = x;
    pointer.lastY = y;
  }

  // 指针抬起：返回是否发生了拖动/长按（用于阻止 click）
  function onPointerUp() {
    if (!pointer) return false;
    if (pointer.longTimer) { clearTimeout(pointer.longTimer); pointer.longTimer = null; }
    viewportEl.classList.remove("panning");
    const wasPanning = pointer.panning;
    const wasLong = pointer.longFired;
    pointer = null;
    return wasPanning || wasLong;
  }

  // ---- 鼠标 ----
  viewportEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    // 中键直接处理展开（不参与拖动）
    if (e.button === 1) {
      const el = e.target.closest(".cell");
      if (el) {
        e.preventDefault();
        middleClick(+el.dataset.i);
        render();
      }
      return;
    }
    onPointerDown(e.clientX, e.clientY, e.button);
    // 左键按下换"紧张"脸
    if (e.button === 0 && pointer) {
      const i = pointer.cellIdx;
      if (i >= 0 && !g.over && g.open[i] === 0 && g.flag[i] === 0 && selectedFlag === 0) {
        faceIcon.textContent = "😮";
      }
    }
  });
  window.addEventListener("mousemove", (e) => {
    if (!pointer) return;
    onPointerMove(e.clientX, e.clientY);
    // 拖动开始后阻止文字选中
    if (pointer.panning) e.preventDefault();
  });
  window.addEventListener("mouseup", (e) => {
    if (!pointer) { renderFace(); return; }
    const consumed = onPointerUp();
    if (consumed) {
      // 拖动或长按发生 → 阻止后续 click
      suppressClick = true;
    }
    renderFace();
  });
  viewportEl.addEventListener("mouseleave", renderFace);

  // 点击（鼠标）：仅当未拖动时触发
  viewportEl.addEventListener("click", (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const el = e.target.closest(".cell");
    if (!el) return;
    leftClick(+el.dataset.i);
    render();
  });
  // 右键：仅当未拖动时触发；阻止系统菜单
  viewportEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (suppressClick) { suppressClick = false; return; }
    const el = e.target.closest(".cell");
    if (!el) return;
    rightClick(+el.dataset.i);
    render();
  });

  // ---- 触摸 ----
  // 双指缩放状态：pinch.dist 为上次两指间距，pinch.cell 为对应每格像素
  let pinch = null;

  function pinchDist(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.hypot(dx, dy);
  }

  viewportEl.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      // 进入双指缩放：取消单指手势（长按/平移）
      if (pointer && pointer.longTimer) { clearTimeout(pointer.longTimer); pointer.longTimer = null; }
      pointer = null;
      viewportEl.classList.remove("panning");
      const rect = viewportEl.getBoundingClientRect();
      const d = pinchDist(e.touches[0], e.touches[1]);
      pinch = { dist: d, cell: curCell() };
      e.preventDefault();
      return;
    }
    if (e.touches.length !== 1) return;
    // 双指刚结束时残留的一指，忽略（等所有指头抬起再重新开始单指）
    if (pinch) return;
    const t = e.touches[0];
    onPointerDown(t.clientX, t.clientY, 0);
    if (!pointer) return;
    // 启动长按计时（仅当起点在格子上）
    const idx = pointer.cellIdx;
    if (idx >= 0) {
      pointer.longTimer = setTimeout(() => {
        if (!pointer) return;
        pointer.longFired = true;
        // 长按 = 右键插旗
        rightClick(idx);
        render();
      }, LONG_PRESS_MS);
    }
  }, { passive: false });
  viewportEl.addEventListener("touchmove", (e) => {
    if (pinch && e.touches.length === 2) {
      // 双指缩放：按距离比值缩放每格像素，固定视口中心
      const d = pinchDist(e.touches[0], e.touches[1]);
      if (pinch.dist > 0 && d > 0) {
        const ratio = d / pinch.dist;
        const targetCell = Math.round(pinch.cell * ratio);
        const delta = targetCell - curCell();
        if (delta !== 0) {
          zoomBy(delta);
          // 更新基准，避免累积误差
          pinch.dist = d;
          pinch.cell = curCell();
        }
      }
      e.preventDefault();
      return;
    }
    if (!pointer || e.touches.length !== 1) return;
    const t = e.touches[0];
    onPointerMove(t.clientX, t.clientY);
    // 平移中阻止默认（避免页面滚动）
    if (pointer.panning) e.preventDefault();
  }, { passive: false });
  viewportEl.addEventListener("touchend", (e) => {
    if (pinch) {
      // 双指期间或刚结束：等所有指头抬起才清掉 pinch
      if (e.touches.length === 0) pinch = null;
      return;
    }
    if (!pointer) return;
    const consumed = onPointerUp();
    if (consumed) suppressClick = true;
    else suppressClick = false;
  });
  viewportEl.addEventListener("touchcancel", () => {
    if (pointer && pointer.longTimer) { clearTimeout(pointer.longTimer); pointer.longTimer = null; }
    pointer = null;
    pinch = null;
    viewportEl.classList.remove("panning");
  });

  // 旗帜条
  flagbar.addEventListener("click", (e) => {
    const btn = e.target.closest(".flagbtn");
    if (!btn) return;
    selectedFlag = +btn.dataset.flag;
    for (const b of flagbar.querySelectorAll(".flagbtn")) {
      b.classList.toggle("active", +b.dataset.flag === selectedFlag);
    }
  });

  // 键盘：1/2/3/4 切换插旗模式，0/Escape 切回揭开模式，+/- 缩放
  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
    // Esc：退出全屏
    if (e.key === "Escape" && isFullscreen) {
      toggleFullscreen();
      e.preventDefault();
      return;
    }
    // f：切换全屏
    if (e.key === "f" || e.key === "F") {
      toggleFullscreen();
      e.preventDefault();
      return;
    }
    if (e.key === "+" || e.key === "=") { zoomBy(4); e.preventDefault(); return; }
    if (e.key === "-" || e.key === "_") { zoomBy(-4); e.preventDefault(); return; }
    const map = { "1": 1, "2": 2, "3": 3, "4": 4, "0": 0, "Escape": 0 };
    if (e.key in map) {
      selectedFlag = map[e.key];
      for (const b of flagbar.querySelectorAll(".flagbtn")) {
        b.classList.toggle("active", +b.dataset.flag === selectedFlag);
      }
      e.preventDefault();
    }
  });

  // 缩放按钮 & 窗口缩放
  zoomInBtn.addEventListener("click", () => zoomBy(4));
  zoomOutBtn.addEventListener("click", () => zoomBy(-4));
  zoomResetBtn.addEventListener("click", resetZoom);
  fullscreenBtn.addEventListener("click", toggleFullscreen);
  // Ctrl/⌘ + 滚轮 = 缩放
  viewportEl.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 4 : -4);
  }, { passive: false });
  let resizeRaf = 0;
  window.addEventListener("resize", () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      fitBoard();
      render();
    });
  });
  // 屏幕方向变化也触发重排
  window.addEventListener("orientationchange", () => setTimeout(fitBoard, 200));

  // 脸按钮 / 新开 / 种子
  faceBtn.addEventListener("click", newGame);
  document.getElementById("newGame").addEventListener("click", newGame);
  document.getElementById("randomSeed").addEventListener("click", () => {
    seedInput.value = randSeed();
    newGame();
  });
  presetSel.addEventListener("change", newGame);
  seedInput.addEventListener("change", newGame);
  seedInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { newGame(); e.preventDefault(); } });

  function resolveSeed() {
    const v = seedInput.value.trim();
    if (v === "") return randSeed();
    const n = parseInt(v, 10);
    if (isNaN(n)) return randSeed();
    return n >>> 0;
  }

  function newGame() {
    const p = PRESETS[+presetSel.value];
    g.w = p.w; g.h = p.h; g.mines = p.mines;
    g.type_count = [0, 0, 0, 0, 0]; // 类型随机撒
    const seed = resolveSeed();
    g.newGame(seed); // 设置种子、清空、未开局（棋盘等首点生成）
    frozenTime = 0;
    stopTimer();
    buildGrid();
    // 新局：雷盘与视口大小相同（适配模式，无平移）
    resetZoom();
    render();
  }

  function startTimer() {
    stopTimer();
    timerHandle = setInterval(renderHud, 500);
  }
  function stopTimer() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  }

  // ---------------- 初始化 ----------------
  buildMineLeds();
  newGame();

  // 调试入口
  window.__game = g;
})();
