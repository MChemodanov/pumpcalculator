// Калькулятор грунтонасоса земснаряда — Nonius
// Расчётный движок: Юфин, Шкундин, Огородников; критика — Durand-Condolios.

"use strict";

const G = 9.81;
const RHO_W = 1000;            // кг/м³ — вода
const NU = 1.0e-6;             // м²/с — кинем. вязкость воды
const P_ATM = 101325;          // Па
const P_VAP = 2340;            // Па (вода ~20°C)

// ---- Пресеты насосов (загружаются из presets/*.json) ----
const PUMP_PRESETS = {
  custom: {
    name: "Своё значение",
    label: "— свои значения",
    descr: "Параметры заполняются вручную. Пресет переходит в «свои значения» при любой правке поля насоса.",
    H_note: "Введите паспортный напор насоса в рабочей точке. Типовые значения для грунтонасосов: 30–90 м.",
    N_note: "Введите максимальную мощность на валу по паспорту. Типовые значения: 200–2000 кВт.",
    src: "Паспорт насоса.",
  },
};

async function loadPumpPresets() {
  try {
    const idx = await fetch("presets/index.json").then(r => r.json());
    for (const id of idx.presets) {
      try {
        PUMP_PRESETS[id] = await fetch(`presets/${id}.json`).then(r => r.json());
      } catch (e) { console.warn(`Не загружен пресет ${id}:`, e); }
    }
    return idx.default || "custom";
  } catch (e) {
    console.warn("Пресеты не загружены (работаем с custom):", e);
    return "custom";
  }
}

function populatePresetSelect(defaultId) {
  const sel = document.getElementById("preset");
  if (!sel) return;
  // Сохраняем порядок: сперва из presets/index.json, потом custom
  const ids = Object.keys(PUMP_PRESETS).filter(id => id !== "custom").concat(["custom"]);
  sel.innerHTML = ids.map(id => {
    const p = PUMP_PRESETS[id];
    return `<option value="${id}">${p.label || p.name || id}</option>`;
  }).join("");
  sel.value = defaultId;
}

function currentPresetId() {
  const sel = document.getElementById("preset");
  return sel ? sel.value : "custom";
}
function currentPreset() { return PUMP_PRESETS[currentPresetId()] || PUMP_PRESETS.custom; }

// ---- Грунтовые предустановки по категориям (ориентировочно) ----
const SOILS = {
  "I":   { d50: 0.10, label: "I — илы, торф" },
  "II":  { d50: 0.30, label: "II — пески мелкие/средние" },
  "III": { d50: 1.00, label: "III — пески крупные, супесь" },
  "IV":  { d50: 3.00, label: "IV — суглинки, гравелистые пески" },
  "V":   { d50: 8.00, label: "V — глины, гравий до 40 мм" },
  "VI":  { d50: 20.0, label: "VI — плотные глины, галечник" },
};

// ---- Локальные коэффициенты сопротивления ----
const XI = {
  bend90: 0.7,    // отвод 90° R/D≈1
  bend45: 0.35,
  dead:   1.5,    // глухой отвод (Т-образный с заглушкой)
  inlet:  0.5,    // вход в приёмное устройство
  outlet: 1.0,    // выход из трубы
};

// ---- Считывание входов ----
function readInputs() {
  const $ = id => document.getElementById(id);
  const seg = name => document.querySelector(`.seg[data-bind="${name}"] button.active`).dataset.val;
  return {
    pumpType:  seg("pumpType"),
    discharge: seg("discharge"),
    axisDepth: +$("axisDepth").value || 0,
    Lframe:    +$("Lframe").value || 14.14,
    Q:    +$("Q").value,
    H:    +$("H").value,
    N:    +$("N").value,
    eta:  +$("eta").value,
    etaGear: +$("etaGear").value,
    NPSHr: +$("NPSHr").value || 4,
    dIn:  +$("dIn").value / 1000,
    dOut: +$("dOut").value / 1000,
    L:    +$("L").value,
    Dpipe:+$("Dpipe").value / 1000,
    nB90: +$("nB90").value,
    nB45: +$("nB45").value,
    nDead:+$("nDead").value,
    hLift:+$("hLift").value,
    rough:+$("rough").value / 1000,
    depth:+$("depth").value,
    soil: $("soil").value,
    d50:  +$("d50").value / 1000,   // в метрах
    rhoS: +$("rhoS").value,
    kr:   +$("kr").value,
    hLayer: +$("hLayer").value,
    kUtil:  +$("kUtil").value,
    S:    +$("S").value / 100,
  };
}

// ---- Гидравлика ----
function area(D) { return Math.PI * D * D / 4; }

function reynolds(v, D) { return v * D / NU; }

// Альтшуль (используется в отечественной практике)
function lambdaAltshul(Re, D, k) {
  if (Re < 2300) return 64 / Math.max(Re, 1);
  return 0.11 * Math.pow(k / D + 68 / Re, 0.25);
}

// F_L по Durand (без поправки на S)
function FLcoef(d50) {
  const d50mm = d50 * 1000;
  if (d50mm < 0.1) return 0.6;
  if (d50mm < 0.5) return 0.6 + (1.34 - 0.6) * (d50mm - 0.1) / 0.4;
  if (d50mm <= 2.0) return 1.34;
  if (d50mm <= 25)  return 1.34 - 0.18 * Math.log10(d50mm / 2.0);
  return 1.0;
}

// Коэффициент Шкундина для пульпы по крупности
function kgrCoef(d50) {
  const d50mm = d50 * 1000;
  if (d50mm <= 0.10) return 1.2;
  if (d50mm <= 0.25) return 1.5;
  if (d50mm <= 1.0)  return 2.0;
  if (d50mm <= 5.0)  return 2.5;
  return 3.0;
}

// Критическая скорость (Durand-Юфин)
function vCrit(D, d50, S, rhoS) {
  const s = rhoS / RHO_W;
  const FL = FLcoef(d50) * (1 + 0.6 * Math.min(S, 0.30));
  return FL * Math.sqrt(2 * G * D * (s - 1));
}

// Потери водяного потока в пульпопроводе.
// opts.inlet — учитывать ξ входа (для всасывающей линии),
// opts.outlet — учитывать ξ выхода (для напорной линии).
function lossesWater(v, D, L, n90, n45, ndead, k, opts = {}) {
  const Re = reynolds(v, D);
  const lam = lambdaAltshul(Re, D, k);
  const head = v * v / (2 * G);
  const linear = lam * L / D * head;
  let xiSum = XI.bend90 * n90 + XI.bend45 * n45 + XI.dead * ndead;
  if (opts.inlet)  xiSum += XI.inlet;
  if (opts.outlet) xiSum += XI.outlet;
  const local = xiSum * head;
  return { linear, local, total: linear + local, lam, Re, xiSum };
}

