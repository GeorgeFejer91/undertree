import { analyzeWordCount } from './word-count.js';

self.onmessage = ({ data }) => {
  try { self.postMessage({ ok: true, result: analyzeWordCount(data) }); }
  catch (error) { self.postMessage({ ok: false, requestId: data?.requestId, error: { message: error.message || 'Word count is unavailable.' } }); }
};
