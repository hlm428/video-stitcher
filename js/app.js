/**
 * 视频拼接小工具
 * - 优先 ffmpeg.wasm（0.12 单线程核心，GitHub Pages 无 COOP/COEP 也能跑）
 * - 跑不动就生成完整 ffmpeg 命令（含字幕烧录）一键复制
 * - 项目元数据存 localStorage，文件本体存 IndexedDB，刷新/重开不丢
 */

const state = {
  clips: [], // { id, name, blob, dur, start, end, thumb }
  narration: null, // { name, blob }
  bgm: null,
  srt: null, // { name, text }
  fade: 0.125,
};

const $ = (id) => document.getElementById(id);

/* ---------- IndexedDB（文件本体） ---------- */

const DB_NAME = 'video-stitcher';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('files')) req.result.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(value, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readonly');
    const r = tx.objectStore('files').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

/* ---------- 项目持久化 ---------- */

const META_KEY = 'stitcher-project';

function saveProject() {
  try {
    const meta = {
      fade: state.fade,
      out720: $('out720').checked,
      out480: $('out480').checked,
      clips: state.clips.map((c) => ({ id: c.id, name: c.name, dur: c.dur, start: c.start, end: c.end })),
      narName: state.narration ? state.narration.name : null,
      bgmName: state.bgm ? state.bgm.name : null,
      srtName: state.srt ? state.srt.name : null,
    };
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* 忽略超限 */
  }
}

async function restoreProject() {
  const raw = localStorage.getItem(META_KEY);
  if (!raw) return;
  try {
    const meta = JSON.parse(raw);
    state.fade = meta.fade ?? 0.125;
    $('fadeInput').value = state.fade;
    $('out720').checked = meta.out720 !== false;
    $('out480').checked = meta.out480 !== false;
    for (const cm of meta.clips || []) {
      const blob = await idbGet('clip:' + cm.id);
      if (blob) addClip(cm.name, blob, cm.start, cm.end, cm.dur);
    }
    if (meta.narName) {
      const b = await idbGet('audio:' + meta.narName);
      if (b) setNarration(meta.narName, b);
    }
    if (meta.bgmName) {
      const b = await idbGet('audio:' + meta.bgmName);
      if (b) setBgm(meta.bgmName, b);
    }
    if (meta.srtName) {
      const t = await idbGet('srt:' + meta.srtName);
      if (t) setSrt(meta.srtName, t);
    }
    updateExportEnabled();
  } catch {
    /* 恢复失败就从空开始 */
  }
}

/* ---------- 片段管理 ---------- */

function fmt(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

async function probeDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const d = Number.isFinite(el.duration) ? el.duration : 10;
      URL.revokeObjectURL(url);
      resolve(d);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(10);
    };
    el.src = url;
  });
}

async function makeThumb(blob, atSec = 0.5) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement('video');
    el.preload = 'auto';
    el.muted = true;
    el.onloadeddata = () => {
      el.currentTime = Math.min(atSec, (el.duration || 1) / 2);
    };
    el.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        canvas.getContext('2d').drawImage(el, 0, 0, 160, 90);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        URL.revokeObjectURL(url);
        resolve(null);
      }
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    setTimeout(() => resolve(null), 4000);
    el.src = url;
  });
}

async function addClip(name, blob, start = 0, end = null, knownDur = null) {
  const dur = knownDur || (await probeDuration(blob));
  const id = 'c' + Date.now() + Math.random().toString(36).slice(2, 6);
  const clip = { id, name, blob, dur, start, end: end ?? dur };
  state.clips.push(clip);
  await idbPut('clip:' + id, blob);
  await ensureThumb(clip);
  renderClips();
  updateExportEnabled();
  saveProject();
}

async function ensureThumb(clip) {
  if (clip.thumb) return;
  clip.thumb = await makeThumb(clip.blob);
  renderClips();
}

/* ---------- 渲染片段列表（拖拽排序 + 剪裁） ---------- */

let dragId = null;

