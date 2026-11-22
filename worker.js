// Whisper transcription worker. Runs on WebGPU when available, WASM otherwise.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

env.allowLocalModels = false; // fetch from Hugging Face, cache in browser

let asr = null;
let device = 'wasm';
let queue = Promise.resolve();

async function hasWebGPU() {
  try {
    if (!navigator.gpu) return false;
    return !!(await navigator.gpu.requestAdapter());
  } catch { return false; }
}

const progress = (p) => {
  if (p.status === 'progress' || p.status === 'done') {
    self.postMessage({ type: 'progress', file: p.file, progress: p.progress ?? 100 });
  }
};

async function tryLoad(repo, dev) {
  const dtype = dev === 'webgpu'
    ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
    : 'q8';
  return pipeline('automatic-speech-recognition', repo, { device: dev, dtype, progress_callback: progress });
}

async function load(size) {
  if (asr) { try { await asr.dispose(); } catch {} asr = null; }
  const gpu = await hasWebGPU();
  // Candidate order: onnx-community build on GPU, then CPU, then older Xenova build on CPU.
  const attempts = [
    ...(gpu ? [[`onnx-community/${size}`, 'webgpu']] : []),
    [`onnx-community/${size}`, 'wasm'],
    [`Xenova/${size}`, 'wasm'],
  ];
  let lastErr;
  for (const [repo, dev] of attempts) {
    try {
      asr = await tryLoad(repo, dev);
      device = dev;
      await asr(new Float32Array(16000), { language: 'english', task: 'transcribe' }); // warm-up
      self.postMessage({ type: 'ready', device, repo });
      return;
    } catch (err) {
      lastErr = err;
      asr = null;
    }
  }
  throw lastErr;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    queue = queue.then(() => load(m.model))
      .catch((err) => self.postMessage({ type: 'error', message: String(err?.message || err) }));
  } else if (m.type === 'transcribe') {
    queue = queue.then(async () => {
      if (!asr) throw new Error('Model not loaded');
      const out = await asr(m.audio, { language: 'english', task: 'transcribe' });
      self.postMessage({ type: 'result', id: m.id, text: (out?.text || '').trim() });
    }).catch((err) => self.postMessage({ type: 'result', id: m.id, text: '', error: String(err?.message || err) }));
  }
};