// Поправка на пульпу (Шкундин, упрощённая):
//   i_m / i_в = 1 + k_гр · (ρ_п − ρ_в)/ρ_в
function slurryFactor(v, D, S, rhoS, d50) {
  const rhoPulp = RHO_W + S * (rhoS - RHO_W);
  return 1 + kgrCoef(d50) * (rhoPulp - RHO_W) / RHO_W;
}

// Высотный (геометрический) напор от уровня воды до сброса.
// Глубина разработки в установившемся режиме на статический напор не влияет —
// она лимитирует кавитацию (NPSH), что учитывается отдельно.
function staticHead(inp) {
  return Math.max(0, inp.hLift);
}

// Доступный напор насоса в метрах пульпы (поправка HR на крупность и S)
function headRatio(d50, S) {
  const d50mm = d50 * 1000;
  // Эмпирически: для тонкого песка ≈1, для крупных частиц/высокой S — снижение
  const HR = 1 - 0.0004 * d50mm * 100 * S; // ~1 при d=0.5 мм и S=15% → 0.997
  return Math.max(0.80, Math.min(1.0, HR));
}

// NPSH-проверка для палубного насоса:
//   NPSH_дост = (P_атм − P_насыщ)/(ρg) − h_всас − Δh_трен − v²/2g
//   условие: NPSH_дост ≥ NPSH_доп (паспортный кав. запас)
function suctionCheck(inp, vSuction, lossesSuction) {
  const liftMax = (P_ATM - P_VAP) / (RHO_W * G); // ≈10.1 м
  const NPSHr = Math.max(0, inp.NPSHr || 4);
  const requiredLift = inp.depth + lossesSuction + vSuction*vSuction/(2*G) + NPSHr;
  return { liftMax, requiredLift, ok: requiredLift <= liftMax, NPSHr };
}

// ---- Главный расчёт для одной точки S ----
function computeAt(inp, S) {
  // В режиме «в шаланду» длина пульпопровода и высота подъёма заменяются
  // на короткие фиксированные значения (труба идёт в борт шаланды рядом),
  // но колена и глухие отводы из ввода сохраняются.
  const isBarge = inp.discharge === "barge";
  const Leff = isBarge ? 20 : inp.L;
  const hLiftEff = isBarge ? 1.0 : inp.hLift;

  const A = area(inp.Dpipe);
  const v = (inp.Q / 3600) / A;
  const rhoPulp = RHO_W + S * (inp.rhoS - RHO_W);
  const Cm = (inp.rhoS > 0) ? S * inp.rhoS / rhoPulp : 0;
  const vcr = vCrit(inp.Dpipe, inp.d50, S, inp.rhoS);

  const lossesW = lossesWater(v, inp.Dpipe, Leff, inp.nB90, inp.nB45, inp.nDead, inp.rough, { outlet: true });
  const sf = slurryFactor(v, inp.Dpipe, S, inp.rhoS, inp.d50);
  const lossPulpM = lossesW.total * sf;             // м столба пульпы

  // Всас: длина и колена зависят от типа насоса
  const vSuc = (inp.Q / 3600) / area(inp.dIn);
  const isSub = inp.pumpType === "submerged";
  const sucLen = isSub ? 2.0 : (inp.depth + 3.0);
  const sucBends = isSub ? 1 : 2;
  const lossSucW = lossesWater(vSuc, inp.dIn, sucLen, sucBends, 0, 0, inp.rough, { inlet: true });
  const lossSucPulp = lossSucW.total * sf;

  const hStat = Math.max(0, hLiftEff);
  const Hreq = hStat + lossPulpM + lossSucPulp;
  const HR = headRatio(inp.d50, S);
  const Havail = inp.H * HR;

  const Nreq = rhoPulp * G * (inp.Q / 3600) * Hreq / (inp.eta * 1000);   // мощность на валу
  const Neng = Nreq / Math.max(0.1, inp.etaGear);                         // мощность от двигателя

  // Геометрия рамы (ось вращения принимаем на уровне воды)
  const Lf = Math.max(0.1, inp.Lframe);
  const sinA = Math.min(1, Math.max(0, inp.depth) / Lf);
  const frameAlpha = Math.asin(sinA);             // рад
  const pumpDepth = inp.axisDepth * sinA;         // фактическая глубина насоса под водой
  const frameReachable = inp.depth <= Lf;
  const frame = { Lf, sinA, alpha: frameAlpha, pumpDepth, reachable: frameReachable };
  const Qsolid = inp.Q * S;
  const Qbulk = Qsolid * inp.kr;
  const Qop   = Qbulk * inp.kUtil;          // эксплуатационная (с учётом простоев)

  // NPSH
  let npsh = null;
  if (inp.pumpType === "surface") {
    npsh = suctionCheck(inp, vSuc, lossSucW.total);
  }

  return {
    v, vcr, rhoPulp, Cm, sf, lossesW, lossSucW, lossPulpM, lossSucPulp,
    vSuc, sucLen, sucBends, Hreq, Havail, HR, Nreq, Neng, Qsolid, Qbulk, Qop,
    hStat, npsh, Leff, hLiftEff, isBarge, frame,
  };
}

// ---- Поиск допустимого диапазона S ----
function feasibleRange(inp) {
  // S_min: концентрация, при которой v >= v_крит (запас 10%). Если уже да при S=0 — то S_min=0.01.
  // S_max: минимум из (Hreq=Havail), (Nreq=N), 0.35.
  const Smin = 0.01;
  const Smax = 0.35;
  let sMinOk = null, sMaxOk = null;

  for (let s = Smin; s <= Smax + 1e-9; s += 0.005) {
    const r = computeAt(inp, s);
    const vOK = r.v >= 1.1 * r.vcr;
    const hOK = r.Hreq <= r.Havail;
    const nOK = r.Nreq <= inp.N;
    const allOK = vOK && hOK && nOK;
    if (allOK && sMinOk === null) sMinOk = s;
    if (allOK) sMaxOk = s;
  }
  return { sMinOk, sMaxOk };
}

// ---- Форматирование ----
const fmt = (x, n=2) => (isFinite(x) ? x.toFixed(n) : "—");
const fmtPct = (x, n=1) => (isFinite(x) ? (x*100).toFixed(n) : "—");

