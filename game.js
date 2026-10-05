// 复扫雷 · 规则与状态。本文件是对原作 game.zig 的忠实 Web 移植，
// 不碰任何 DOM，方便单独自检。
// 原作（Zig + Win32 原生程序）：https://github.com/Yueqing-Chen/complexweeper-A-minesweeper-game
// 作者：青月晓（Yueqing-Chen）。本网页复刻遵循 GPL-3.0。

// 四种雷：(a,b) 分别是实部与虚部的贡献
const TYPES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// 只可能出现的 24 个显示值 D = |S|^2（平方模长，整数存储）
const ACHIEVABLE = [0, 1, 2, 4, 5, 8, 9, 10, 13, 16, 17, 18, 20, 25, 26, 29, 32, 34, 36, 37, 40, 49, 50, 64];

// 标准三档（类型随机撒）
const PRESETS = [
  { w: 9, h: 9, mines: 10, label: "初级 9×9 · 10 雷" },
  { w: 16, h: 16, mines: 40, label: "中级 16×16 · 40 雷" },
  { w: 22, h: 22, mines: 99, label: "高级 22×22 · 99 雷" },
];

// 状态行文字枚举（逻辑层只给枚举，文案在界面层）
const Msg = {
  none: 0, started: 1, judge_fail: 2, expand_ok: 3, win: 4, lose: 5, flag_misplaced: 6,
};

/// mulberry32：与原作完全一致，同种子同棋盘
class Rng {
  constructor(seed) { this.a = (seed === 0) ? 1 : (seed >>> 0); }
  next() {
    // a +%= 0x6D2B79F5
    this.a = (this.a + 0x6D2B79F5) >>> 0;
    let t = this.a >>> 0;
    // t = (t ^ (t >> 15)) *% (t | 1)
    t = (Math.imul((t ^ (t >>> 15)) | 0, (t | 1)) >>> 0);
    // t ^= t +% ((t ^ (t >> 7)) *% (t | 61))
    const inner = (Math.imul((t ^ (t >>> 7)) | 0, (t | 61)) >>> 0);
    t = ((t ^ ((t + inner) >>> 0)) >>> 0);
    // @floatFromInt((t ^ (t >> 14))) / 2^32
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296.0;
  }
  // [0, n) 的整数
  below(n) {
    if (n === 0) return 0;
    return Math.floor(this.next() * n);
  }
}

class Game {
  constructor() {
    this.w = 9;
    this.h = 9;
    this.n = 81;
    this.mine = [];     // 0 = 无雷，1..4 = 四种雷
    this.clue = [];     // 非雷格的 |S|^2；雷格为 -1
    this.open = [];     // 0/1 是否翻开
    this.flag = [];     // 0 = 无旗，1..4 = 四种旗
    this.seed = 1;
    this.rng = new Rng(1);
    this.mines = 10;
    this.type_total = [0, 0, 0, 0, 0]; // 下标 1..4，各类雷总数（开局公开）
    this.flags_of = [0, 0, 0, 0, 0];  // 当前插了各类旗几面
    this.type_count = [0, 0, 0, 0, 0]; // 自定义配比；全 0 表示"类型随机撒"
    this.started = false;
    this.over = false;
    this.win = false;
    this.boom = -1;
    this.start_cell = -1;
    this.elapsed_ms = 0;
    this.t0 = 0;
    this.moves = 0;
    this.msg = Msg.none;
    this.msg_arg = 0;
  }

  inb(r, c) { return r >= 0 && c >= 0 && r < this.h && c < this.w; }

