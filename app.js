// MeetNotes MVP: capture mic + system audio, transcribe locally with Whisper, keep timestamped notes.
const SR = 16000;
const $ = (s) => document.querySelector(s);
const els = {
  title: $('#title'), mic: $('#mic'), model: $('#model'), sys: $('#sys'), consent: $('#consent'),
  newBtn: $('#newBtn'), recBtn: $('#recBtn'), clock: $('#clock'), status: $('#status'), statusbar: $('#statusbar'),
  queue: $('#queue'), library: $('#library'), transcript: $('#transcript'), notesList: $('#notesList'),
  noteInput: $('#noteInput'), pauseBtn: $('#pauseBtn'), search: $('#search'), copyAi: $('#copyAi'), exportMd: $('#exportMd'), exportAudio: $('#exportAudio'), delBtn: $('#delBtn'),
};

// ---------- storage (IndexedDB) ----------
let dbp;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('meetnotes', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('meetings', { keyPath: 'id' });
      r.result.createObjectStore('audio');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}
const dbPut = (m) => tx('meetings', 'readwrite', (s) => s.put(m));
const dbGet = (id) => tx('meetings', 'readonly', (s) => s.get(id));
const dbAll = () => tx('meetings', 'readonly', (s) => s.getAll());
const dbDel = async (id) => { await tx('meetings', 'readwrite', (s) => s.delete(id)); await tx('audio', 'readwrite', (s) => s.delete(id)); };
const audioPut = (id, blob) => tx('audio', 'readwrite', (s) => s.put(blob, id));
const audioGet = (id) => tx('audio', 'readonly', (s) => s.get(id));

