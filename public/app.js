/* 地下环闭合仪 前端 */
const $ = (id) => document.getElementById(id);
const canvas = $('view');
const ctx = canvas.getContext('2d');

let state = null;      // /api/state
let lastResult = null; // 最近一次平差结果
let selectedLoop = null;

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function refresh() {
  state = await api('/api/state');
  renderAll();
}

function fmt(x, d = 4) { return x == null ? '—' : Number(x).toFixed(d); }
function fmtSec(x) { return x == null ? '—' : Number(x).toFixed(2) + '″'; }

/* ---------- 面板 ---------- */
function renderSummary() {
  const s = state.summary;
  const dup = s.duplicateNames.map((d) => `${d.name}(${d.ids.join('/')})`).join('，');
  $('summary').innerHTML = `
    <table>
      <tr><th>连通分量</th><td>${s.components}</td></tr>
      <tr><th>测站 / 观测 / 连接</th><td>${s.stations} / ${s.observations} / ${s.connections}</td></tr>
      <tr><th>独立闭合路</th><td>${s.loops}</td></tr>
      <tr><th>往返观测组</th><td>${s.roundTripGroups.join('、') || '无'}</td></tr>
      <tr><th>重名测站(不合并)</th><td class="dim">${dup || '无'}</td></tr>
    </table>
    ${state.components.map((c) => `
      <div class="${c.defect > 0 ? 'bad' : 'good'}">
        分量${c.index + 1}：${c.stationIds.length}站/${c.observationIds.length}观测/环${c.loopCount}，
        未知数${c.unknowns}，秩${c.rank}
        ${c.defect > 0 ? `，<b>秩亏 ${c.defect} 维</b>：${c.defectLabels.join('；')}` : '，满秩'}
      </div>`).join('')}`;
}

function renderLoops() {
  $('loops').innerHTML = state.loops.length === 0 ? '<span class="dim">无独立闭合路</span>' : '';
  for (const l of state.loops) {
    const div = document.createElement('div');
    div.className = 'loop-item' + (selectedLoop === l.id ? ' active' : '');
    const f = l.misclosure;
    const absF = f ? Math.hypot(f.e, f.n, f.z) : null;
    div.innerHTML = `
      <b>${l.id}</b> <span class="dim">${l.path.join('→')}</span><br>
      ${f ? `闭合差 [${fmt(f.e, 3)}, ${fmt(f.n, 3)}, ${fmt(f.z, 3)}]m，|f|=${fmt(absF, 4)}m，
        相对精度 <b class="${l.relative > 5000 ? 'good' : 'bad'}">1/${Math.round(l.relative)}</b>`
        : '<span class="bad">含仅方位边，无尺度闭合差</span>'}
      ${l.azimuthClosure != null ? `<br>往返方位不符值 ${fmtSec(l.azimuthClosure * 3600)}` : ''}`;
    div.onclick = () => { selectedLoop = selectedLoop === l.id ? null : l.id; renderAll(); };
    $('loops').appendChild(div);
  }
}

function renderDiag() {
  if (!lastResult) { $('diag').innerHTML = '<span class="dim">尚未运行平差</span>'; return; }
  const d = lastResult.diagnostics;
  $('diag').innerHTML = `
    <div>${lastResult.message}</div>
    <table>
      <tr><th>观测方程数</th><td>${d.observations}</td><th>未知数</th><td>${d.unknowns}</td></tr>
      <tr><th>秩</th><td>${d.rank}</td><th>秩亏</th><td class="${d.defect ? 'bad' : 'good'}">${d.defect}</td></tr>
      <tr><th>自由度</th><td>${d.dof}</td><th>σ₀</th><td>${fmt(d.sigma0, 4)}</td></tr>
      <tr><th>条件数估计</th><td colspan="3">${d.condEstimate ? d.condEstimate.toExponential(2) : '—'}</td></tr>
    </table>`;
}