  // 8 邻域，写到 buf 里，返回个数
  nbrs(cell, buf) {
    const w = this.w;
    const r = Math.floor(cell / w);
    const c = cell % w;
    let k = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= this.h || cc >= this.w) continue;
        buf[k++] = rr * w + cc;
      }
    }
    return k;
  }

  nbrMineCount(cell) {
    const buf = new Array(8);
    const k = this.nbrs(cell, buf);
    let n = 0;
    for (let i = 0; i < k; i++) if (this.mine[buf[i]] !== 0) n++;
    return n;
  }

  // 空白格：邻域一颗雷都没有。只有它会连片展开
  isBlank(cell) {
    return this.mine[cell] === 0 && this.nbrMineCount(cell) === 0;
  }

  flagsTotal() {
    let s = 0;
    for (let t = 1; t <= 4; t++) s += this.flags_of[t];
    return s;
  }

  // 该类雷还有几颗没标（可以是负数）
  unmarked(t) { return this.type_total[t] - this.flags_of[t]; }

  setMsg(m) { this.msg = m; this.msg_arg = 0; }

  // ---------------------------------------------------------------- 生成
  setSeed(s) {
    this.seed = (s === 0) ? 1 : (s >>> 0);
    this.rng = new Rng(this.seed);
  }

  // 新开一局（未开局状态，棋盘等第一次点击时再生成）
  newGame(seed) {
    this.n = this.w * this.h;
    this.mine = new Array(this.n).fill(0);
    this.clue = new Array(this.n).fill(-1);
    this.open = new Array(this.n).fill(0);
    this.flag = new Array(this.n).fill(0);
    this.started = false;
    this.over = false;
    this.win = false;
    this.boom = -1;
    this.start_cell = -1;
    this.elapsed_ms = 0;
    this.t0 = 0;
    this.moves = 0;
    this.type_total = [0, 0, 0, 0, 0];
    this.flags_of = [0, 0, 0, 0, 0];
    this.setSeed(seed);
    this.setMsg(Msg.none);
  }

  // 布雷 + 算显示值 + 从开局格连片。safe = 开局格及其（界内）8 邻居。
  genBoard(start_cell) {
    const N = this.n;
    for (let i = 0; i < N; i++) {
      this.mine[i] = 0;
      this.clue[i] = -1;
      this.open[i] = 0;
      // 注意：这里**不动 flag[]**。开局前插的旗要活过第一次左键
      // （传统扫雷就是这样）；清旗由 newGame() 负责。
    }
    const is_safe = new Array(N).fill(false);
    is_safe[start_cell] = true;
    const nbuf = new Array(8);
    const nk = this.nbrs(start_cell, nbuf);
    for (let i = 0; i < nk; i++) is_safe[nbuf[i]] = true;

    const pool = [];
    for (let i = 0; i < N; i++) if (!is_safe[i]) pool.push(i);
    const m = pool.length;

    // 洗位置
    for (let i = m - 1; i > 0; i--) {
      const j = this.rng.below(i + 1);
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }

    let want = 0;
    for (let t = 1; t <= 4; t++) want += this.type_count[t];
    const count = Math.min((want > 0) ? want : this.mines, m);

    if (want > 0) {
      // 精确配比：先铺类型序列，再洗一遍
      const list = [];
      for (let t = 1; t <= 4; t++) {
        for (let k = 0; k < this.type_count[t]; k++) list.push(t);
      }
      const ln = Math.min(list.length, count);
      for (let i = ln - 1; i > 0; i--) {
        const j = this.rng.below(i + 1);
        const t = list[i]; list[i] = list[j]; list[j] = t;
      }
      for (let k = 0; k < ln; k++) this.mine[pool[k]] = list[k];
    } else {
      for (let k = 0; k < count; k++) this.mine[pool[k]] = 1 + this.rng.below(4);
    }
    this.mines = count;
    this.computeClues();
    this.countTypes();
    // 这里既不碰 flag[] 也不碰 flags_of：开局前插的旗要留到开局之后。
    this.cascadeOpen([start_cell]);
  }

  computeClues() {
    for (let i = 0; i < this.n; i++) {
      if (this.mine[i] !== 0) { this.clue[i] = -1; continue; }
      let a = 0, b = 0;
      const buf = new Array(8);
      const k = this.nbrs(i, buf);
      for (let ii = 0; ii < k; ii++) {
        const j = buf[ii];
        if (this.mine[j] === 0) continue; // 跳过空邻居，否则 TYPES[-1] 越界
        const t = TYPES[this.mine[j] - 1];
        a += t[0]; b += t[1];
      }
      this.clue[i] = a * a + b * b;
    }
  }

  countTypes() {
    this.type_total = [0, 0, 0, 0, 0];
    for (let i = 0; i < this.n; i++) {
      if (this.mine[i] !== 0) this.type_total[this.mine[i]]++;
    }
  }

  // 连片翻开：只在空白格上继续扩散。返回新翻开的格数。
  cascadeOpen(seeds) {
    const stack = [];
    const queued = new Array(this.n).fill(false);
    for (const s of seeds) {
      if (!queued[s]) { queued[s] = true; stack.push(s); }
    }
    let opened = 0;
    while (stack.length > 0) {
      const i = stack.pop();
      // 连片也不碰插了旗的格子（旗子保护它，得玩家自己撤旗）
      if (this.open[i] !== 0 || this.mine[i] !== 0 || this.flag[i] !== 0) continue;
      this.open[i] = 1;
      opened++;
      if (this.isBlank(i)) {
        const buf = new Array(8);
        const k = this.nbrs(i, buf);
        for (let ii = 0; ii < k; ii++) {
          const j = buf[ii];
          // 查重标在压栈时
          if (!queued[j] && this.open[j] === 0 && this.mine[j] === 0 && this.flag[j] === 0) {
            queued[j] = true;
            stack.push(j);
          }
        }
      }
    }
    return opened;
  }

  // ---------------------------------------------------------------- 操作
  startAt(cell, now_ms) {
    this.setSeed(this.seed);
    this.genBoard(cell);
    this.start_cell = cell;
    this.started = true;
    this.over = false;
    this.win = false;
    this.elapsed_ms = 0;
    this.t0 = now_ms;
    this.moves = 1;
    this.setMsg(Msg.none);
  }

  // 插/改/清旗。旗帜不限量，永远成功
  setFlag(cell, t) {
    if (t > 4) return false;
    const old = this.flag[cell];
    if (old === t) return true;
    if (old !== 0) this.flags_of[old]--;
    this.flag[cell] = t;
    if (t !== 0) this.flags_of[t]++;
    return true;
  }

  // 右键循环：空 → +1 → −1 → +i → −i → 空
  cycleFlag(cell) {
    if (this.over || this.open[cell] !== 0) return false;
    const next = (this.flag[cell] + 1) % 5;
    this.setFlag(cell, next);
    this.moves++;
    return true;
  }

  // 翻开一格。插了旗的格子翻不开——要翻开得先把旗循环回"空"。
  reveal(cell, now_ms) {
    if (this.over || this.open[cell] !== 0 || this.flag[cell] !== 0) return;
    if (this.mine[cell] !== 0) { this.open[cell] = 1; this.lose(cell); return; }
    this.open[cell] = 1;
    if (this.isBlank(cell)) {
      const buf = new Array(8);
      const k = this.nbrs(cell, buf);
      this.cascadeOpen(buf.slice(0, k));
    }
    this.moves++;
    this.checkWin();
  }

  // 组合匹配（严档，现行默认）：旗帜总数 = 邻域真实雷总数，
  // 且实/虚旗数与真实实/虚雷数一致（顺序不限，即真实比例或其倒数）
  matchComboTruth(cell) {
    const truth = [0, 0, 0, 0];
    const got = [0, 0, 0, 0];
    const buf = new Array(8);
    const k = this.nbrs(cell, buf);
    for (let i = 0; i < k; i++) {
      const j = buf[i];
      if (this.mine[j] !== 0) truth[this.mine[j] - 1]++;
      if (this.flag[j] !== 0) got[this.flag[j] - 1]++;
    }
    const P = truth[0] + truth[1]; // 真实实雷数
    const V = truth[2] + truth[3]; // 真实虚雷数
    const gp = got[0] + got[1];    // 实旗数
    const gv = got[2] + got[3];    // 虚旗数
    return (gp + gv === P + V) && ((gp === P && gv === V) || (gp === V && gv === P));
  }

  // 位置校验：邻域内每面旗都必须插在真实雷格上。
  // 任一旗插在非雷格上 → 返回 false（插错位置，不展开以免踩雷）。
  flagsOnMines(cell) {
    const buf = new Array(8);
    const k = this.nbrs(cell, buf);
    for (let i = 0; i < k; i++) {
      const j = buf[i];
      if (this.flag[j] !== 0 && this.mine[j] === 0) return false;
    }
    return true;
  }

  // 双击展开：位置 + 数量 + 比例 判据全通过才翻开周围未插旗格。
  // 判据全通过时所有真实雷格都已被正确插旗，uns 中无雷，安全展开。
  tryExpand(cell) {
    if (this.over || this.open[cell] === 0 || this.mine[cell] !== 0) return;
    const buf = new Array(8);
    const k = this.nbrs(cell, buf);
    const uns = [];
    for (let i = 0; i < k; i++) {
      const j = buf[i];
      if (this.open[j] === 0 && this.flag[j] === 0) uns.push(j);
    }
    if (uns.length === 0) return;
    if (!this.flagsOnMines(cell)) { this.setMsg(Msg.flag_misplaced); return; }
    if (!this.matchComboTruth(cell)) { this.setMsg(Msg.judge_fail); return; }
    this.cascadeOpen(uns);
    this.moves++;
    this.setMsg(Msg.expand_ok);
    this.msg_arg = uns.length;
    this.checkWin();
  }

  checkWin() {
    for (let i = 0; i < this.n; i++) {
      if (this.mine[i] === 0 && this.open[i] === 0) return;
    }
    this.over = true;
    this.win = true;
    this.setMsg(Msg.win);
  }

  lose(cell) {
    this.over = true;
    this.win = false;
    this.boom = cell;
    this.setMsg(Msg.lose);
  }

  openedCount() {
    let k = 0;
    for (let i = 0; i < this.n; i++) if (this.open[i] !== 0) k++;
    return k;
  }
  safeCount() {
    let k = 0;
    for (let i = 0; i < this.n; i++) if (this.mine[i] === 0) k++;
    return k;
  }
}

// 把总数尽量均匀分给四种雷（自定义对话框的预填值）
function splitEvenly(total) {
  const out = [0, 0, 0, 0, 0];
  const base = Math.floor(total / 4);
  let rest = total - base * 4;
  for (let t = 1; t <= 4; t++) {
    out[t] = base;
    if (rest > 0) { out[t]++; rest--; }
  }
  return out;
}

// 平方模长 D → 显示文字（不含空白格的情况）
const D_LABEL = {
  0: "0", 1: "1", 2: "√2", 4: "2", 5: "√5", 8: "2√2", 9: "3", 10: "√10",
  13: "√13", 16: "4", 17: "√17", 18: "3√2", 20: "2√5", 25: "5",
  26: "√26", 29: "√29", 32: "4√2", 34: "√34", 36: "6", 37: "√37",
  40: "2√10", 49: "7", 50: "5√2", 64: "8",
};

// 导出
window.Complexweeper = { Game, Rng, Msg, TYPES, ACHIEVABLE, PRESETS, splitEvenly, D_LABEL };
