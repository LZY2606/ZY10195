let state = null;

const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 3) => value === null || value === undefined || Number.isNaN(value) ? '—' : Number(value).toFixed(digits);
const vectorText = (v) => `(${v.map((x) => fmt(x, 3)).join(', ')})`;

async function api(path, body) {
  const response = await fetch(path, body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function refresh(message = '') {
  state = await api('/api/state');
  render();
  $('message').textContent = message;
}

function render() {
  renderControls();
  renderSummary();
  drawNetwork();
  renderDiagnostics();
  renderLoops();
  drawEllipsoids();
  drawResiduals();
  renderResidualTable();
  renderRuns();
}

function selectedObservation() {
  return state.observations.find((item) => item.id === $('observationSelect').value);
}

function renderControls() {
  $('stationSelect').innerHTML = state.stations.map((station) => `<option value="${station.id}">${station.id}｜${station.name}${station.locked ? '（已锁定）' : ''}</option>`).join('');
  $('observationSelect').innerHTML = state.observations.map((observation) => `<option value="${observation.id}">${observation.id}: ${observation.from_station_id}→${observation.to_station_id}</option>`).join('');
  $('flipSelect').innerHTML = state.flip_candidates.map((candidate) => `<option value="${candidate.id}">${candidate.id} ${candidate.from_station_id}↔${candidate.to_station_id}${candidate.active ? '（启用）' : '（停用）'}</option>`).join('');
  const observation = selectedObservation();
  if (observation) $('weightInput').value = observation.weight;
}

function renderSummary() {
  const s = state.result.summary;
  $('summary').innerHTML = `<span class="badge">站点 ${s.station_count}</span><span class="badge">观测 ${s.observation_count}</span><span class="badge">独立环 ${s.independent_ring_count}</span><span class="badge">往返证据 ${s.reciprocal_pair_count}</span><span class="badge">连通分量 ${s.components.length}</span>`;
}

function project(coordinate, bounds, width, height) {
  const spanX = Math.max(1e-9, bounds.maxX - bounds.minX);
  const spanY = Math.max(1e-9, bounds.maxY - bounds.minY);
  const scale = Math.min((width - 90) / spanX, (height - 80) / spanY);
  return {
    x: width / 2 + (coordinate.x - (bounds.minX + bounds.maxX) / 2) * scale,
    y: height / 2 - (coordinate.y - (bounds.minY + bounds.maxY) / 2) * scale,
    z: coordinate.z,
    scale,
  };
}

function coordinateById(id) {
  return state.result.coordinates.find((coordinate) => coordinate.station_id === id);
}

function drawNetwork() {
  const canvas = $('networkCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const coords = state.result.coordinates;
  const bounds = coords.reduce((acc, point) => ({
    minX: Math.min(acc.minX, point.x), maxX: Math.max(acc.maxX, point.x),
    minY: Math.min(acc.minY, point.y), maxY: Math.max(acc.maxY, point.y),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

  const positions = new Map(coords.map((point) => [point.station_id, project(point, bounds, canvas.width, canvas.height)]));
  const drawEdge = (from, to, color, dashed) => {
    const a = positions.get(from);
    const b = positions.get(to);
    if (!a || !b) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(dashed ? [6, 5] : []);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - 9 * Math.cos(angle - 0.45), b.y - 9 * Math.sin(angle - 0.45));
    ctx.lineTo(b.x - 9 * Math.cos(angle + 0.45), b.y - 9 * Math.sin(angle + 0.45));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  };

  for (const observation of state.observations) {
    const active = observation.flipped_candidate_id;
    drawEdge(active ? observation.to_station_id : observation.from_station_id, active ? observation.from_station_id : observation.to_station_id, active ? '#f0883e' : '#8b949e', false);
  }
  for (const candidate of state.flip_candidates) {
    drawEdge(candidate.from_station_id, candidate.to_station_id, candidate.active ? '#f0883e' : '#6e7681', !candidate.active);
  }

  for (const [id, point] of positions) {
    const station = state.stations.find((item) => item.id === id);
    ctx.beginPath();
    ctx.fillStyle = station.locked ? '#f2cc60' : '#58a6ff';
    ctx.arc(point.x, point.y, station.locked ? 7 : 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#e6edf3';
    ctx.fillText(`${id}·${station.name}`, point.x + 9, point.y - 8);
    ctx.fillStyle = '#9da7b3';
    ctx.font = '11px sans-serif';
    ctx.fillText(`z=${fmt(point.z, 2)}`, point.x + 9, point.y + 8);
  }

  const defectStations = new Set(state.result.rankDefects.flatMap((defect) => defect.station_ids));
  if (defectStations.size) {
    ctx.fillStyle = '#ff7b72';
    ctx.font = '13px sans-serif';
    ctx.fillText(`秩亏分量站点: ${[...defectStations].join(', ')}`, 18, canvas.height - 18);
  }
}

function renderDiagnostics() {
  const d = state.result.diagnostics;
  const metrics = [
    ['参数数', d.parameters], ['有效观测行', d.observations], ['秩', d.rank], ['自由度', d.degrees_of_freedom],
    ['零空间', d.nullity], ['条件数', d.condition_number === null ? '∞' : fmt(d.condition_number, 2)],
    ['最小正特征值', d.smallest_positive_eigenvalue], ['RMS', fmt(d.rms, 4)],
    ['加权平方和', fmt(d.weighted_sum_squares, 4)], ['收敛', d.converged ? '是' : '否'],
  ];
  $('diagnostics').innerHTML = `<div class="grid">${metrics.map(([name, value]) => `<div class="metric"><span>${name}</span><b>${typeof value === 'number' ? fmt(value, 6) : value}</b></div>`).join('')}</div>`;
  const defects = state.result.rankDefects;
  $('defects').innerHTML = defects.length ? defects.map((defect) => `<div class="metric"><b class="${defect.kind.startsWith('translation') ? 'warn' : 'bad'}">${defect.label}</b><span>${defect.component_id}: ${defect.station_ids.join(', ')}</span></div>`).join('') : '<span class="good">主网无秩亏。</span>';
}

function renderLoops() {
  $('loops').innerHTML = state.result.loops.map((loop) => `
    <div class="metric">
      <b>${loop.id}: ${loop.station_ids.join(' → ')} → ${loop.station_ids[0]}</b>
      <p>原始闭合差 ${vectorText(loop.raw_misclosure)}；水平 ${fmt(loop.raw_horizontal)} m；垂向 ${fmt(loop.raw_vertical)} m；三维 ${fmt(loop.raw_3d)} m；导线长 ${fmt(loop.length)} m。</p>
      <p>平差后闭合差 ${vectorText(loop.adjusted_misclosure)}，观测：${loop.observation_ids.join(', ')}</p>
    </div>`).join('') || '<p>没有度量独立闭合环。</p>';
  $('reciprocals').innerHTML = state.result.reciprocalChecks.map((item) => `
    <span class="badge">${item.forward_observation_id} ↔ ${item.reverse_observation_id}</span>
    方位差 ${fmt(item.azimuth_difference_deg, 3)}°，倾角闭合 ${fmt(item.inclination_difference_deg, 3)}°，距离差 ${fmt(item.distance_difference, 3)} m
  `).join('<br>') || '<p>无往返边。</p>';
}

function drawEllipsoids() {
  const canvas = $('ellipsoidCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const step = canvas.width / state.result.coordinates.length;
  state.result.coordinates.forEach((coordinate, index) => {
    const cx = step * index + step / 2;
    const cy = canvas.height / 2;
    const axes = coordinate.ellipsoid.axes;
    const scale = Math.max(...axes, 0.05) ? 68 / Math.max(0.05, ...axes) : 1;
    const colors = ['#ff7b72', '#7ee787', '#79c0ff'];
    for (let a = 0; a < 3; a += 1) {
      for (let b = a + 1; b < 3; b += 1) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.strokeStyle = colors[3 - (a + b)];
        ctx.globalAlpha = 0.78;
        ctx.beginPath();
        ctx.ellipse(0, 0, Math.max(1, axes[a] * scale), Math.max(1, axes[b] * scale), 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.fillStyle = coordinate.ellipsoid.rank_deficient ? '#ff7b72' : '#e6edf3';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${coordinate.station_id}·${coordinate.name}`, cx, canvas.height - 28);
    ctx.fillStyle = coordinate.locked ? '#f2cc60' : '#9da7b3';
    ctx.fillText(coordinate.locked ? '锁定' : `rank ${coordinate.ellipsoid.rank}`, cx, canvas.height - 10);
    ctx.textAlign = 'left';
  });
}

function drawResiduals() {
  const canvas = $('residualCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const residuals = state.result.residuals;
  if (!residuals.length) return;
  const maxAbs = Math.max(0.01, ...residuals.map((item) => Math.abs(item.residual ?? 0)));
  const width = (canvas.width - 80) / residuals.length;
  ctx.strokeStyle = '#30363d';
  ctx.beginPath();
  ctx.moveTo(45, canvas.height / 2);
  ctx.lineTo(canvas.width - 20, canvas.height / 2);
  ctx.stroke();
  residuals.forEach((item, index) => {
    const height = Math.abs(item.residual ?? 0) / maxAbs * (canvas.height / 2 - 45);
    const x = 55 + index * width;
    const y = canvas.height / 2 - (item.residual ?? 0 >= 0 ? height : 0);
    ctx.fillStyle = item.active_source === 'flip_candidate' ? '#f0883e' : item.type === 'distance' ? '#58a6ff' : item.type === 'azimuth' ? '#d29922' : '#7ee787';
    ctx.fillRect(x, y, Math.max(2, width * 0.65), Math.max(1, height));
    if (index % 3 === 0) {
      ctx.save();
      ctx.translate(x + 2, canvas.height / 2 + 12);
      ctx.rotate(-Math.PI / 3);
      ctx.fillStyle = '#9da7b3';
      ctx.font = '9px sans-serif';
      ctx.fillText(item.row, 0, 0);
      ctx.restore();
    }
  });
  ctx.fillStyle = '#9da7b3';
  ctx.font = '12px sans-serif';
  ctx.fillText(`最大绝对残差 ${fmt(maxAbs, 4)}（距离 m / 角度 °）`, 12, 20);
}

function renderResidualTable() {
  $('residuals').innerHTML = `<table><thead><tr><th>行</th><th>来源</th><th>方向</th><th>观测</th><th>计算</th><th>残差</th><th>修正</th><th>σ</th><th>v/σ</th></tr></thead><tbody>
    ${state.result.residuals.map((item) => `<tr><td>${item.row}</td><td>${item.active_source === 'flip_candidate' ? '翻转候选' : '原观测'}</td><td>${item.from_station_id}→${item.to_station_id}</td><td>${fmt(item.observed, 4)}</td><td>${fmt(item.computed, 4)}</td><td>${fmt(item.residual, 4)}</td><td>${fmt(item.correction, 4)}</td><td>${fmt(item.sigma, 3)}</td><td>${fmt(item.weighted_residual, 3)}</td></tr>`).join('')}
  </tbody></table>
$('coordinates').innerHTML = `<table><thead><tr><th>站点</th><th>名称</th><th>X</th><th>Y</th><th>Z</th><th>σX</th><th>σY</th><th>σZ</th><th>状态</th></tr></thead><tbody>
    ${state.result.coordinates.map((item) => `<tr><td>${item.station_id}</td><td>${item.name}</td><td>${fmt(item.x, 4)}</td><td>${fmt(item.y, 4)}</td><td>${fmt(item.z, 4)}</td><td>${fmt(item.sigma_x, 4)}</td><td>${fmt(item.sigma_y, 4)}</td><td>${fmt(item.sigma_z, 4)}</td><td>${item.locked ? '锁定' : item.ellipsoid.rank_deficient ? '<span class="bad">秩亏</span>' : '自由'}</td></tr>`).join('')}
  </tbody></table>`;
}

async function renderRuns() {
  const data = await api('/api/runs');
  $('runs').innerHTML = `<div class="table-wrap"><table><thead><tr><th>#</th><th>时间</th><th>动作</th><th>环数</th><th>秩</th><th>零空间</th><th>RMS</th></tr></thead><tbody>
    ${data.map((run) => `<tr><td>${run.id}</td><td>${run.created_at}</td><td>${run.action}</td><td>${run.result.summary.independent_ring_count}</td><td>${run.result.diagnostics.rank}</td><td>${run.result.diagnostics.nullity}</td><td>${fmt(run.result.diagnostics.rms, 5)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

$('rerun').addEventListener('click', async () => {
  await api('/api/adjust', {});
  await refresh('已重新平差并记录。');
});
$('lockToggle').addEventListener('click', async () => {
  const station = state.stations.find((item) => item.id === $('stationSelect').value);
  await api('/api/stations/lock', { station_id: station.id, locked: !station.locked });
  await refresh(`${station.locked ? '已解锁' : '已锁定'} ${station.id}`);
});
$('weightButton').addEventListener('click', async () => {
  await api('/api/observations/weight', { observation_id: $('observationSelect').value, weight: Number($('weightInput').value) });
  await refresh('权重已更新；原始观测值未改写。');
});
$('flipToggle').addEventListener('click', async () => {
  const candidate = state.flip_candidates.find((item) => item.id === $('flipSelect').value);
  if (!candidate) return;
  await api('/api/flips/toggle', { candidate_id: candidate.id, active: !candidate.active });
  await refresh(`${candidate.active ? '已停用' : '已启用'}翻转候选。`);
});
$('createFlip').addEventListener('click', async () => {
  await api('/api/flips', { observation_id: $('observationSelect').value, active: true });
  await refresh('翻转候选已创建并启用；原观测仍保留。');
});
$('export').addEventListener('click', async () => {
  const bundle = await api('/api/export');
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `underground-loop-runs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(url);
});
$('reset').addEventListener('click', async () => {
  await api('/api/reset', {});
  await refresh('数据库已清空并重新导入固定 fixture。');
});
$('import').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const parsed = JSON.parse(await file.text());
  await api('/api/import', { fixture: parsed.fixture ?? parsed });
  await refresh('导入完成，平差结果已复核。');
});

refresh().catch((error) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#ff7b72">${error.stack}</pre>`;
});