// ---- Описания формул для tooltip ----
// Каждая запись:
//   title — заголовок
//   tex   — общая формула (KaTeX)
//   subst — функция (inp, r, range) → LaTeX-строка с подставленными значениями
//   src   — источник
const fL = (x, n=2) => {
  if (!isFinite(x)) return "—";
  let s = x.toFixed(n);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
};
const FORMULAS = {
  velocity: {
    title: "Скорость потока в трубе",
    tex: "v = \\dfrac{Q}{3600 \\cdot \\pi D^{2}/4}",
    subst: (i, r) => {
      const A = Math.PI * i.Dpipe * i.Dpipe / 4;
      return `v = \\dfrac{${i.Q}}{3600 \\cdot \\pi \\cdot ${fL(i.Dpipe,3)}^{2}/4} = \\dfrac{${i.Q}}{${fL(3600*A,1)}} = ${fL(r.v,2)}\\;\\text{м/с}`;
    },
    src: "Шкундин Б.М. Землесосные снаряды, §3.",
  },
  vcrit: {
    title: "Критическая скорость",
    tex: "v_{\\text{кр}} = F_L \\sqrt{2 g D \\,(s-1)}, \\quad s = \\rho_T/\\rho_В",
    subst: (i, r) => {
      const s = i.rhoS / RHO_W;
      const FL = FLcoef(i.d50) * (1 + 0.6 * Math.min(i.S, 0.30));
      return `F_L = ${fL(FLcoef(i.d50),2)} \\cdot (1 + 0.6 \\cdot ${fL(i.S,2)}) = ${fL(FL,3)}\\\\` +
             `v_{кр} = ${fL(FL,3)} \\cdot \\sqrt{2 \\cdot 9.81 \\cdot ${fL(i.Dpipe,3)} \\cdot (${fL(s,2)} - 1)} = ${fL(r.vcr,2)}\\;\\text{м/с}`;
    },
    src: "Юфин А.П. Гидромеханизация, гл. IV (Durand–Condolios с поправкой по S и d₅₀).",
  },
  density: {
    title: "Плотность пульпы",
    tex: "\\rho_{п} = \\rho_В + S\\,(\\rho_T - \\rho_В)",
    subst: (i, r) =>
      `\\rho_п = 1000 + ${fL(i.S,3)} \\cdot (${i.rhoS} - 1000) = ${fL(r.rhoPulp,0)}\\;\\text{кг/м}^3`,
    src: "Огородников С.П., 1986, §2.1.",
  },
  concMass: {
    title: "Массовая концентрация",
    tex: "C_m = \\dfrac{S \\,\\rho_T}{\\rho_{п}}",
    subst: (i, r) =>
      `C_m = \\dfrac{${fL(i.S,3)} \\cdot ${i.rhoS}}{${fL(r.rhoPulp,0)}} = ${fL(r.Cm,3)} = ${fL(r.Cm*100,1)}\\%`,
    src: "Юфин А.П., гл. III.",
  },
  qBulk: {
    title: "Производительность по разрыхлённому грунту",
    tex: "Q_{гр} = Q \\cdot S \\cdot k_{р}",
    subst: (i, r) =>
      `Q_{гр} = ${i.Q} \\cdot ${fL(i.S,3)} \\cdot ${fL(i.kr,2)} = ${fL(r.Qbulk,0)}\\;\\text{м}^3/\\text{ч}`,
    src: "СП 81.13330; Огородников, табл. 1.2.",
  },
  lossesPipe: {
    title: "Потери напора в напорной линии",
    tex: "\\Delta h_{нагн} = \\left(\\lambda \\dfrac{L}{D} + \\sum \\xi\\right) \\dfrac{v^{2}}{2g} \\cdot \\mathrm{SF}",
    subst: (i, r) => {
      const head = r.v * r.v / (2 * G);
      return `\\Delta h_в = \\left(${fL(r.lossesW.lam,4)} \\cdot \\dfrac{${r.Leff}}{${fL(i.Dpipe,3)}} + ${fL(r.lossesW.xiSum,2)}\\right) \\cdot ${fL(head,3)} = ${fL(r.lossesW.total,2)}\\;\\text{м вод. ст.}\\\\` +
             `\\Delta h_{нагн} = ${fL(r.lossesW.total,2)} \\cdot ${fL(r.sf,3)} = ${fL(r.lossPulpM,2)}\\;\\text{м}`;
    },
    src: "Альтшуль А.Д.; Шкундин §3.5. λ — формула Альтшуля.",
  },
  lossesSuc: {
    title: "Потери напора во всасе",
    tex: "\\Delta h_{всас} = \\left(\\lambda \\dfrac{L_{вс}}{D_{вс}} + \\sum \\xi\\right) \\dfrac{v_{вс}^{2}}{2g} \\cdot \\mathrm{SF}",
    subst: (i, r) => {
      const head = r.vSuc * r.vSuc / (2 * G);
      return `\\Delta h_в = \\left(${fL(r.lossSucW.lam,4)} \\cdot \\dfrac{${fL(r.sucLen,1)}}{${fL(i.dIn,3)}} + ${fL(r.lossSucW.xiSum,2)}\\right) \\cdot ${fL(head,3)} = ${fL(r.lossSucW.total,2)}\\;\\text{м}\\\\` +
             `\\Delta h_{всас} = ${fL(r.lossSucW.total,2)} \\cdot ${fL(r.sf,3)} = ${fL(r.lossSucPulp,2)}\\;\\text{м}`;
    },
    src: "Длина всаса для погружного — 2 м, для палубного — глубина+3 м.",
  },
  slurry: {
    title: "Поправка на пульпу",
    tex: "\\dfrac{i_m}{i_в} = 1 + k_{гр} \\cdot \\dfrac{\\rho_п - \\rho_в}{\\rho_в}",
    subst: (i, r) =>
      `\\dfrac{i_m}{i_в} = 1 + ${fL(kgrCoef(i.d50),1)} \\cdot \\dfrac{${fL(r.rhoPulp,0)} - 1000}{1000} = ${fL(r.sf,3)}`,
    src: "Шкундин §3.6 (упрощённая); k_гр=1.2…3.0 по крупности d₅₀.",
  },
  hreq: {
    title: "Требуемый напор",
    tex: "H_{\\text{тр}} = H_{\\text{гео}} + \\Delta h_{нагн} + \\Delta h_{всас}",
    subst: (i, r) =>
      `H_{тр} = ${fL(r.hStat,2)} + ${fL(r.lossPulpM,2)} + ${fL(r.lossSucPulp,2)} = ${fL(r.Hreq,2)}\\;\\text{м}`,
    src: "Юфин, §V.2." + " В режиме «в шаланду» L=20 м, h<sub>под</sub>=1 м.",
  },
  havail: {
    title: "Развиваемый напор по пульпе",
    tex: "H_{\\text{нас}} = H_В \\cdot \\mathrm{HR}(d_{50}, S)",
    subst: (i, r) =>
      `H_{нас} = ${i.H} \\cdot ${fL(r.HR,4)} = ${fL(r.Havail,2)}\\;\\text{м}`,
    src: "Шкундин, §4.3 (HR — снижение напора при работе на пульпе).",
  },
  power: {
    title: "Мощность на валу",
    tex: "N = \\dfrac{\\rho_{п}\\, g\\, Q\\, H_{\\text{тр}}}{3600 \\cdot \\eta \\cdot 1000}",
    subst: (i, r) =>
      `N = \\dfrac{${fL(r.rhoPulp,0)} \\cdot 9.81 \\cdot ${i.Q} \\cdot ${fL(r.Hreq,2)}}{3600 \\cdot ${i.eta} \\cdot 1000} = ${fL(r.Nreq,1)}\\;\\text{кВт}`,
    src: "Шкундин, §4.4; в кВт при Q в м³/ч и H в м.",
  },
  npsh: {
    title: "Высота всасывания (палубный насос)",
    tex: "H_{вс,\\text{доп}} = \\dfrac{P_{атм}-P_{п}}{\\rho g} - h_{вс} - \\Delta h_{вс} - \\dfrac{v^{2}}{2g} - \\Delta_{зап}",
    subst: (i, r) => r.npsh
      ? `\\text{треб.} = ${fL(r.npsh.requiredLift,2)}\\;\\text{м} \\;\\;\\le\\;\\; \\text{лимит} = ${fL(r.npsh.liftMax,2)}\\;\\text{м}`
      : `\\text{не применимо: насос погружной}`,
    src: "Юфин, гл. V.",
  },
  range: {
    title: "Допустимый диапазон концентраций",
    tex: "S \\in [S_{\\min},\\, S_{\\max}]",
    subst: (i, r, range) => {
      if (!range || range.sMinOk === null) return `\\text{диапазон не найден}`;
      return `S \\in [${fL(range.sMinOk*100,1)}\\%,\\; ${fL(range.sMaxOk*100,1)}\\%]\\\\` +
             `\\text{при текущем } S = ${fL(i.S*100,1)}\\%`;
    },
    src: "Из условий: v ≥ 1.1·v_кр, N_тр ≤ N_прив, H_тр ≤ H_нас.",
  },
  qOper: {
    title: "Эксплуатационная производительность",
    tex: "Q_{оп} = Q \\cdot S \\cdot k_{р} \\cdot k_{исп}",
    subst: (i, r) =>
      `Q_{оп} = ${i.Q} \\cdot ${fL(i.S,3)} \\cdot ${fL(i.kr,2)} \\cdot ${fL(i.kUtil,2)} = ${fL(r.Qop,0)}\\;\\text{м}^3/\\text{ч}`,
    src: "Огородников С.П., 1986, §7.3; Шкундин §6 (учёт простоев на перестановки свай, развороты).",
  },
  hLayer: {
    title: "Толщина слоя выработки (hₛₗ)",
    note:
      `Толщина срезаемого слоя грунта за проход фрезы/папильонажа. ` +
      `Влияет на режим работы фрезы и распределение энергии. ` +
      `Рекомендуемые значения по грунту:<br>` +
      `• илы, торф, рыхлые: <b>1.0–2.0 м</b><br>` +
      `• пески мелкие/средние: <b>0.3–1.0 м</b> (опт. <b>0.5 м</b>)<br>` +
      `• пески крупные, супесь: <b>0.3–0.6 м</b><br>` +
      `• суглинки, глины: <b>0.2–0.5 м</b><br>` +
      `• гравий, галечник: <b>0.15–0.30 м</b><br>` +
      `Слишком тонкий слой — низкая загрузка фрезы; слишком толстый — стопор привода.`,
    src: "Огородников С.П., 1986, табл. 3.5; Шкундин Б.М., §5.2; СП 81.13330 (СНиП IV-2-82).",
  },
  kUtil: {
    title: "Коэффициент использования времени (kₘₛₚ)",
    note:
      `Доля производительного времени за рабочую смену. ` +
      `Учитывает перестановки на сваях, развороты, мелкие простои/отказы. ` +
      `Рекомендуемые значения:<br>` +
      `• земснаряд на сваях, средние условия: <b>0.70–0.85</b> (типично <b>0.75</b>)<br>` +
      `• частые перестановки свай (узкая проходка, тяжёлый грунт): <b>0.60–0.70</b><br>` +
      `• работа на якорях/тросах, минимум простоев: <b>0.85–0.92</b><br>` +
      `• первые часы пуска, наладка: <b>0.40–0.60</b><br>` +
      `Не включает плановое ТО и переходы между объектами.`,
    src: "Шкундин Б.М. §6 (баланс времени); Огородников С.П. гл. 7; ВСН 32-89 (укрупнённые нормативы).",
  },
  Lframe: {
    title: "Длина рамы (L_рамы)",
    note:
      `Конструктивная (фиксированная) длина подвижной рамы от оси вращения до фрезы. ` +
      `Связывает глубину разработки с углом наклона рамы:<br>` +
      `<b>sin α = h<sub>разработки</sub> / L<sub>рамы</sub></b> (при оси на уровне воды).<br>` +
      `Дефолт <b>14.14 м</b> подобран так, чтобы при глубине <b>10 м</b> рама была под углом <b>45°</b>. ` +
      `Максимальная глубина разработки ≈ длина рамы.<br>` +
      `Типовые значения по классу земснаряда:<br>` +
      `• малый CSD: <b>8–12 м</b><br>` +
      `• средний CSD: <b>14–18 м</b><br>` +
      `• крупный: <b>20–30 м</b>`,
    src: "Конструктивные характеристики дредж-земснарядов; типовые проекты CSD.",
  },
  axisDepth: {
    title: "Положение насоса по раме (от оси)",
    note:
      `Слантовое расстояние от оси вращения рамы до места установки погружного насоса, ` +
      `<b>вдоль рамы</b> (не вертикально). Фиксируется по паспорту земснаряда — точка крепления насоса.<br>` +
      `Дефолт <b>7.07 м</b> = середина рамы при L=14.14 м.<br>` +
      `<b>Фактическая глубина насоса под водой</b> = axisDepth · sin(α), где α — угол наклона рамы. ` +
      `См. отдельную ячейку в результатах.`,
    src: "Паспорт земснаряда / спецификация установки погружного агрегата.",
  },
  pumpDepth: {
    title: "Фактическая глубина насоса под водой",
    tex: "h_{нас} = \\ell_{ось→нас} \\cdot \\sin\\alpha, \\quad \\sin\\alpha = h_{разр}/L_{рамы}",
    subst: (i, r) =>
      `\\sin\\alpha = ${i.depth}/${fL(i.Lframe,2)} = ${fL(r.frame.sinA,3)},\\;\\alpha = ${fL(r.frame.alpha*180/Math.PI,1)}°\\\\` +
      `h_{нас} = ${fL(i.axisDepth,2)} \\cdot ${fL(r.frame.sinA,3)} = ${fL(r.frame.pumpDepth,2)}\\;\\text{м}`,
    src: "Геометрия рамы при оси вращения на уровне воды.",
  },
  preset: {
    title: "Пресет насоса",
    note: () => {
      const p = currentPreset();
      return `<b>${p.name}</b><br>${p.descr}<br><br>` +
             `Выбор пресета заполняет все поля параметров насоса значениями из паспорта. ` +
             `Любая правка поля переключает пресет в режим «свои значения».`;
    },
    src: () => currentPreset().src,
  },
  H: {
    title: "Напор насоса по воде",
    note: () =>
      `${currentPreset().H_note || ""}<br><br>` +
      `На пульпе фактический развиваемый напор снижается множителем HR (см. отдельный tooltip).`,
    src: () => currentPreset().src,
  },
  N: {
    title: "Мощность на валу насоса",
    note: () =>
      `${currentPreset().N_note || ""}<br><br>` +
      `Это лимит, который пульпа не должна превышать. Если используется редуктор — ` +
      `мощность от двигателя выше на 1/η<sub>ред</sub> (см. ячейку «Мощность от двигателя»).`,
    src: () => currentPreset().src,
  },
  NPSHr: {
    title: "Допустимый кавитационный запас (NPSH_r)",
    note: () => {
      const p = currentPreset();
      const presetVal = p.params && p.params.NPSHr ? `<b>${p.params.NPSHr} м</b> — паспортное значение для ${p.name}.<br>` : "";
      return `${presetVal}NPSH<sub>r</sub> — минимально допустимая разница абсолютного давления на ` +
             `входе насоса и давления насыщенных паров, обеспечивающая бескавитационную работу. ` +
             `Задаётся по паспорту насоса.<br><br>` +
             `Типовые значения для грунтонасосов:<br>` +
             `• мелкие насосы (Q<500 м³/ч): <b>2–3 м</b><br>` +
             `• средние (500–2000 м³/ч): <b>3–5 м</b><br>` +
             `• крупные (>2000 м³/ч): <b>5–8 м</b><br>` +
             `Чем выше NPSH<sub>r</sub>, тем ниже допустимая высота всасывания. ` +
             `Для погружных насосов проверка не выполняется (положительный подпор от водяного столба).`;
    },
    src: () => currentPreset().src,
  },
  etaGear: {
    title: "КПД редуктора (η_ред)",
    note:
      `Доля мощности, передаваемой от двигателя на вал насоса. ` +
      `Рекомендуемые значения по типу передачи:<br>` +
      `• прямая муфта (без редукции): <b>0.98–0.99</b><br>` +
      `• одноступенчатый цилиндрический редуктор: <b>0.97–0.98</b><br>` +
      `• двухступенчатый/шевронный: <b>0.95–0.97</b><br>` +
      `• конический/планетарный: <b>0.93–0.96</b><br>` +
      `• ременная (клиновые ремни): <b>0.93–0.96</b><br>` +
      `Дефолт <b>0.96</b> — типовое значение для морских редукторных передач земснарядов.`,
    src: "Анурьев В.И. Справочник конструктора-машиностроителя; типовые данные по приводам.",
  },
  Neng: {
    title: "Мощность от двигателя",
    tex: "N_{дв} = \\dfrac{N_{тр}}{\\eta_{ред}}",
    subst: (i, r) =>
      `N_{дв} = \\dfrac{${fL(r.Nreq,1)}}{${fL(i.etaGear,2)}} = ${fL(r.Neng,1)}\\;\\text{кВт}`,
    src: "Учёт потерь в редукторе/передаче. Сравнивать с паспортной мощностью дизеля.",
  },
  eta: {
    title: "КПД грунтонасоса (η)",
    note:
      `Значение по умолчанию <b>0.62</b> — средняя величина для землесосов в рабочей ` +
      `точке на пульпе. Типичные диапазоны:<br>` +
      `• новый насос на чистой воде: <b>0.72–0.82</b><br>` +
      `• тот же насос на пульпе (с потерями на твёрдое): <b>0.55–0.70</b><br>` +
      `• износ рабочего колеса/корпуса: <b>−5…−15 %</b> от номинала<br>` +
      `Уточнить по паспортной H–Q–η кривой насоса в рабочей точке.`,
    src: "Шкундин Б.М. §4.4, табл. 4.2; Юфин А.П. гл. V; рекомендации производителей дредж-насосов (GIW, Damen, Warman).",
  },
};