// ---------- helpers ----------
function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
function setStatus(msg, err = false) {
  els.status.textContent = msg;
  els.statusbar.classList.toggle('err', err);
}
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
function downsample(buf, rate) {
  if (rate === SR) return buf;
  const ratio = rate / SR;
  const out = new Float32Array(Math.floor(buf.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const s = Math.floor(i * ratio), e = Math.min(buf.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = s; j < e; j++) sum += buf[j];
    out[i] = sum / (e - s || 1);
  }
  return out;
}
function concat(parts, len) {
  const out = new Float32Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- voice-activity segmenter (one per audio source) ----------
class Segmenter {
  constructor(who, rate, emit) {
    Object.assign(this, { who, rate, emit });
    this.floor = 0.005; // adaptive noise floor
    this.pre = []; this.preLen = 0; // 0.4 s pre-roll so first words aren't clipped
    this.reset();
  }
  reset() { this.parts = []; this.len = 0; this.voiced = 0; this.silent = 0; this.start = null; }
  push(frame, tEnd) {
    const ds = downsample(frame, this.rate);
    let sum = 0;
    for (let i = 0; i < ds.length; i++) sum += ds[i] * ds[i];
    const rms = Math.sqrt(sum / ds.length);
    this.floor = rms < this.floor ? rms : this.floor * 1.002; // min-tracker: fast down, slow up
    const speaking = rms > Math.max(0.006, this.floor * 2.5);

    if (this.start === null) {
      if (!speaking) {
        this.pre.push(ds); this.preLen += ds.length;
        while (this.preLen > 0.4 * SR && this.pre.length > 1) this.preLen -= this.pre.shift().length;
        return;
      }
      this.start = Math.max(0, tEnd - ds.length / SR - this.preLen / SR);
      this.parts = this.pre; this.len = this.preLen;
      this.pre = []; this.preLen = 0;
    }
    this.parts.push(ds); this.len += ds.length;
    if (speaking) { this.voiced += ds.length; this.silent = 0; } else this.silent += ds.length;

    const secs = this.len / SR;
    if ((this.silent > 0.7 * SR && secs >= 3) || this.silent > 2 * SR || secs >= 15) this.flush(); // 15 s cap keeps timestamps tight
  }
  flush() {
    if (this.start !== null && this.voiced > 0.3 * SR) {
      const audio = concat(this.parts, this.len);
      this.emit({ who: this.who, start: this.start, dur: this.len / SR, voiced: this.voiced / SR, audio });
    }
    this.reset();
  }
}

// ---------- settings: glossary, people, context ----------
const SETTINGS_KEY = 'meetnotes.settings';
const DEFAULT_SETTINGS = {
  glossary: `# One per line. Plain term = teach the spelling. "misheard -> Correct" = auto-fix.
Microsoft 365
Entra ID
Intune
Conditional Access
Teams
SharePoint
OneDrive
conditional excess | conditional axis -> Conditional Access
intra id | enter id -> Entra ID`,
  people: '# Name = role',
  about: '',
  bias: false,
};
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(next) {
  settings = { ...DEFAULT_SETTINGS, ...next };
  glossary = parseGlossary(settings.glossary);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const contentLines = (text) => (text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

function parseGlossary(text) {
  const terms = new Set();
  const fixes = [];
  for (const line of contentLines(text)) {
    const m = line.split(/\s*(?:->|=>|→)\s*/);
    if (m.length >= 2 && m.at(-1)) {
      const to = m.at(-1);
      terms.add(to);
      for (const wrong of m.slice(0, -1).join('|').split('|').map((w) => w.trim()).filter(Boolean)) {
        fixes.push({ re: new RegExp(`(?<![\\w'])${escRe(wrong)}(?![\\w'])`, 'gi'), to });
      }
    } else terms.add(line);
  }
  return { terms: [...terms], fixes };
}
function people() {
  return contentLines(settings.people).map((l) => {
    const [name, ...role] = l.split('=');
    return { name: name.trim(), role: role.join('=').trim() };
  }).filter((p) => p.name);
}
function applyFixes(text) {
  for (const f of glossary.fixes) text = text.replace(f.re, f.to);
  return text;
}
let settings = loadSettings();
let glossary = parseGlossary(settings.glossary);

function whisperPrompt() {
  if (!settings.bias) return '';
  const words = [...glossary.terms, ...people().map((p) => p.name)];
  return words.length ? `${words.join(', ')}.` : '';
}
function contextBlock() {
  const parts = [];
  if (settings.about.trim()) parts.push(`About me:\n${settings.about.trim()}`);
  const ppl = people();
  if (ppl.length) parts.push(`People who may come up (use these spellings, and these roles to infer owners):\n${ppl.map((p) => `- ${p.name}${p.role ? ` = ${p.role}` : ''}`).join('\n')}`);
  if (glossary.terms.length) parts.push(`Terms used in my work (prefer these spellings):\n${glossary.terms.join(', ')}`);
  return parts.length ? `Context:\n\n${parts.join('\n\n')}\n\n` : '';
}

// ---------- transcription worker ----------
const worker = new Worker('worker.js', { type: 'module' });
let modelReady = false, loadedModel = null;
const pending = new Map();
let nextId = 0;
const fileProgress = {};

worker.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    fileProgress[m.file] = m.progress;
    const vals = Object.values(fileProgress);
    const pct = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    setStatus(`Downloading model (first run only)… ${pct}%`);
  } else if (m.type === 'ready') {
    modelReady = true;
    setStatus(`Model ready: ${m.repo} on ${m.device === 'webgpu' ? 'GPU' : 'CPU (slower)'}`);
  } else if (m.type === 'error') {
    setStatus(`Model error: ${m.message}`, true);
  } else if (m.type === 'result') {
    await onResult(m);
  } else if (m.type === 'bias-failed') {
    console.warn('Glossary steering failed:', m.message);
    saveSettings({ ...settings, bias: false });
    setStatus('Glossary steering isn\'t supported by this model, so it was turned off. Auto-fixes still apply.', true);
  }
};

function loadModel() {
  const want = els.model.value;
  if (loadedModel === want) return;
  loadedModel = want; modelReady = false;
  for (const k in fileProgress) delete fileProgress[k];
  setStatus('Loading model…');
  worker.postMessage({ type: 'load', model: want });
}
els.model.onchange = loadModel;

function updateQueue() {
  const n = pending.size;
  els.queue.textContent = n ? `Transcribing… ${n} queued${n > 6 ? ' (falling behind, try a smaller model)' : ''}` : '';
}

const JUNK = /^(\[.*\]|\(.*\)|\*.*\*|thanks for watching!?|please subscribe.*|\.+|-+)$/i;
const MAYBE_JUNK = /^(thank you\.?|you\.?|bye\.?|okay\.?)$/i;

function onChunk(c) {
  const id = nextId++;
  pending.set(id, { mid: meeting.id, who: c.who, start: c.start, dur: c.dur, voiced: c.voiced });
  worker.postMessage({ type: 'transcribe', id, audio: c.audio, prompt: whisperPrompt() }, [c.audio.buffer]);
  updateQueue();
}

async function onResult({ id, text, error }) {
  const p = pending.get(id);
  pending.delete(id);
  updateQueue();
  if (!p) return;
  if (error) { console.warn('Transcription error', error); return; }
  text = applyFixes(text || '');
  if (!text || JUNK.test(text) || (MAYBE_JUNK.test(text) && p.voiced < 1)) return; // Whisper hallucinations on near-silence
  const target = meeting && meeting.id === p.mid ? meeting : await dbGet(p.mid);
  if (!target) return;
  target.segments.push({ sid: crypto.randomUUID(), t: p.start, dur: p.dur, who: p.who, text });
  target.segments.sort((a, b) => a.t - b.t);
  await dbPut(target);
  if (target === meeting) renderTranscript();
}

// ---------- recording ----------
let meeting = null, recording = false, t0 = 0, paused = false, pausedAt = 0, pausedTotal = 0;
let ctx = null, streams = [], recorder = null, recChunks = [], wakeLock = null, tick = null;
const segmenters = [];
// Meeting time excludes paused stretches, so transcript times line up with the saved audio.
const now = () => ((paused ? pausedAt : performance.now()) - t0 - pausedTotal) / 1000;

async function startRecording() {
  if (!els.consent.checked) {
    setStatus('Tick "Participants informed" first. Recording without consent can breach NSW surveillance law.', true);
    els.consent.focus();
    return;
  }
  els.recBtn.disabled = true;
  try {
    // Screen-share prompt first: it needs the click's user activation.
    let sysStream = null;
    if (els.sys.checked) {
      try {
        const d = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          systemAudio: 'include', selfBrowserSurface: 'exclude',
        });
        if (d.getAudioTracks().length) sysStream = d;
        else { d.getTracks().forEach((t) => t.stop()); setStatus('No audio was shared. Pick "Entire screen" and turn on "Share system audio". Continuing with mic only.', true); }
      } catch { setStatus('System audio skipped. Continuing with mic only.', true); }
    }
    const micId = els.mic.value;
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    loadModel(); // no-op if already loaded; chunks queue behind it in the worker

    meeting = {
      id: crypto.randomUUID(),
      title: els.title.value.trim() || `Meeting ${new Date().toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}`,
      created: Date.now(), duration: 0, segments: [], notes: [], hasAudio: false,
    };
    els.title.value = meeting.title;

    ctx = new AudioContext();
    await ctx.audioWorklet.addModule('capture-worklet.js');
    const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
    const merger = ctx.createChannelMerger(2); // L = mic, R = system: keeps speakers separable for re-processing later
    const recDest = ctx.createMediaStreamDestination();
    merger.connect(recDest);

    const attach = (stream, who, channel) => {
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'capture');
      src.connect(node); node.connect(sink);
      src.connect(merger, 0, channel);
      const seg = new Segmenter(who, ctx.sampleRate, onChunk);
      node.port.onmessage = (e) => { if (recording && !paused) seg.push(e.data, now()); };
      segmenters.push(seg);
    };

    streams = [mic];
    attach(mic, sysStream ? 'Me' : 'Room', 0);
    if (sysStream) {
      streams.push(sysStream);
      attach(new MediaStream(sysStream.getAudioTracks()), 'Them', 1);
      sysStream.getAudioTracks()[0].addEventListener('ended', () => recording && setStatus('System audio sharing stopped. Still recording mic.', true));
    }

    recChunks = [];
    recorder = new MediaRecorder(recDest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 });
    recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recorder.start(10000);

    t0 = performance.now(); paused = false; pausedTotal = 0;
    recording = true;
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    tick = setInterval(() => { els.clock.textContent = (paused ? '⏸ ' : '') + fmt(now()); }, 500);
    await dbPut(meeting);
    enumerateMics();
    if (!els.statusbar.classList.contains('err')) setStatus(modelReady ? 'Recording' : 'Recording (model still loading, audio is queued)');
    setUi();
    renderAll();
    refreshLibrary();
  } catch (err) {
    setStatus(`Could not start: ${err.message}`, true);
    cleanupAudio();
  } finally {
    els.recBtn.disabled = false;
  }
}