function renderClips() {
  const list = $('clipList');
  list.innerHTML = '';
  if (state.clips.length === 0) {
    list.innerHTML = '<p class="empty">还没有片段。上传后在这里拖动排序、剪头去尾。</p>';
    return;
  }
  state.clips.forEach((c, idx) => {
    const card = document.createElement('div');
    card.className = 'clipCard';
    card.draggable = true;
    card.ondragstart = () => (dragId = c.id);
    card.ondragover = (e) => e.preventDefault();
    card.ondrop = async (e) => {
      e.preventDefault();
      if (!dragId || dragId === c.id) return;
      const from = state.clips.findIndex((x) => x.id === dragId);
      const to = state.clips.findIndex((x) => x.id === c.id);
      const [moved] = state.clips.splice(from, 1);
      state.clips.splice(to, 0, moved);
      dragId = null;
      renderClips();
      saveProject();
    };
    const valid = c.end > c.start;
    card.innerHTML = `
      <div class="clipThumb">${c.thumb ? `<img src="${c.thumb}" alt="" />` : '<span class="thumbPh">🎬</span>'}</div>
      <div class="clipInfo">
        <div class="clipName">${idx + 1}. ${c.name}</div>
        <div class="clipDur">时长 ${fmt(c.dur)} · 有效 ${valid ? fmt(c.end - c.start) : '⚠️ 无效区间'}</div>
        <div class="clipTrim">
          剪头<input type="number" step="0.1" min="0" max="${c.dur}" value="${c.start}" data-f="start" data-id="${c.id}" />s
          剪尾<input type="number" step="0.1" min="0" max="${c.dur}" value="${c.end}" data-f="end" data-id="${c.id}" />s
        </div>
      </div>
      <div class="clipOps">
        <span class="dragHandle" title="拖动排序">⠿</span>
        <button class="delBtn" data-del="${c.id}" title="移除">🗑️</button>
      </div>`;
    list.appendChild(card);
  });
  // 剪裁输入
  for (const inp of list.querySelectorAll('input[data-f]')) {
    inp.onchange = () => {
      const clip = state.clips.find((x) => x.id === inp.dataset.id);
      if (!clip) return;
      const v = Number(inp.value);
      if (inp.dataset.f === 'start') clip.start = Math.max(0, Math.min(v, clip.end - 0.1));
      else clip.end = Math.min(clip.dur, Math.max(v, clip.start + 0.1));
      renderClips();
      saveProject();
    };
  }
  for (const b of list.querySelectorAll('[data-del]')) {
    b.onclick = () => {
      state.clips = state.clips.filter((x) => x.id !== b.dataset.del);
      renderClips();
      updateExportEnabled();
      saveProject();
    };
  }
}

/* ---------- 上传交互 ---------- */

async function handleFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('video/')) continue;
    await addClip(f.name, f);
  }
  $('stepEdit').scrollIntoView({ behavior: 'smooth' });
}

const dz = $('dropZone');
dz.ondragover = (e) => {
  e.preventDefault();
  dz.classList.add('over');
};
dz.ondragleave = () => dz.classList.remove('over');
dz.ondrop = (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  handleFiles([...e.dataTransfer.files]);
};
$('fileInput').onchange = (e) => {
  handleFiles([...e.target.files]);
  e.target.value = '';
};

/* ---------- 音频/字幕 ---------- */

function setNarration(name, blob) {
  state.narration = { name, blob };
  $('narName').textContent = name;
}
function setBgm(name, blob) {
  state.bgm = { name, blob };
  $('bgmName').textContent = name;
}
function setSrt(name, text) {
  state.srt = { name, text };
  $('srtName').textContent = name;
}

$('narInput').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) {
    setNarration(f.name, f);
    await idbPut('audio:' + f.name, f);
    saveProject();
  }
  e.target.value = '';
};
$('bgmInput').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) {
    setBgm(f.name, f);
    await idbPut('audio:' + f.name, f);
    saveProject();
  }
  e.target.value = '';
};
$('srtInput').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) {
    const text = await f.text();
    setSrt(f.name, text);
    await idbPut('srt:' + f.name, text);
    saveProject();
  }
  e.target.value = '';
};

/* ---------- 柑橘预设 ---------- */