// ---- Рендер результатов ----
function cell(label, value, sub, cls, formulaKey) {
  const k = formulaKey ? `<button class="info-btn" data-f="${formulaKey}" title="формула">i</button>` : "";
  const cc = cls ? " " + cls : "";
  return `
    <div class="r-cell${cc}">
      <div class="r-label">${label} ${k}</div>
      <div class="r-value">${value}</div>
      ${sub ? `<div class="r-sub">${sub}</div>` : ""}
    </div>`;
}

function classifyV(r) {
  if (r.v < r.vcr) return "bad";
  if (r.v < 1.1 * r.vcr) return "warn";
  if (r.v > 1.5 * r.vcr && r.v > 6.0) return "warn";
  return "good";
}

function render(inp, r, range) {
  _lastState = { inp, r, range };
  const $ = id => document.getElementById(id);
  $("Sout").textContent = (inp.S * 100).toFixed(1) + " %";

  const cls = {
    v: classifyV(r),
    H: r.Hreq <= r.Havail ? "good" : "bad",
    N: r.Nreq <= inp.N ? "good" : "bad",
    npsh: r.npsh ? (r.npsh.ok ? "good" : "bad") : "",
  };

  const cells = [];
  cells.push(cell(
    "Скорость в пульпопроводе",
    `${fmt(r.v)} м/с`,
    `v<sub>кр</sub> = ${fmt(r.vcr)} м/с; рекомендуется ${fmt(1.1*r.vcr)}–${fmt(1.3*r.vcr)} м/с`,
    cls.v, "velocity"
  ));
  cells.push(cell(
    "Критическая скорость",
    `${fmt(r.vcr)} м/с`,
    `по Durand–Юфину, F<sub>L</sub> с поправкой на S`,
    "", "vcrit"
  ));
  cells.push(cell(
    "Плотность пульпы",
    `${fmt(r.rhoPulp,0)} кг/м³`,
    `при S = ${fmtPct(inp.S)} %`,
    "", "density"
  ));
  cells.push(cell(
    "Массовая концентрация",
    `${fmtPct(r.Cm)} %`,
    `C<sub>m</sub> = S·ρ<sub>T</sub>/ρ<sub>п</sub>`,
    "", "concMass"
  ));
  cells.push(cell(
    "Производительность по пульпе",
    `${fmt(inp.Q,0)} м³/ч`,
    `задана как вход`,
    "", null
  ));
  cells.push(cell(
    "Производительность по грунту (разр.)",
    `${fmt(r.Qbulk,0)} м³/ч`,
    `в массиве: ${fmt(r.Qsolid,0)} м³/ч; k<sub>р</sub>=${inp.kr}`,
    "good", "qBulk"
  ));
  cells.push(cell(
    "Эксплуатационная производительность",
    `${fmt(r.Qop,0)} м³/ч`,
    `с учётом k<sub>исп</sub>=${inp.kUtil}; h<sub>сл</sub>=${inp.hLayer} м`,
    "good", "qOper"
  ));
  cells.push(cell(
    "Потери напора (нагнетание)",
    `${fmt(r.lossPulpM)} м`,
    `вода: ${fmt(r.lossesW.total)} м; коэф. пульпы ×${fmt(r.sf,2)}; λ=${fmt(r.lossesW.lam,4)}`,
    "", "lossesPipe"
  ));
  cells.push(cell(
    "Потери напора (всас)",
    `${fmt(r.lossSucPulp)} м`,
    `v<sub>вс</sub>=${fmt(r.vSuc)} м/с; L<sub>прив</sub>=${fmt(r.sucLen,1)} м`,
    "", "lossesSuc"
  ));
  cells.push(cell(
    "Требуемый напор",
    `${fmt(r.Hreq)} м`,
    `геометрический: ${fmt(r.hStat,1)} м + потери`,
    cls.H, "hreq"
  ));
  cells.push(cell(
    "Развиваемый напор по пульпе",
    `${fmt(r.Havail)} м`,
    `HR = ${fmt(r.HR,3)} (поправка на крупность/S)`,
    cls.H, "havail"
  ));
  cells.push(cell(
    "Требуемая мощность (на валу)",
    `${fmt(r.Nreq,0)} кВт`,
    `при η<sub>нас</sub> = ${inp.eta}; лимит вала: ${inp.N} кВт`,
    cls.N, "power"
  ));
  cells.push(cell(
    "Мощность от двигателя",
    `${fmt(r.Neng,0)} кВт`,
    `с учётом η<sub>ред</sub> = ${inp.etaGear}`,
    cls.N, "Neng"
  ));
  cells.push(cell(
    "Запас мощности (вал)",
    `${fmt(100 * (1 - r.Nreq / inp.N), 0)} %`,
    `от лимита ${inp.N} кВт`,
    cls.N, null
  ));

  if (r.npsh) {
    cells.push(cell(
      "Высота всасывания",
      `${fmt(r.npsh.requiredLift)} м из ${fmt(r.npsh.liftMax)} м`,
      r.npsh.ok ? "в норме" : "превышен лимит атмосферного давления",
      cls.npsh, "npsh"
    ));
  }

  if (inp.pumpType === "submerged") {
    const alphaDeg = r.frame.alpha * 180 / Math.PI;
    const frameCls = r.frame.reachable ? "good" : "bad";
    cells.push(cell(
      "Фактическая глубина насоса",
      `${fmt(r.frame.pumpDepth, 2)} м`,
      `угол рамы α = ${fmt(alphaDeg, 1)}°; L<sub>рамы</sub> = ${inp.Lframe} м`,
      frameCls, "pumpDepth"
    ));
  }

  const sMin = range.sMinOk, sMax = range.sMaxOk;
  const rangeText = (sMin !== null && sMax !== null)
    ? `${fmtPct(sMin)}…${fmtPct(sMax)} % об.`
    : "не найден (см. ограничения ниже)";
  const rangeRho = (sMin !== null && sMax !== null)
    ? `ρ<sub>п</sub>: ${(RHO_W + sMin*(inp.rhoS-RHO_W)).toFixed(0)}…${(RHO_W + sMax*(inp.rhoS-RHO_W)).toFixed(0)} кг/м³`
    : "—";
  cells.push(`<div class="r-cell span2 ${sMin!==null?'good':'bad'}">
      <div class="r-label">Допустимый диапазон концентраций
        <button class="info-btn" data-f="range" title="формула">i</button></div>
      <div class="r-value">${rangeText}</div>
      <div class="r-sub">${rangeRho}</div>
    </div>`);

  document.getElementById("results").innerHTML = cells.join("");

  // Статусная сводка
  const status = [];
  if (r.v < r.vcr)       status.push(["bad", `Скорость ниже критической — риск заиления (v=${fmt(r.v)} < v_кр=${fmt(r.vcr)} м/с). Поднимите Q или уменьшите Ø трубы.`]);
  else if (r.v < 1.1 * r.vcr) status.push(["warn", `Скорость на грани критической. Желательно иметь запас ≥10 %.`]);
  else if (r.v > 6.5)    status.push(["warn", `Скорость >${6.5} м/с — повышенный износ труб.`]);
  else                   status.push(["ok",  `Скорость в рекомендуемом диапазоне.`]);

  if (r.Hreq > r.Havail) status.push(["bad", `Не хватает напора: требуется ${fmt(r.Hreq)} м, насос даёт ${fmt(r.Havail)} м по пульпе.`]);
  else                    status.push(["ok",  `Напор насоса достаточен (${fmt(r.Havail)}/${fmt(r.Hreq)} м).`]);

  if (r.Nreq > inp.N)    status.push(["bad", `Не хватает мощности: ${fmt(r.Nreq,0)} > ${inp.N} кВт.`]);
  else                    status.push(["ok",  `Запас мощности ${fmt(100*(1-r.Nreq/inp.N),0)} %.`]);

  if (r.npsh && !r.npsh.ok) status.push(["bad", `Превышен предел всасывания (${fmt(r.npsh.requiredLift)} > ${fmt(r.npsh.liftMax)} м). Рассмотрите погружной насос.`]);

  if (inp.pumpType === "submerged" && !r.frame.reachable) {
    status.push(["bad", `Глубина разработки ${inp.depth} м превышает длину рамы ${inp.Lframe} м — фреза не достанет дна.`]);
  }

  document.getElementById("statusBox").innerHTML = status.map(s => `<div class="item ${s[0]}">${s[1]}</div>`).join("");
}

