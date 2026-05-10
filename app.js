const dot = document.getElementById('sw-dot');
const status = document.getElementById('sw-status');

function setStatus(state, message) {
  if (dot) {
    dot.classList.remove('is-ready', 'is-error');
    if (state) dot.classList.add(state);
  }
  if (status) status.textContent = message;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./service-worker.js');
      if (reg.active) {
        setStatus('is-ready', 'Service worker active — shell cached for offline use.');
      } else {
        setStatus(null, 'Service worker installing…');
        navigator.serviceWorker.ready.then(() => {
          setStatus('is-ready', 'Service worker active — shell cached for offline use.');
        });
      }
    } catch (err) {
      console.error('Service worker registration failed', err);
      setStatus('is-error', 'Service worker failed to register. Offline mode unavailable.');
    }
  });
} else {
  setStatus('is-error', 'Service workers not supported in this browser.');
}