function renderStations() {
  const dup = new Set(state.summary.duplicateNames.flatMap((x) => x.ids));
  $('stations').innerHTML = `<table><tr><th>id</th><th>名称</th><th>锁定</th><th>近似坐标 E/N/Z</th></tr></table>`;
  const t = $('stations').querySelector('table');
  for (const s of state.stations) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${s.id}${dup.has(s.id) ? ' <span class="tag rt">重名</span>' : ''}</td>
      <td>${s.name}</td>
      <td><input type="checkbox" ${s.locked ? 'checked' : ''}></td>
      <td class="dim">${s.approx.map((v) => fmt(v, 2)).join(', ')}</td>`;
    tr.querySelector('input').onchange = async (ev) => {
      state = await api('/api/station', 'POST', { id: s.id, locked: ev.target.checked });
      lastResult = null;
      renderAll();
    };
    t.appendChild(tr);
  }
}

function renderObs() {
  const resMap = new Map((lastResult?.residuals ?? []).map((r) => [r.observationId, r]));
  $('obs').innerHTML = `<table><tr><th>id</th><th>方向</th><th>斜距</th><th>方位°</th><th>倾角°</th>
    <th>权重</th><th>翻转</th><th>v距mm</th><th>v方位</th><th>v倾角</th></tr></table>`;
  const t = $('obs').querySelector('table');
  for (const o of state.observations) {
    const r = resMap.get(o.id);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${o.id}${o.group ? ` <span class="tag rt">${o.group}</span>` : ''}</td>
      <td>${o.from}→${o.to}${o.flipped ? ' <span class="tag flip">已翻转</span>' : ''}</td>
      <td>${fmt(o.slope, 4)}</td><td>${fmt(o.azimuth, 5)}</td><td>${fmt(o.incl, 5)}</td>
      <td><input class="w" type="number" min="0.01" step="0.5" value="${o.weight}"></td>
      <td><button class="small">${o.flipped ? '取消翻转' : '设为翻转候选'}</button></td>
      <td>${r && r.vDist != null ? fmt(r.vDist * 1000, 2) : '—'}</td>
      <td>${r ? fmtSec(r.vAzSec) : '—'}</td>
      <td>${r ? fmtSec(r.vInclSec) : '—'}</td>`;
    tr.querySelector('input').onchange = async (ev) => {
      state = await api('/api/observation', 'POST', { id: o.id, weight: Number(ev.target.value) });
      renderAll();
    };
    tr.querySelector('button').onclick = async () => {
      state = await api('/api/observation', 'POST', { id: o.id, flipped: !o.flipped });
      renderAll();
    };
    t.appendChild(tr);
  }
}

function renderCoords() {
  if (!lastResult) { $('coords').innerHTML = '<span class="dim">尚未运行平差</span>'; return; }
  $('coords').innerHTML = `<table><tr><th>id</th><th>名称</th><th>E</th><th>N</th><th>Z</th><th>椭球 a/b/θ</th><th>σZ</th></tr></table>`;
  const t = $('coords').querySelector('table');
  for (const s of lastResult.stations) {
    const tr = document.createElement('tr');
    tr.innerHTML = s.adjusted
      ? `<td>${s.id}</td><td>${s.name}</td><td>${fmt(s.adjusted[0], 4)}</td><td>${fmt(s.adjusted[1], 4)}</td><td>${fmt(s.adjusted[2], 4)}</td>
         <td>${s.ellipse ? `${fmt(s.ellipse.a * 1000, 1)}/${fmt(s.ellipse.b * 1000, 1)}mm @${fmt(s.ellipse.thetaDeg, 1)}°` : '—'}</td>
         <td>${s.sigmaZ != null ? fmt(s.sigmaZ * 1000, 1) + 'mm' : '—'}</td>`
      : `<td>${s.id}</td><td>${s.name}</td><td colspan="5" class="bad">秩亏，不可解</td>`;
    t.appendChild(tr);
  }
}

function renderRuns() {
  const runs = state.runs;
  $('runs').innerHTML = runs.length === 0 ? '<span class="dim">暂无运行记录</span>' : '';
  for (const r of runs) {
    const div = document.createElement('div');
    div.innerHTML = `#${r.id} <span class="dim">${r.created_at}</span>
      <a href="/api/runs/${r.id}/export" download>导出 JSON</a>`;
    $('runs').appendChild(div);
  }
}