// ---- Состояние для tooltip (последние входы/результат/диапазон) ----
let _lastState = { inp: null, r: null, range: null };

// ---- Tooltip (KaTeX) ----
function setupTooltip() {
  const tip = document.getElementById("tooltip");
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".info-btn");
    if (btn) {
      const f = FORMULAS[btn.dataset.f];
      if (!f) return;
      let substTex = null;
      try {
        if (f.subst && _lastState.inp && _lastState.r) {
          substTex = f.subst(_lastState.inp, _lastState.r, _lastState.range);
        }
      } catch (err) { substTex = null; }

      const noteVal = typeof f.note === "function" ? f.note() : f.note;
      const srcVal  = typeof f.src  === "function" ? f.src()  : f.src;
      tip.innerHTML = `
        <h3>${f.title}</h3>
        ${noteVal ? `<div class="note">${noteVal}</div>` : ""}
        ${f.tex ? `<div id="texbox"></div>` : ""}
        ${substTex ? `<div class="subst-label">с текущими значениями:</div><div id="texsubst"></div>` : ""}
        <div class="src">${srcVal || ""}</div>`;
      tip.hidden = false;

      const r = btn.getBoundingClientRect();
      tip.style.left = Math.min(window.innerWidth - 460, r.right + 8) + "px";
      tip.style.top  = Math.min(window.innerHeight - 240, r.top) + "px";

      if (window.katex) {
        if (f.tex) {
          katex.render(f.tex, document.getElementById("texbox"),
                       { throwOnError: false, displayMode: true, strict: "ignore" });
        }
        if (substTex) {
          const wrapped = `\\begin{gathered}${substTex}\\end{gathered}`;
          katex.render(wrapped, document.getElementById("texsubst"),
                       { throwOnError: false, displayMode: true, strict: "ignore" });
        }
      } else {
        if (f.tex) document.getElementById("texbox").textContent = f.tex;
        if (substTex) document.getElementById("texsubst").textContent = substTex;
      }
      e.stopPropagation();
      return;
    }
    if (!e.target.closest("#tooltip")) tip.hidden = true;
  });
  window.addEventListener("scroll", () => tip.hidden = true, true);
  window.addEventListener("resize", () => tip.hidden = true);
}

