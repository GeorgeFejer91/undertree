import { invoke, isTauri } from '@tauri-apps/api/core';

const native = isTauri();
let token = '';
if (!native) {
  const url = new URL(location.href);
  token = url.hash.startsWith('#session=') ? decodeURIComponent(url.hash.slice(9)) : sessionStorage.getItem('undertree-review-session') || '';
  if (token) sessionStorage.setItem('undertree-review-session', token);
  if (url.hash.startsWith('#session=')) history.replaceState(null, '', url.pathname + url.search);
}

export async function reviewRequest(operation) {
  if (native) return invoke('review_action', { operation });
  const response = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation) });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.ok) throw value?.error || { message: 'The native review service is unavailable.' };
  return value.result;
}

export async function chooseProject() {
  if (native) return invoke('choose_project');
  return null;
}
export const nativeReview = native;