function cleanupAudio() {
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  streams = [];
  segmenters.length = 0;
  if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  clearInterval(tick);
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}

async function pauseRecording() {
  if (!recording || paused) return;
  segmenters.forEach((s) => { s.flush(); s.pre = []; s.preLen = 0; });
  pausedAt = performance.now();
  paused = true;
  try { recorder.pause(); } catch {}
  setStatus('Paused. Nothing is being recorded or transcribed.');
  setUi();
}
async function resumeRecording(silent = false) {
  if (!paused) return;
  const secs = (performance.now() - pausedAt) / 1000;
  const at = now();
  pausedTotal += performance.now() - pausedAt;
  paused = false;
  if (!silent) { try { recorder.resume(); } catch {} }
  meeting.notes.push({ t: at, tag: 'pause', text: `Paused for ${fmt(secs)} (off the record)` });
  await dbPut(meeting);
  if (!silent) setStatus('Recording');
  setUi(); renderAll();
}
els.pauseBtn.onclick = () => (paused ? resumeRecording() : pauseRecording());

async function stopRecording() {
  if (paused) await resumeRecording(true);
  recording = false;
  segmenters.forEach((s) => s.flush());
  meeting.duration = now();
  await new Promise((res) => { recorder.onstop = res; recorder.stop(); });
  cleanupAudio();
  const blob = new Blob(recChunks, { type: 'audio/webm' });
  recChunks = [];
  await audioPut(meeting.id, blob);
  meeting.hasAudio = true;
  await dbPut(meeting);
  setStatus(pending.size ? 'Stopped. Finishing transcription…' : 'Stopped. Saved.');
  setUi();
  refreshLibrary();
}