// ---- Схема земснаряда (SVG) ----
// Понтон справа от центра, рама с фрезой уходит ВПРАВО-ВНИЗ в воду,
// пульпопровод выходит из понтона ВЛЕВО (к шаланде или плавпульпопроводу).
function drawSchematic(inp) {
  const W = 720, H = 340;
  const waterY = 100;
  const SCALE = 11;                       // px на 1 м (общий масштаб глубины и рамы)

  const Lf = Math.max(0.1, inp.Lframe);
  const dep = Math.min(inp.depth, Lf);
  const sinA = dep / Lf;
  const cosA = Math.sqrt(Math.max(0, 1 - sinA * sinA));
  const frameLenPx = Lf * SCALE;

  const pontoonW = 240, pontoonH = 28;
  const pontoonX = 280;
  const pontoonY = waterY - pontoonH * 0.6;

  // Ось вращения на уровне воды у правого борта понтона
  const frameX1 = pontoonX + pontoonW - 12;
  const frameY1 = waterY;
  const frameX2 = frameX1 + frameLenPx * cosA;
  const frameY2 = frameY1 + frameLenPx * sinA;

  // Дно проходит по нижней точке рамы (если рама достаёт)
  const bottomY = inp.depth <= Lf
    ? frameY2
    : waterY + Math.min(220, inp.depth * SCALE);     // если рама короче — дно ниже фрезы

  // Насос — на slant-расстоянии axisDepth по раме от оси
  const pumpOnFrame = inp.pumpType === "submerged";
  let pumpX, pumpY, pumpLabel;
  if (pumpOnFrame) {
    const t = Math.min(1, Math.max(0, inp.axisDepth) / Lf);
    pumpX = frameX1 + (frameX2 - frameX1) * t;
    pumpY = frameY1 + (frameY2 - frameY1) * t;
    pumpLabel = "погружной";
  } else {
    pumpX = pontoonX + pontoonW * 0.7;
    pumpY = pontoonY + pontoonH * 0.5;
    pumpLabel = "палубный";
  }
  const alphaDeg = Math.asin(sinA) * 180 / Math.PI;

  // Пульпопровод: прямая зелёная линия строго по уровню воды.
  // В режиме шаланды не рисуется.
  const isBarge = inp.discharge === "barge";
  const pipeStartX = pontoonX + 14;
  const pipeStartY = waterY;
  const pipeEndX = 20;
  const pipeEndY = waterY;

  // Размер глубины — справа от рамы
  const depthLabelX = frameX2 + 28;

  const svg = `
<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
  <defs>
    <pattern id="waterpat" patternUnits="userSpaceOnUse" width="10" height="6">
      <path d="M0 3 Q 2.5 0 5 3 T 10 3" fill="none" stroke="#3a6c98" stroke-width="0.8"/>
    </pattern>
    <pattern id="soilpat" patternUnits="userSpaceOnUse" width="10" height="10">
      <rect width="10" height="10" fill="#6a553a"/>
      <circle cx="3" cy="3" r="1" fill="#8a7654"/>
      <circle cx="7" cy="7" r="1.2" fill="#5a4630"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${waterY}" fill="#0e1116"/>
  <rect y="${waterY}" width="${W}" height="${bottomY - waterY}" fill="#1f3a52"/>
  <rect y="${waterY}" width="${W}" height="${bottomY - waterY}" fill="url(#waterpat)" opacity="0.5"/>
  <line x1="0" y1="${waterY}" x2="${W}" y2="${waterY}" stroke="#7fb6e6" stroke-width="1"/>
  <text x="${W - 10}" y="${waterY - 6}" text-anchor="end" fill="#7fb6e6" font-size="10">уровень воды</text>

  <rect y="${bottomY}" width="${W}" height="${H - bottomY}" fill="url(#soilpat)"/>
  <line x1="0" y1="${bottomY}" x2="${W}" y2="${bottomY}" stroke="#3a2f20" stroke-width="1"/>

  <!-- Понтон -->
  <rect x="${pontoonX}" y="${pontoonY}" width="${pontoonW}" height="${pontoonH}" rx="3"
        fill="#2a313c" stroke="#8b96a3"/>
  <text x="${pontoonX + pontoonW/2}" y="${pontoonY + 18}" text-anchor="middle" fill="#e6edf3" font-size="12">земснаряд</text>

  <!-- Подвижная рама -->
  <line x1="${frameX1}" y1="${frameY1}" x2="${frameX2}" y2="${frameY2}" stroke="#ffb454" stroke-width="6" stroke-linecap="round"/>
  <circle cx="${frameX1}" cy="${frameY1}" r="5" fill="#0e1116" stroke="#ffb454" stroke-width="2"/>
  <text x="${frameX1 - 14}" y="${frameY1 - 6}" fill="#ffb454" font-size="9">ось</text>
  <text x="${(frameX1 + frameX2)/2 + 10}" y="${(frameY1 + frameY2)/2 - 6}"
        fill="#ffb454" font-size="10">α=${alphaDeg.toFixed(0)}°, L=${Lf.toFixed(1)} м</text>

  <!-- Фреза/разрыхлитель -->
  <circle cx="${frameX2}" cy="${frameY2}" r="10" fill="#3b2f20" stroke="#ffb454" stroke-width="2"/>
  <text x="${frameX2}" y="${frameY2 + 4}" text-anchor="middle" fill="#ffb454" font-size="11">⚙</text>
  <text x="${frameX2 + 14}" y="${frameY2 + 4}" fill="#ffb454" font-size="10">фреза</text>

  <!-- Грунтонасос -->
  <circle cx="${pumpX}" cy="${pumpY}" r="11" fill="#4cc2ff" stroke="#001b2b" stroke-width="1.5"/>
  <text x="${pumpX}" y="${pumpY + 3}" text-anchor="middle" fill="#001b2b" font-size="10" font-weight="700">Н</text>
  <text x="${pumpX - 14}" y="${pumpY - 10}" text-anchor="end" fill="#4cc2ff" font-size="10">${pumpLabel}${pumpOnFrame ? ` (h=${(inp.axisDepth*sinA).toFixed(1)} м)` : ''}</text>

  <!-- Пульпопровод (только если не в шаланду) -->
  ${isBarge ? "" : `
  <line x1="${pipeStartX}" y1="${pipeStartY}" x2="${pipeEndX}" y2="${pipeEndY}"
        stroke="#6fe39a" stroke-width="4" stroke-linecap="round"/>
  <text x="${(pipeStartX + pipeEndX) / 2}" y="${pipeStartY - 6}"
        text-anchor="middle" fill="#6fe39a" font-size="10">пульпопровод L=${inp.L} м, Ø${(inp.Dpipe*1000).toFixed(0)} мм</text>`}

  <!-- Размер глубины -->
  <line x1="${depthLabelX - 8}" y1="${waterY}" x2="${depthLabelX - 8}" y2="${bottomY}" stroke="#8b96a3" stroke-width="1" stroke-dasharray="3 2"/>
  <line x1="${depthLabelX - 12}" y1="${waterY}" x2="${depthLabelX - 4}" y2="${waterY}" stroke="#8b96a3"/>
  <line x1="${depthLabelX - 12}" y1="${bottomY}" x2="${depthLabelX - 4}" y2="${bottomY}" stroke="#8b96a3"/>
  <text x="${depthLabelX}" y="${(waterY + bottomY)/2 + 4}" fill="#8b96a3" font-size="11">${inp.depth} м</text>
</svg>`;
  document.getElementById("schematic").innerHTML = svg;
}