$('presetBtn').onclick = () => {
  $('fadeInput').value = '0.125';
  state.fade = 0.125;
  $('out720').checked = true;
  $('out480').checked = true;
  // 剪裁到每段正好 10 秒（0 → 10；接缝 9.875/19.75/…）
  state.clips.forEach((c, i) => {
    c.start = 0;
    c.end = Math.min(c.dur, 10);
    void i;
  });
  renderClips();
  saveProject();
  const seams = [9.875, 19.75, 29.625, 39.5, 49.375].map((s) => s + 's').join(' / ');
  $('wasmStatus').textContent = `🍊 已填入柑橘预设：6 段 × 10s · fade 0.125s · 接缝 ${seams} · -16 LUFS · 720p + 480p`;
};

$('fadeInput').onchange = () => {
  state.fade = Math.max(0, Number($('fadeInput').value) || 0.125);
  saveProject();
};
$('out720').onchange = saveProject;
$('out480').onchange = saveProject;

/* ---------- 导出参数与命令 ---------- */

function effectiveClips() {
  return state.clips
    .map((c) => ({ ...c, len: Math.max(0.1, c.end - c.start) }))
    .filter((c) => c.len > 0.05);
}

function updateExportEnabled() {
  const ok = effectiveClips().length >= 1 && ($('out720').checked || $('out480').checked);
  $('exportBtn').disabled = !ok;
  $('cmdBtn').disabled = !ok;
}

