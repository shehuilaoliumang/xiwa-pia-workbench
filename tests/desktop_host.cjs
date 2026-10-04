"use strict";

// Pure Node contract tests: no Electron process, GUI, workbench server, or real instance files.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const qaRoot = path.join(root, '.qa');

const originalLoad = Module._load;
let host;
try {
  Module._load = function(name, ...args) {
    if (name === 'electron') throw new Error('Importing helpers must not launch or load Electron');
    return originalLoad.call(this, name, ...args);
  };
  host = require('../desktop/main.cjs');
} finally { Module._load = originalLoad; }

let temporaryRoot, server;
const requests = [];
const checks = [];

(async () => {
  // Reproduce an Electron loader importing the entry with require.main pointing elsewhere.
  // The fake single-instance lock rejects startup before any windows, network, or real FS writes.
  const entry = await fs.readFile(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  const calls = {electron: 0, mkdir: 0, quit: 0};
  const fakeApp = {setName() {}, setPath() {}, requestSingleInstanceLock() { return false; }, quit() { calls.quit++; }};
  const mockedRequire = name => {
    if (name === 'electron') { calls.electron++; return {app: fakeApp}; }
    if (name === 'node:fs') return {...require('node:fs'), mkdirSync() { calls.mkdir++; }};
    return require(name);
  };
  mockedRequire.main = {id: 'automation-loader'};
  const context = vm.createContext({console, URL, process: {argv: ['electron.exe', 'entry.cjs', '--url=http://127.0.0.1:8928/',
    '--data-dir=' + path.join(qaRoot, 'never-created-loader-fixture')], versions: {electron: 'test'}, type: 'browser', platform: process.platform}});
  const wrapper = vm.runInContext('(function(require,module,exports){\n' + entry + '\n})', context);
  wrapper(mockedRequire, {exports: {}}, {});
  await Promise.resolve();
  assert.deepEqual(calls, {electron: 1, mkdir: 1, quit: 1}, 'Electron import must enter startup even when require.main differs');
  wrapper(mockedRequire, {exports: {}}, {});
  await Promise.resolve();
  assert.deepEqual(calls, {electron: 1, mkdir: 1, quit: 1}, 'Repeated imports must not bootstrap a second desktop');
  checks.push('Electron loader import starts once despite a different require.main; ordinary Node import remains side-effect free');

  await fs.mkdir(qaRoot, {recursive: true});
  temporaryRoot = await fs.mkdtemp(path.join(qaRoot, 'desktop-host-'));
  const dataDir = path.join(temporaryRoot, '资料 空格');
  await fs.mkdir(dataDir);
  const args = url => ['--url=' + url, '--data-dir=' + dataDir];

  for (const url of ['http://127.0.0.1:8928/', 'http://localhost:8928/control', 'http://[::1]:8928/']) {
    const options = host.parseArgs([...args(url), '--diagnostics', '--no-show']);
    assert.equal(options.dataDir, dataDir);
    assert.equal(options.userData, path.join(dataDir, 'desktop-user-data'));
    assert.equal(options.mainUrl, new URL(url).origin + '/control');
    assert.equal(options.diagnostics, true);
    assert.equal(options.noShow, true);
  }
  for (const url of ['http://example.com/', 'http://127.0.0.1.evil.test/', 'http://user:secret@127.0.0.1:8928/',
    'https://127.0.0.1:8928/', 'file:///C:/Windows/', 'http://127.0.0.1:8928/?redirect=remote']) {
    assert.throws(() => host.parseArgs(args(url)), undefined, 'Reject untrusted launch URL: ' + url);
  }
  assert.throws(() => host.parseArgs(['--url=http://127.0.0.1:8928/', '--data-dir=relative-folder']));
  assert.throws(() => host.parseArgs([...args('http://127.0.0.1:8928/'), '--url=http://localhost:8928/']));
  checks.push('Loopback launch URLs and absolute Unicode data directory; reject external, credentialed, file, relative and ambiguous input');

  const origin = 'http://127.0.0.1:8928';
  assert.equal(host.sameOriginUrl(origin + '/display', origin), true);
  for (const url of ['http://127.0.0.1:8929/display', 'http://localhost:8928/display', 'https://127.0.0.1:8928/',
    'http://user@127.0.0.1:8928/', 'file:///C:/test', 'javascript:alert(1)', origin + '/\npath']) {
    assert.equal(host.sameOriginUrl(url, origin), false, 'Reject cross-origin or executable navigation');
  }
  checks.push('Navigation rejects cross-port, cross-host, credentialed and non-HTTP URLs');

  let mode = 'correct';
  server = http.createServer((request, response) => {
    requests.push({method: request.method, path: request.url});
    if (mode === 'timeout') return;
    if (mode === 'redirect') { response.writeHead(302, {Location: '/must-not-follow'}); response.end(); return; }
    if (mode === 'large') { response.end('x'.repeat(17000)); return; }
    if (mode === 'invalid-json') { response.end('not JSON'); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({app: mode === 'wrong-app' ? 'unrelated-local-app' : 'content-workbench',
      data_dir: mode === 'wrong-directory' ? path.join(temporaryRoot, 'other-data') : dataDir}));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const serviceOrigin = 'http://127.0.0.1:' + server.address().port;
  const options = host.parseArgs(args(serviceOrigin + '/'));
  assert.deepEqual(await host.requestHealth(options), {app: 'content-workbench', data_dir: dataDir});
  for (mode of ['wrong-app', 'wrong-directory', 'redirect', 'large', 'invalid-json']) {
    await assert.rejects(() => host.requestHealth(options), undefined, 'Reject invalid health response: ' + mode);
  }
  mode = 'timeout';
  await assert.rejects(() => host.requestHealth(options, 60), /timed out/);
  assert.equal(requests.length, 7);
  assert(requests.every(request => request.method === 'GET' && request.path === '/api/health'),
    'Readiness checks must not POST, follow redirects, or send shutdown requests');
  checks.push('Health accepts only matching app/data directory; rejects redirects, oversized/invalid JSON and timeout; all requests GET /api/health');

  // This server.json belongs solely to this test, never to a running workbench.
  const record = path.join(dataDir, 'server.json');
  assert.equal(host.servicePid(options), null);
  const fixture = {pid: 12345, url: serviceOrigin + '/', token: 'TEST-ONLY-NOT-A-REAL-CREDENTIAL'};
  await fs.writeFile(record, JSON.stringify(fixture));
  const identity = host.servicePid(options);
  assert.equal(identity, fixture.pid);
  assert.equal(typeof identity, 'number', 'The helper exposes only PID, never the record or stop token');
  await fs.writeFile(record, JSON.stringify({...fixture, url: 'http://127.0.0.1:' + (server.address().port === 65535 ? 65534 : server.address().port + 1) + '/'}));
  assert.equal(host.servicePid(options), null, 'A record for another port does not identify this service');
  await fs.writeFile(record, JSON.stringify({...fixture, pid: '12345'}));
  assert.equal(host.servicePid(options), null);
  await fs.writeFile(record, '{partial');
  assert.equal(host.servicePid(options), null, 'A record being replaced must fail closed without crashing');
  checks.push('Test-owned server record returns only a valid matching-service PID, never stop token; tolerates absent/partial record');

  console.log('Desktop host safety checks passed (' + checks.length + ' groups).');
  for (const check of checks) console.log('  PASS ' + check);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (temporaryRoot) {
    const resolved = path.resolve(temporaryRoot);
    if (path.dirname(resolved) !== qaRoot || !path.basename(resolved).startsWith('desktop-host-')) {
      throw new Error('Refusing cleanup outside the test-owned .qa directory');
    }
    await fs.rm(resolved, {recursive: true, force: true});
  }
});