// ---- Привязка событий ----
function bindUI() {
  // сегменты
  document.querySelectorAll(".seg").forEach(seg => {
    seg.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      seg.querySelectorAll("button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      onAnyChange();
    });
  });
  // все инпуты
  document.querySelectorAll("input, select").forEach(el => {
    el.addEventListener("input", onAnyChange);
    el.addEventListener("change", onAnyChange);
  });
  // авто d50 по категории
  document.getElementById("soil").addEventListener("change", e => {
    const v = SOILS[e.target.value];
    if (v) document.getElementById("d50").value = v.d50;
    onAnyChange();
  });
  // пресет насоса
  document.getElementById("preset").addEventListener("change", e => applyPumpPreset(e.target.value));
  // правка любого поля насоса → переключаем пресет в "custom"
  const presetFields = ["Q","H","N","eta","etaGear","dIn","dOut","axisDepth","Lframe","NPSHr"];
  presetFields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", () => {
      const sel = document.getElementById("preset");
      if (sel.value !== "custom") sel.value = "custom";
    });
  });
  // правка переключателя «тип насоса» тоже переключает в custom
  document.querySelector('.seg[data-bind="pumpType"]').addEventListener("click", () => {
    const sel = document.getElementById("preset");
    if (sel.value !== "custom") sel.value = "custom";
  });
}