els.recBtn.onclick = () => (recording ? stopRecording() : startRecording());
els.newBtn.onclick = () => {
  if (recording) return;
  meeting = null; els.title.value = ''; els.consent.checked = false; els.clock.textContent = '0:00';
  setUi(); renderAll(); refreshLibrary();
};
els.title.onchange = async () => {
  if (!meeting) return;
  meeting.title = els.title.value.trim() || meeting.title;
  await dbPut(meeting); refreshLibrary();
};

// ---------- notes ----------
// Prefixes: "a:" action, "d:" decision, "q:" question. Pauses are stored as notes with tag "pause".
const TAGS = {
  a: { key: 'action', label: 'Action', icon: '✅' },
  d: { key: 'decision', label: 'Decision', icon: '⚖️' },
  q: { key: 'question', label: 'Question', icon: '❓' },
};
const TAG_BY_KEY = Object.fromEntries(Object.values(TAGS).map((x) => [x.key, x]));
function parseNote(raw) {
  const m = raw.match(/^([adq])\s*[:.]\s*(.+)$/i);
  return m ? { tag: TAGS[m[1].toLowerCase()].key, text: m[2].trim() } : { tag: null, text: raw };
}
const noteIcon = (n) => (n.tag === 'pause' ? '⏸' : TAG_BY_KEY[n.tag]?.icon || '📝');
const noteLabel = (n) => (TAG_BY_KEY[n.tag] ? `**${TAG_BY_KEY[n.tag].label}:** ` : '');
els.noteInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || !meeting) return;
  const text = els.noteInput.value.trim();
  if (!text) return;
  meeting.notes.push({ t: recording ? now() : meeting.duration, ...parseNote(text) });
  els.noteInput.value = '';
  await dbPut(meeting);
  renderNotes();
  renderTranscript();
});