/** ffmpeg.wasm 参数（无字幕：核心不含 libass，字幕走命令版） */
function buildWasmArgs(outName, width, height, withAudio) {
  const clips = effectiveClips();
  const fade = state.fade;
  const args = [];
  for (const c of clips) args.push('-ss', String(c.start), '-to', String(c.end), '-i', c.name);
  let narIdx = clips.length;
  let bgmIdx = -1;
  if (state.narration) {
    args.push('-i', 'narration');
    narIdx = clips.length;
    bgmIdx = narIdx + 1;
    if (state.bgm) args.push('-i', 'bgm');
  } else if (state.bgm) {
    args.push('-i', 'bgm');
    narIdx = -1;
    bgmIdx = clips.length;
  }

  const filters = [];
  const chains = [];
  clips.forEach((c, i) => {
    const f = [];
    f.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
    f.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`);
    f.push('setsar=1');
    f.push(`fade=t=in:st=0:d=${fade}`);
    f.push(`fade=t=out:st=${Math.max(0, c.len - fade).toFixed(3)}:d=${fade}`);
    chains.push(`[${i}:v]${f.join(',')}[v${i}]`);
  });
  // 音频链
  let audioLabel = null;
  if (withAudio) {
    if (narIdx >= 0 && bgmIdx >= 0) {
      chains.push(`[${narIdx}:a]aresample=44100[nar]`);
      chains.push(`[${bgmIdx}:a]volume=0.178[bgm]`);
      chains.push('[nar][bgm]amix=inputs=2:duration=first:dropout_transition=2[mix]');
      audioLabel = 'mix';
    } else if (narIdx >= 0) {
      chains.push(`[${narIdx}:a]aresample=44100[nar]`);
      audioLabel = 'nar';
    } else if (bgmIdx >= 0) {
      chains.push(`[${bgmIdx}:a]aresample=44100[bgm0]`);
      audioLabel = 'bgm0';
    } else {
      // 没有外挂音频：拼接片段自带的音轨（单段也兼容 concat n=1）
      clips.forEach((_, i) => chains.push(`[${i}:a]aresample=44100[a${i}]`));
      const aIn = clips.map((_, i) => `[a${i}]`).join('');
      chains.push(`${aIn}concat=n=${clips.length}:v=0:a=1[acat]`);
      audioLabel = 'acat';
    }
  }
  const concatIn = clips.map((_, i) => `[v${i}]`).join('');
  const concat = `concat=n=${clips.length}:v=1:a=0[vout]`;
  const loud = withAudio && audioLabel ? `;[${audioLabel}]loudnorm=I=-16:TP=-1.5:LRA=11[aout]` : '';
  const filterComplex = [...chains, `${concatIn}${concat}`].join(';') + loud;
  args.push('-filter_complex', filterComplex, '-map', '[vout]');
  if (loud) args.push('-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p');
  if (loud) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-y', outName);
  return args;
}

/** 本地完整命令（含字幕烧录 + 双分辨率） */
function buildCommand() {
  const clips = effectiveClips();
  const fade = state.fade;
  const inputs = clips.map((c, i) => `-ss ${c.start} -to ${c.end} -i in${i}.mp4`).join(' \\\n  ');
  const chains = [];
  clips.forEach((_, i) => {
    const f = [];
    f.push('scale=1280:720:force_original_aspect_ratio=decrease');
    f.push('pad=1280:720:(ow-iw)/2:(oh-ih)/2');
    f.push('setsar=1');
    f.push(`fade=t=in:st=0:d=${fade}`);
    f.push(`fade=t=out:st=${Math.max(0, clips[i].len - fade).toFixed(3)}:d=${fade}`);
    chains.push(`[${i}:v]${f.join(',')}[v${i}]`);
  });
  let tail = '';
  let mapV = '[vout]';
  let mapA = '';
  let audioInputs = '';
  let extra = [];
  let idx = clips.length;
  const hasNar = !!state.narration;
  const hasBgm = !!state.bgm;
  if (hasNar) {
    audioInputs += ` \\\n  -i narration.mp3`;
    if (hasBgm) {
      audioInputs += ` \\\n  -i bgm.mp3`;
      chains.push(`[${idx}:a]volume=0.178[bgm]`);
      chains.push(`[${idx + 1}:a]anull[nar]`);
      chains.push(`[nar][bgm]amix=inputs=2:duration=first:dropout_transition=2[mix]`);
      tail += `;[mix]loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
    } else {
      chains.push(`[${idx}:a]anull[nar0]`);
      tail += `;[nar0]loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
    }
    mapA = '-map [aout]';
  } else if (hasBgm) {
    audioInputs += ` \\\n  -i bgm.mp3`;
    chains.push(`[${idx}:a]volume=0.178[bgm0]`);
    tail += `;[bgm0]loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
    mapA = '-map [aout]';
  }
  const concatIn = clips.map((_, i) => `[v${i}]`).join('');
  chains.push(`${concatIn}concat=n=${clips.length}:v=1:a=0[vout]`);
  const filterComplex = chains.join(';') + tail;
  const srtFilter = state.srt ? `,subtitles=${state.srt.name}:force_style='FontName=Noto Sans CJK SC,FontSize=18'` : '';
  const lines = [];
  lines.push('# ① 完整版 720p（接缝淡入淡出 + 混音 + -16 LUFS' + (state.srt ? ' + 字幕烧录' : '') + '）');
  lines.push(`ffmpeg ${inputs}${audioInputs} \\`);
  lines.push(`  -filter_complex "${filterComplex}" \\`);
  lines.push(`  -map ${mapV} ${mapA} \\`);
  lines.push(`  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k ${state.srt ? `-vf "subtitles=${state.srt.name}" ` : ''}-y output_720.mp4`);
  lines.push('');
  lines.push('# ② 手机版 480p');
  lines.push(`ffmpeg -i output_720.mp4 -vf "scale=854:480" -c:v libx264 -preset medium -crf 23 -c:a copy -y output_480.mp4`);
  lines.push('');
  lines.push('# 文件清单：' + clips.map((c, i) => `in${i}.mp4（← ${c.name}）`).join('、') + (hasNar ? '、narration.mp3' : '') + (hasBgm ? '、bgm.mp3' : '') + (state.srt ? `、${state.srt.name}` : ''));
  lines.push('# 接缝位置：' + clips.map((c, i) => (i < clips.length - 1 ? fmt(clips.slice(0, i + 1).reduce((s, x) => s + x.len, 0) - fade) : '—')).join(' / '));
  return lines.join('\n');
}

/* ---------- ffmpeg.wasm 加载与导出 ---------- */

let ffmpegReady = false;
const FF = () => window.FFmpegWASM.FFmpeg;
const UTIL = () => window.FFmpegUtil;

async function ensureFFmpeg() {
  if (ffmpegReady) return true;
  if (!window.FFmpegWASM) throw new Error('引擎脚本没加载出来（网络问题？刷新重试）');
  const ff = new FF();
  const { toBlobURL } = UTIL();
  $('wasmStatus').textContent = '首次加载核心（约 25MB）……';
  await ff.load({
    coreURL: await toBlobURL('https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js', 'text/javascript'),
    wasmURL: await toBlobURL('https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm', 'application/wasm'),
  });
  window.__ff = ff;
  ff.on('progress', ({ progress }) => {
    const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    $('progressBar').style.width = pct + '%';
    $('progressText').textContent = `处理中… ${pct}%`;
  });
  ffmpegReady = true;
  $('wasmStatus').textContent = '✅ 引擎就绪（单线程核心 · 浏览器内导出不支持烧字幕，字幕请用命令版）';
  return true;
}

function setProgress(show, text) {
  $('progressWrap').hidden = !show;
  if (text !== undefined) $('progressText').textContent = text;
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  const row = document.createElement('div');
  row.className = 'dlRow';
  row.innerHTML = `<span>✅ ${name}</span>`;
  $('downloadWrap').appendChild(row);
  $('downloadWrap').hidden = false;
}

$('exportBtn').onclick = async () => {
  const clips = effectiveClips();
  if (clips.length === 0) return;
  try {
    $('exportBtn').disabled = true;
    $('cmdBtn').disabled = true;
    await ensureFFmpeg();
    const ff = window.__ff;
    // 写入文件
    for (const c of clips) await ff.writeFile(c.name, new Uint8Array(await c.blob.arrayBuffer()));
    if (state.narration) await ff.writeFile('narration', new Uint8Array(await state.narration.blob.arrayBuffer()));
    if (state.bgm) await ff.writeFile('bgm', new Uint8Array(await state.bgm.blob.arrayBuffer()));
    const hasAudio = true; // 片段一般自带音轨；无音轨片段会在报错里提示
    const want720 = $('out720').checked;
    const want480 = $('out480').checked;
    if (want720) {
      setProgress(true, '导出 720p 完整版…');
      await ff.exec(buildWasmArgs('output_720.mp4', 1280, 720, hasAudio));
      const data = await ff.readFile('output_720.mp4');
      download('output_720.mp4', new Blob([data.buffer], { type: 'video/mp4' }));
    }
    if (want480) {
      setProgress(true, '导出 480p 手机版…');
      if (want720) {
        const src = await ff.readFile('output_720.mp4');
        await ff.writeFile('src720.mp4', new Uint8Array(src.buffer));
        await ff.exec(['-i', 'src720.mp4', '-vf', 'scale=854:480', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'copy', '-y', 'output_480.mp4']);
      } else {
        await ff.exec(buildWasmArgs('output_480.mp4', 854, 480, hasAudio));
      }
      const data = await ff.readFile('output_480.mp4');
      download('output_480.mp4', new Blob([data.buffer], { type: 'video/mp4' }));
    }
    setProgress(true, '✅ 导出完成');
    $('exportBtn').disabled = false;
    $('cmdBtn').disabled = false;
  } catch (err) {
    setProgress(false);
    $('wasmStatus').textContent = `❌ 浏览器导出失败：${err.message || err}——文件大/内存不够时，用下面的「生成命令」本地跑。`;
    $('exportBtn').disabled = false;
    $('cmdBtn').disabled = false;
  }
};

/* ---------- 命令模式 ---------- */

$('cmdBtn').onclick = () => {
  $('cmdText').textContent = buildCommand();
  $('cmdBox').hidden = false;
};
$('copyCmd').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('cmdText').textContent);
    $('copyCmd').textContent = '✅ 已复制';
    setTimeout(() => ($('copyCmd').textContent = '📋 一键复制'), 1500);
  } catch {
    $('copyCmd').textContent = '复制失败，请手动选中';
  }
};

/* ---------- 启动 ---------- */

renderClips();
restoreProject();