/* ---------- Canvas ---------- */
const ELLIPSE_EXAGG = 400;   // 误差椭球夸大倍数
const RESID_EXAGG = 400;     // 残差向量夸大倍数

function project() {
  const pts = state.stations.map((s) => {
    const adj = lastResult?.stations.find((x) => x.id === s.id)?.adjusted;
    return adj ?? (s.known ?? s.approx);
  });
  const es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
  const minE = Math.min(...es), maxE = Math.max(...es);
  const minN = Math.min(...ns), maxN = Math.max(...ns);
  const pad = 60;
  const sx = (canvas.width - 2 * pad) / Math.max(1e-6, maxE - minE);
  const sy = (canvas.height - 2 * pad) / Math.max(1e-6, maxN - minN);
  const k = Math.min(sx, sy);
  return (e, n) => [pad + (e - minE) * k, canvas.height - pad - (n - minN) * k];
}

function drawArrow(x1, y1, x2, y2, color, width = 2) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const ang = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - 8 * Math.cos(ang - 0.4), y2 - 8 * Math.sin(ang - 0.4));
  ctx.lineTo(x2 - 8 * Math.cos(ang + 0.4), y2 - 8 * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();
}

function renderCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const toXY = project();
  const posOf = (id) => {
    const s = state.stations.find((x) => x.id === id);
    const adj = lastResult?.stations.find((x) => x.id === id)?.adjusted;
    const p = adj ?? (s.known ?? s.approx);
    return toXY(p[0], p[1]);
  };
  const loop = state.loops.find((l) => l.id === selectedLoop);
  const loopObs = new Set(loop?.observationIds ?? []);

  // 观测边
  for (const o of state.observations) {
    const [x1, y1] = posOf(o.from);
    const [x2, y2] = posOf(o.to);
    ctx.lineWidth = loopObs.has(o.id) ? 3.5 : 1.5;
    ctx.strokeStyle = o.flipped ? '#c792ea' : loopObs.has(o.id) ? '#ff9f43' : '#3a4a5f';
    ctx.setLineDash(o.flipped ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 残差向量（夸大）
  if (lastResult) {
    for (const r of lastResult.residuals) {
      if (!r.vVec) continue;
      const [x1, y1] = posOf(r.from);
      const [x2, y2] = posOf(r.to);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      drawArrow(mx, my, mx + r.vVec.e * RESID_EXAGG, my - r.vVec.n * RESID_EXAGG, '#ff5d5d');
    }
  }

  // 误差椭球（夸大）
  if (lastResult) {
    for (const sr of lastResult.stations) {
      if (!sr.ellipse) continue;
      const [cx, cy] = posOf(sr.id);
      const th = (sr.ellipse.thetaDeg * Math.PI) / 180;
      ctx.strokeStyle = '#54d98c';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(2, sr.ellipse.a * ELLIPSE_EXAGG), Math.max(1.5, sr.ellipse.b * ELLIPSE_EXAGG), -th, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 测站
  ctx.font = '11px sans-serif';
  for (const s of state.stations) {
    const [x, y] = posOf(s.id);
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = s.locked ? '#ffd166' : '#6fb3ff';
    ctx.fill();
    if (s.locked) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 10, y - 10, 20, 20);
    }
    ctx.fillStyle = '#dbe4ee';
    ctx.fillText(`${s.name}(${s.id})`, x + 9, y - 7);
  }
}

function renderAll() {
  renderSummary();
  renderLoops();
  renderDiag();
  renderStations();
  renderObs();
  renderCoords();
  renderRuns();
  renderCanvas();
}

$('btn-adjust').onclick = async () => {
  lastResult = await api('/api/adjust', 'POST');
  state = await api('/api/state');
  renderAll();
};
$('btn-reset').onclick = async () => {
  if (!confirm('清空数据库并重新导入固定算例？')) return;
  state = await api('/api/reset', 'POST');
  lastResult = null;
  selectedLoop = null;
  renderAll();
};

refresh();