// ---------- rendering ----------
function setUi() {
  els.recBtn.textContent = recording ? 'Stop' : 'Start';
  els.recBtn.className = recording ? 'rec' : 'primary';
  els.pauseBtn.hidden = !recording;
  els.pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  els.pauseBtn.className = paused ? 'primary' : '';
  document.title = `${paused ? '⏸ ' : recording ? '🔴 ' : ''}MeetNotes v1.3`;
  [els.model, els.mic, els.sys, els.newBtn].forEach((x) => (x.disabled = recording));
  const has = !!meeting;
  els.noteInput.disabled = !has;
  els.copyAi.disabled = els.exportMd.disabled = !has;
  els.exportAudio.disabled = !has || !meeting.hasAudio;
  els.delBtn.disabled = !has || recording;
}

function renderTranscript() {
  const box = els.transcript;
  if (box.contains(document.activeElement)) { // don't wipe a correction in progress
    document.activeElement.addEventListener('blur', () => setTimeout(renderTranscript), { once: true });
    return;
  }
  const pane = box.parentElement;
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 60;
  box.innerHTML = '';
  if (!meeting || (!meeting.segments.length && !meeting.notes.length)) {
    box.innerHTML = `<p class="empty">${recording ? 'Listening…' : 'Press Start. Use headphones on calls so your mic doesn\'t pick up the other side.'}</p>`;
    return;
  }
  for (const e of timeline(meeting)) {
    if (e.note) {
      const n = document.createElement('div');
      n.className = `seg inline-note ${e.note.tag || ''}`;
      n.innerHTML = `<time>${fmt(e.t)}</time><b>${noteIcon(e.note)}</b>`;
      n.append(Object.assign(document.createElement('span'), { textContent: e.note.text }));
      if (matches(e.note.text)) n.classList.add('hit');
      box.append(n);
      continue;
    }
    const s = e.seg;
    const row = document.createElement('div');
    row.className = 'seg';
    row.innerHTML = `<time>${fmt(s.t)}</time><b class="${s.who}">${s.who}</b>`;
    const span = document.createElement('span');
    span.contentEditable = 'true';
    span.textContent = s.text;
    span.title = 'Click to correct';
    span.onblur = async () => { const v = span.textContent.trim(); if (v !== s.text) { s.text = v; await dbPut(meeting); } };
    row.append(span);
    if (matches(s.text)) row.classList.add('hit');
    box.append(row);
  }
  const firstHit = box.querySelector('.hit');
  if (firstHit && jumpToHit) { firstHit.scrollIntoView({ block: 'center' }); jumpToHit = false; }
  else if (atBottom) pane.scrollTop = pane.scrollHeight;
}

function renderNotes() {
  els.notesList.innerHTML = '';
  for (const n of (meeting?.notes || []).filter((x) => x.tag !== 'pause')) {
    const d = document.createElement('div');
    d.className = `note ${n.tag || ''}`;
    d.innerHTML = `<time>${fmt(n.t)}</time>${n.tag ? `${noteIcon(n)} ` : ''}`;
    d.append(document.createTextNode(n.text));
    els.notesList.append(d);
  }
  els.notesList.scrollTop = els.notesList.scrollHeight;
}

function renderAll() { renderTranscript(); renderNotes(); }

// ---------- search ----------
let query = [], jumpToHit = false;
const norm = (x) => (x || '').toLowerCase();
const matches = (text) => query.length > 0 && query.every((w) => norm(text).includes(w));
function meetingHits(m) {
  if (!query.length) return { ok: true, count: 0, snippet: '' };
  const texts = [m.title, ...m.notes.map((n) => n.text), ...m.segments.map((s) => s.text)];
  const all = norm(texts.join(' \n '));
  if (!query.every((w) => all.includes(w))) return { ok: false };
  const lines = texts.slice(1).filter((t) => query.some((w) => norm(t).includes(w)));
  const first = lines[0] || m.title;
  const i = Math.max(0, norm(first).indexOf(query[0]) - 30);
  return { ok: true, count: lines.length, snippet: (i ? '…' : '') + first.slice(i, i + 90) + (first.length > i + 90 ? '…' : '') };
}
let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    query = norm(els.search.value).split(/\s+/).filter(Boolean);
    refreshLibrary();
    renderTranscript();
  }, 200);
});

