// Read/write the production Windows profile through the CI-only WebView host.
const [port, operation] = process.argv.slice(2);
const deadline = Date.now() + 60000;
let target;
let inspection = 'no response';
while (Date.now() < deadline) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    inspection = JSON.stringify(targets.map(item => ({ type: item.type, url: item.url })));
    target = targets.find(item => item.type === 'page' && new URL(item.url).hostname === 'wails.localhost');
    if (target?.webSocketDebuggerUrl) break;
  } catch (error) { inspection = String(error.cause || error); }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!target?.webSocketDebuggerUrl) throw new Error('Actual BeefTV WebView did not start: ' + inspection);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let requestId = 0;
function evaluate(expression) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error('WebView cache probe timed out')); }, 20000);
    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      if (message.error || message.result?.exceptionDetails) reject(new Error('WebView cache evaluation failed: ' + JSON.stringify(message.error || message.result.exceptionDetails)));
      else resolve(message.result?.result?.value);
    }
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
const expression = `(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('beeftv-installer-acceptance', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('drafts', ${JSON.stringify(operation === 'write' ? 'readwrite' : 'readonly')});
      const store = transaction.objectStore('drafts');
      const request = ${operation === 'write' ? "store.put('preserve unsaved draft', 'installer-draft')" : "store.get('installer-draft')"};
      let value;
      request.onsuccess = () => { value = request.result; };
      transaction.oncomplete = () => resolve(${operation === 'write' ? 'true' : "value === 'preserve unsaved draft'"});
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
})()`;
try {
  // A target URL can change before its new JavaScript context has loaded.
  let document;
  const loadedBy = Date.now() + 30000;
  do {
    document = await evaluate('({ origin: location.origin, href: location.href, ready: document.readyState, secure: isSecureContext })');
    if (document?.origin === 'http://wails.localhost' && document.ready === 'complete') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < loadedBy);
  if (document?.origin !== 'http://wails.localhost' || document.ready !== 'complete') throw new Error('Probe document did not load: ' + JSON.stringify(document));
  const result = await evaluate(expression);
  if (result !== true) throw new Error('Actual WebView IndexedDB draft was lost');
  console.log('PASS actual Windows WebView IndexedDB:', operation);
} finally { socket.close(); }