function applyPumpPreset(presetId) {
  const p = PUMP_PRESETS[presetId];
  if (!p || !p.params) { onAnyChange(); return; }
  for (const [k, v] of Object.entries(p.params)) {
    if (k === "pumpType") {
      document.querySelectorAll('.seg[data-bind="pumpType"] button').forEach(b => {
        b.classList.toggle("active", b.dataset.val === v);
      });
    } else {
      const el = document.getElementById(k);
      if (el) el.value = v;
    }
  }
  onAnyChange();
}

function onAnyChange() {
  const inp = readInputs();
  // показать поля "ось вращения" и "длина рамы" только для погружного,
  // NPSHr — только для палубного
  const isSub = inp.pumpType === "submerged";
  document.getElementById("rowAxisDepth").hidden = !isSub;
  document.getElementById("rowLframe").hidden = !isSub;
  document.getElementById("rowNPSHr").hidden = isSub;

  const r = computeAt(inp, inp.S);
  const range = feasibleRange(inp);
  render(inp, r, range);
  drawSchematic(inp);
}

// ---- Старт ----
async function init() {
  const defaultId = await loadPumpPresets();
  populatePresetSelect(defaultId);
  bindUI();
  setupTooltip();
  if (defaultId !== "custom") applyPumpPreset(defaultId);
  else onAnyChange();
}
document.addEventListener("DOMContentLoaded", init);