async function refreshLibrary() {
  const all = (await dbAll()).sort((a, b) => b.created - a.created);
  const shown = all.map((m) => ({ m, h: meetingHits(m) })).filter((x) => x.h.ok);
  els.library.innerHTML = shown.length ? '' : `<p class="empty">${all.length ? 'No matches' : 'No meetings yet'}</p>`;
  for (const { m, h } of shown) {
    const d = document.createElement('div');
    d.className = 'item' + (meeting?.id === m.id ? ' active' : '');
    d.textContent = m.title;
    const small = document.createElement('small');
    small.textContent = `${new Date(m.created).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })} · ${fmt(m.duration)}${h.count ? ` · ${h.count} hit${h.count === 1 ? '' : 's'}` : ''}`;
    d.append(small);
    if (h.snippet) d.append(Object.assign(document.createElement('small'), { className: 'snip', textContent: h.snippet }));
    d.onclick = async () => {
      if (recording) return;
      jumpToHit = query.length > 0;
      meeting = await dbGet(m.id);
      els.title.value = meeting.title;
      els.clock.textContent = fmt(meeting.duration);
      setUi(); renderAll(); refreshLibrary();
    };
    els.library.append(d);
  }
}

// ---------- export ----------
function toMarkdown(m) {
  const when = new Date(m.created).toLocaleString('en-AU', { dateStyle: 'full', timeStyle: 'short' });
  let md = `# ${m.title}\n\n_${when} · ${fmt(m.duration)}_\n\n`;
  const mine = m.notes.filter((n) => n.tag !== 'pause');
  for (const tag of Object.values(TAGS)) {
    const list = mine.filter((n) => n.tag === tag.key);
    if (list.length) md += `## ${tag.label}s I flagged\n\n${list.map((n) => `- [${fmt(n.t)}] ${n.text}`).join('\n')}\n\n`;
  }
  const plain = mine.filter((n) => !n.tag);
  if (plain.length) md += `## My notes\n\n${plain.map((n) => `- [${fmt(n.t)}] ${n.text}`).join('\n')}\n\n`;
  md += '## Transcript\n\n';
  // Paragraphs break on speaker change, a pause of 4 s+, or every 30 s, and each one gets its own time.
  // Notes are placed in the transcript at the moment they were typed.
  const out = [];
  let block = null;
  const close = () => {
    if (block) out.push(`**${block.who}** [${fmt(block.t)}]: ${block.text.join(' ')}`);
    block = null;
  };
  for (const e of timeline(m)) {
    if (e.note) { close(); out.push(`> ${noteIcon(e.note)} [${fmt(e.t)}] ${noteLabel(e.note)}${e.note.text}`); continue; }
    const s = e.seg;
    if (block && block.who === s.who && s.t - block.end < 4 && s.t - block.t < 30) {
      block.text.push(s.text);
      block.end = s.t + (s.dur || 0);
    } else {
      close();
      block = { who: s.who, t: s.t, end: s.t + (s.dur || 0), text: [s.text] };
    }
  }
  close();
  return md + out.join('\n\n') + '\n';
}

// Segments and notes merged in time order. A note typed during a segment lands after it.
function timeline(m) {
  return [
    ...m.segments.map((seg) => ({ t: seg.t, seg })),
    ...m.notes.map((note) => ({ t: note.t, note })),
  ].sort((a, b) => a.t - b.t || (a.note ? 1 : -1));
}

