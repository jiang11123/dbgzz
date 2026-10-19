import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Play, RefreshCw, Server, X } from 'lucide-react';

type GatewayAccount = {
  accountId: number;
  name: string;
  health: string;
  available: boolean;
  dailyUsed: number;
  cooldownRemainingMs: number;
};

type GatewayStatus = {
  url: string;
  enabled: boolean;
  running: boolean;
  port: number;
  apiKey: string;
  error: string | null;
  requests: number;
  model: string;
  accounts: GatewayAccount[];
};

type LogLine = { time: string; text: string };

const healthLabel: Record<string, string> = {
  healthy: '可用',
  cooling: '冷却中',
  quota_exhausted: '额度用尽',
  captcha: '需人机验证',
  logged_out: '需重新登录',
};

const healthClass: Record<string, string> = {
  healthy: 'ok',
  cooling: 'warn',
  quota_exhausted: 'warn',
  captcha: 'bad',
  logged_out: 'bad',
};

const countdown = (ms: number) => (ms <= 0 ? '' : ms >= 60_000 ? `${Math.ceil(ms / 60_000)} 分钟` : `${Math.ceil(ms / 1000)} 秒`);

export function GatewayPanel() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [port, setPort] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [testPrompt, setTestPrompt] = useState('只回复两个字：收到');
  const [testAnswer, setTestAnswer] = useState('');
  const [testing, setTesting] = useState(false);
  const logBox = useRef<HTMLDivElement | null>(null);
  const logEnd = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    const next = await window.workspace.gatewayStatus();
    setStatus(next);
    setPort(current => (current === '' ? String(next.port) : current));
    setApiKey(current => (current === '' ? next.apiKey : current));
  };

  /** Re-checks a blocked account; clears 需人机验证 once the user has verified. */
  const probe = async (accountId: number) => {
    setProbing(accountId);
    try {
      const result = await window.workspace.probeAccount(accountId);
      setStatus(await window.workspace.gatewayStatus());
      setNotice(result.ok ? '账号已恢复，可继续使用' : `账号仍不可用：${result.reason ?? '未知原因'}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setProbing(null);
    }
  };

  useEffect(() => {
    void refresh().catch(error => setNotice(String(error)));
    const offLog = window.workspace.onGatewayLog((text: string) => {
      setLogs(old => [...old, { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), text }].slice(-300));
    });
    const offChanged = window.workspace.onGatewayChanged(() => { void refresh(); });
    const timer = window.setInterval(() => { void refresh().catch(() => undefined); }, 3000);
    /** Re-checks a blocked account; clears 需人机验证 once the user has verified. */
  const probe = async (accountId: number) => {
    setProbing(accountId);
    try {
      const result = await window.workspace.probeAccount(accountId);
      setStatus(await window.workspace.gatewayStatus());
      setNotice(result.ok ? '账号已恢复，可继续使用' : `账号仍不可用：${result.reason ?? '未知原因'}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setProbing(null);
    }
  };

  return () => { offLog(); offChanged(); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [logs]);

  const run = async (job: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setNotice('');
    try { await job(); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  /** Calls the gateway over HTTP so the test exercises the real client path. */
  const testRequest = async () => {
    if (!status || testing) return;
    setTesting(true); setNotice(''); setTestAnswer('');
    const started = Date.now();
    try {
      const response = await fetch(`http://127.0.0.1:${status.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(status.apiKey ? { Authorization: `Bearer ${status.apiKey}` } : {}) },
        body: JSON.stringify({ model: status.model || 'doubao', messages: [{ role: 'user', content: testPrompt }], stream: false }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
      setTestAnswer(`${body.choices?.[0]?.message?.content ?? ''}\n\n（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
    } catch (error) {
      setNotice(`测试失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { setTesting(false); }
  };

  if (!status) return <main className="gateway-window"><div className="loading">正在读取网关状态...</div></main>;

  const copy = (text: string, label: string) => run(async () => {
    await window.workspace.gatewayCopy(text);
    setNotice(`已复制${label}`);
  });

  const endpoint = status.running ? status.url : `http://127.0.0.1:${port}/v1`;

  return <main className="gateway-window">
    <header className="gateway-head">
      <div>
        <h1><Server size={18} />API 网关</h1>
        <p>把已登录的豆包账号池暴露为 OpenAI 兼容接口，仅监听本机 127.0.0.1。</p>
      </div>
      <span className={`gateway-pill ${status.running && !status.error ? 'ok' : 'bad'}`}>
        {status.error ? '启动失败' : status.running ? '运行中' : '已停用'}
      </span>
    </header>

    {status.error && <div className="gateway-alert bad">{status.error}</div>}
    {notice && <div className="gateway-alert"><Check size={14} />{notice}</div>}

    <section className="gateway-cards">
      <article className="gateway-card">
        <h2>接口地址</h2>
        <code>{endpoint}</code>
        <button className="outline" disabled={busy} onClick={() => void copy(endpoint, '接口地址')}><Copy size={13} />复制</button>
      </article>
      <article className="gateway-card">
        <h2>API Key</h2>
        <code>{status.apiKey ? status.apiKey : '（未设置，本机可直连）'}</code>
        <button className="outline" disabled={busy || !status.apiKey} onClick={() => void copy(status.apiKey, 'API Key')}><Copy size={13} />复制</button>
      </article>
      <article className="gateway-card">
        <h2>累计请求</h2>
        <b className="gateway-big">{status.requests}</b>
        <span className="muted">默认模型 {status.model}</span>
      </article>
    </section>

    <section className="gateway-block">
      <h2>账号池</h2>
      <div className="gateway-accounts">
        {status.accounts.length ? status.accounts.map(account => <div key={account.accountId} className="gateway-account">
          <b>{account.name}</b>
          <span className={`gateway-health ${healthClass[account.health] ?? ''}`}>{healthLabel[account.health] ?? account.health}</span>
          <small>今日 {account.dailyUsed} 次{account.cooldownRemainingMs > 0 ? ` · ${countdown(account.cooldownRemainingMs)}后恢复` : ''}</small>
          {account.health !== 'healthy' && <button className="outline gateway-probe" disabled={probing === account.accountId}
            onClick={() => void probe(account.accountId)}>
            {probing === account.accountId ? '检查中…' : '重新检查'}
          </button>}
        </div>) : <p className="muted">还没有豆包账号。</p>}
      </div>
    </section>

    <section className="gateway-block">
      <h2>设置</h2>
      <div className="gateway-form">
        <label>端口<input value={port} onChange={event => setPort(event.target.value.replace(/[^0-9]/g, ''))} placeholder="8788" /></label>
        <label>API Key（留空表示不校验）<input value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="sk-..." /></label>
        <div className="gateway-actions">
          <button className="primary" disabled={busy} onClick={() => void run(async () => {
            const parsed = Number(port);
            if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65535) throw new Error('端口需在 1024-65535 之间');
            setStatus(await window.workspace.gatewayRestart({ port: parsed, apiKey, enabled: true }));
            setNotice('网关已按新设置重启');
          })}><RefreshCw size={14} />保存并重启</button>
          <button className="outline" disabled={busy} onClick={() => void run(async () => {
            setStatus(await window.workspace.gatewayRestart({ enabled: false }));
            setNotice('网关已停用');
          })}>停用网关</button>
          <button className="outline" disabled={busy} onClick={() => void run(async () => {
            setStatus(await window.workspace.gatewayRestart({ enabled: true }));
            setNotice('网关已启用');
          })}>启用网关</button>
        </div>
      </div>
    </section>

    <section className="gateway-block">
      <h2>试一句</h2>
      <div className="gateway-test">
        <input value={testPrompt} onChange={event => setTestPrompt(event.target.value)} placeholder="输入提示词" />
        <button className="primary" disabled={testing || !testPrompt.trim()} onClick={() => void testRequest()}><Play size={14} />{testing ? '请求中...' : '发送'}</button>
      </div>
      {testAnswer && <pre className="gateway-answer">{testAnswer}</pre>}
    </section>

    <section className="gateway-block">
      <div className="gateway-log-head">
        <h2>实时日志</h2>
        <button className="outline" disabled={!logs.length} onClick={() => setLogs([])}><X size={13} />清空</button>
      </div>
      <div className="gateway-log" ref={logBox}>
        {logs.length ? logs.map((line, index) => <div key={index}><span>{line.time}</span>{line.text}</div>) : <p className="muted">暂无日志。</p>}
        <div ref={logEnd} />
      </div>
    </section>

    <section className="gateway-block">
      <h2>客户端接入</h2>
      <p className="muted">任何 OpenAI 兼容客户端都可直接使用，Base URL 填 <code>{endpoint}</code>。</p>
      <pre className="gateway-answer">{[
        `curl ${endpoint}/chat/completions \\`,
        status.apiKey ? `  -H "Authorization: Bearer ${status.apiKey}" \\` : null,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"${status.model || 'doubao'}","messages":[{"role":"user","content":"你好"}],"stream":true}'`,
      ].filter(Boolean).join('\n')}</pre>
    </section>
  </main>;
}