const AI_PROMPT = `You are my meeting-notes assistant. Below are my rough timestamped notes and a raw machine transcript ("Me" = me, "Them" = remote participants, "Room" = in-person audio). The transcript has recognition errors; correct obvious ones from context.

Produce, in Australian English:
1. Summary (3 to 5 lines)
2. Decisions made
3. Actions as a table: owner, action, due date if mentioned
4. Open questions / risks
5. My notes, expanded with the relevant detail from the transcript around each note's timestamp

Lines starting with 📝 ✅ ⚖️ or ❓ inside the transcript are my notes, placed at the moment I typed them; the speech just before each one is usually what it refers to. Notes I flagged as Action, Decision or Question are confirmed by me: always include them in the matching section, using the transcript to fill in owner and due date. ⏸ lines mark pauses; nothing was recorded during them. Treat "I" in "Me" or "Room" lines as me (Michael) when assigning action owners.

Use the context below for spellings, roles and likely owners, but do not invent anything that is not in the transcript or notes. Mark uncertain names or terms with (?).

`;

els.exportMd.onclick = () => meeting && download(`${safeName(meeting.title)}.md`, new Blob([toMarkdown(meeting)], { type: 'text/markdown' }));
els.copyAi.onclick = async () => {
  if (!meeting) return;
  await navigator.clipboard.writeText(AI_PROMPT + contextBlock() + '---\n\n' + toMarkdown(meeting));
  setStatus('Copied. Paste into Claude or Copilot.');
};
els.exportAudio.onclick = async () => {
  const blob = meeting && (await audioGet(meeting.id));
  if (blob) download(`${safeName(meeting.title)}.webm`, blob);
};
els.delBtn.onclick = async () => {
  if (!meeting || recording) return;
  if (!confirm(`Delete "${meeting.title}" and its audio?`)) return;
  await dbDel(meeting.id);
  meeting = null; els.title.value = '';
  setUi(); renderAll(); refreshLibrary();
};

// ---------- mic list ----------
async function enumerateMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const cur = els.mic.value;
    els.mic.innerHTML = '<option value="">Default mic</option>';
    devs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `Mic ${i + 1}`;
      els.mic.append(o);
    });
    els.mic.value = cur;
  } catch {}
}

// ---------- settings dialog ----------
const dlg = $('#settings');
const f = { glossary: $('#setGlossary'), people: $('#setPeople'), about: $('#setAbout'), bias: $('#setBias') };
const readForm = () => ({ glossary: f.glossary.value, people: f.people.value, about: f.about.value, bias: f.bias.checked });
function fillForm(x) { f.glossary.value = x.glossary; f.people.value = x.people; f.about.value = x.about; f.bias.checked = !!x.bias; }
$('#settingsBtn').onclick = () => { fillForm(settings); dlg.showModal(); };
$('#setCancel').onclick = () => dlg.close();
$('#setSave').onclick = () => {
  saveSettings(readForm());
  dlg.close();
  setStatus(`Settings saved: ${glossary.terms.length} terms, ${glossary.fixes.length} auto-fixes, ${people().length} people.`);
};
$('#setApply').onclick = async () => {
  saveSettings(readForm());
  if (!meeting) { setStatus('Open a meeting first.', true); return; }
  let changed = 0;
  for (const s of meeting.segments) { const v = applyFixes(s.text); if (v !== s.text) { s.text = v; changed++; } }
  await dbPut(meeting);
  renderTranscript();
  setStatus(`Fixed ${changed} line${changed === 1 ? '' : 's'} in "${meeting.title}".`);
};
$('#setExport').onclick = () => download('meetnotes-settings.json', new Blob([JSON.stringify(readForm(), null, 2)], { type: 'application/json' }));
$('#setImport').onclick = () => $('#setImportFile').click();
$('#setImportFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { fillForm({ ...DEFAULT_SETTINGS, ...JSON.parse(await file.text()) }); setStatus('Imported. Press Save to keep it.'); }
  catch { setStatus('That file isn\'t a MeetNotes settings export.', true); }
};

// ---------- boot ----------
window.addEventListener('beforeunload', (e) => { if (recording) { e.preventDefault(); e.returnValue = ''; } });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {}); // stop Edge evicting meetings under storage pressure
setUi();
enumerateMics();
refreshLibrary();
loadModel();
