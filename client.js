window.__ModuleLoader__.load({
  id: '@local/dsh-model-probe',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const zh = {"meta":{"title":"模型测速","description":"测试模型连接、首个回复耗时和总耗时。"},"title":"模型测速","subtitle":"检查所有已配置模型的实时连接状态","testAll":"测试全部","testSelected":"测试已选","testOne":"测试此模型","testFiltered":"测试筛选结果","stop":"停止","refresh":"刷新模型列表","close":"关闭","concurrency":"并发","timeout":"超时","search":"搜索模型或提供商…","models":"个模型","succeeded":"成功","failedCount":"失败","testing":"测试中","success":"成功","failed":"失败","untested":"未测试","firstToken":"首个回复","total":"总耗时","reply":"模型回复","reasoning":"思考","emptyReply":"无文本回复","details":"技术详情","technicalDetails":"技术详情","copyRequest":"复制请求","model":"测试模型","provider":"提供商","prompt":"提示词","promptHint":"让模型只回复 OK","startedAt":"开始时间","transport":"传输","stream":"流式","loading":"正在读取模型列表…","empty":"暂未发现可测试模型。请先在模型设置中添加提供商和模型。","noMatch":"没有符合搜索条件的模型。","loadError":"读取模型列表失败","catalogError":"目录异常","select":"选择","footnote":"使用当前 DSH 模型路由；密钥由 Host 托管，不会传入页面。"};
    const en = {"meta":{"title":"Model Probe","description":"Test model connectivity, first-response latency, and total latency."},"title":"Model Probe","subtitle":"Check live connectivity for every configured model","testAll":"Test all","testSelected":"Test selected","testOne":"Test this model","testFiltered":"Test filtered","stop":"Stop","refresh":"Refresh model list","close":"Close","concurrency":"Concurrency","timeout":"Timeout","search":"Search models or providers…","models":"models","succeeded":"passed","failedCount":"failed","testing":"Testing","success":"Passed","failed":"Failed","untested":"Not tested","firstToken":"First response","total":"Total","reply":"Reply","reasoning":"Reasoning","emptyReply":"No text reply","details":"Technical details","technicalDetails":"Technical details","copyRequest":"Copy request","model":"Model","provider":"Provider","prompt":"Prompt","promptHint":"Reply with OK only","startedAt":"Started","transport":"Transport","stream":"Streaming","loading":"Loading model catalog…","empty":"No testable models found. Add a provider and models in Model Settings.","noMatch":"No models match your search.","loadError":"Failed to load model catalog","catalogError":"Catalog error","select":"Select","footnote":"Uses current DSH model routes. Keys stay on the Host and never reach this page."};
    Object.assign(zh, { subtitle: '检查模型实时连接，并测试动态 SVG 绘图能力', testType: '测试类型', connectionTest: '连接检测', svgTest: 'SVG 动画检测', staticPreview: '动画预览', svgReady: 'SVG 动画检测完成 · 动画预览可用', animations: '处动画', svgSource: '清洗后的 SVG 源码（纯文本）', svgNotice: '保留原生 SVG 动画；脚本、外部资源和事件已移除。', svgPromptHint: '生成鹈鹕骑自行车的循环动画 SVG' });
    Object.assign(en, { subtitle: 'Check live connectivity and animated SVG generation', testType: 'Test type', connectionTest: 'Connectivity', svgTest: 'Animated SVG probe', staticPreview: 'Animated preview', svgReady: 'SVG probe completed · animated preview ready', animations: 'animations', svgSource: 'Sanitized SVG source (plain text)', svgNotice: 'Native SVG animation is preserved; scripts, external resources, and events are removed.', svgPromptHint: 'Generate a looping animated SVG of a pelican riding a bicycle' });
const NS = 'dsh-model-probe';
const API = '/api/dsh-model-probe';
const keyOf = (provider, model) => `${provider}\u0000${model}`;
const ms = (value) => value === undefined || value === null ? '—' : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;

const css = `
.dmp-launcher{flex:none;width:calc(100% + 4px);height:42px;margin:4px -2px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#888);display:flex;align-items:center;gap:8px;padding:0 10px;border-radius:12px;cursor:pointer;font:inherit;font-size:14px;text-align:left}.dmp-launcher:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff0b);color:var(--dsw-alias-label-primary,#eee)}.dmp-launcher[data-active=true]{color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-interactive-bg-hover,#ffffff12)}.dmp-launcher svg{width:17px;height:17px;flex:none}.dmp-layer.dmp-rail .dmp-launcher{width:36px;height:36px;margin:0;padding:0;border-radius:50%;justify-content:center}.dmp-layer{flex:none;width:36px}.dmp-layer:not(.dmp-rail){width:calc(100% + 4px)}
.dmp-backdrop{position:fixed;inset:0;z-index:10000;background:#0008;backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}.dmp-panel{width:min(900px,100%);height:min(760px,100%);display:flex;flex-direction:column;background:var(--dsw-alias-bg-elevated,#1c1c1e);color:var(--dsw-alias-text-primary,#eee);border:1px solid var(--dsw-alias-border-default,#ffffff18);border-radius:16px;box-shadow:0 24px 90px #0008;overflow:hidden;font-size:13px}.dmp-panel *{box-sizing:border-box}.dmp-head{display:flex;align-items:center;gap:12px;padding:20px 22px 16px;border-bottom:1px solid var(--dsw-alias-border-default,#ffffff12)}.dmp-head>svg{width:24px;height:24px;flex:none}.dmp-title{font-size:18px;font-weight:650}.dmp-subtitle{font-size:12px;color:var(--dsw-alias-text-secondary,#888);margin-top:5px}.dmp-head-spacer{flex:1}.dmp-icon{width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:19px}.dmp-icon:hover{background:var(--dsw-alias-bg-hover,#ffffff10)}.dmp-icon:disabled{opacity:.4}
.dmp-toolbar{display:flex;gap:8px;align-items:center;padding:12px 22px;flex-wrap:wrap}.dmp-btn{border:1px solid var(--dsw-alias-border-default,#ffffff20);border-radius:7px;background:var(--dsw-alias-bg-secondary,#ffffff08);color:inherit;padding:7px 13px;cursor:pointer;font:inherit;white-space:nowrap}.dmp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover,#ffffff12)}.dmp-btn:disabled{opacity:.4;cursor:default}.dmp-btn-primary{background:var(--dsw-alias-interactive-primary,#eee);color:var(--dsw-alias-text-on-primary,#111);border-color:transparent;font-weight:600}.dmp-select,.dmp-search{color:inherit;background:var(--dsw-alias-bg-input,#ffffff07);border:1px solid var(--dsw-alias-border-default,#ffffff18);border-radius:7px;padding:7px 9px;font:inherit;outline:none}.dmp-search{min-width:140px;flex:1}.dmp-select:focus,.dmp-search:focus{border-color:var(--dsw-alias-border-focused,#888)}.dmp-select option{background:#222;color:#eee}.dmp-settings{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-text-secondary,#888);font-size:12px}
.dmp-summary{display:flex;gap:18px;padding:0 22px 12px;color:var(--dsw-alias-text-secondary,#888);font-size:12px}.dmp-summary strong{color:var(--dsw-alias-text-primary,#eee);font-weight:600;margin-right:4px}.dmp-success-text{color:var(--dsw-alias-text-success,#62c992)!important}.dmp-error-text{color:var(--dsw-alias-text-danger,#ef767a)!important}.dmp-error{margin:0 22px 10px;padding:9px 12px;border-radius:7px;color:var(--dsw-alias-text-danger,#ef767a);background:#ef767a12}.dmp-body{flex:1;min-height:0;overflow:auto;padding:0 14px 14px}.dmp-empty{text-align:center;padding:70px 15px;color:var(--dsw-alias-text-secondary,#888)}.dmp-group{margin:4px 0}.dmp-group-head{display:flex;align-items:center;gap:7px;width:100%;border:0;background:transparent;color:inherit;padding:9px;cursor:pointer;text-align:left;font:inherit}.dmp-group-name{font-weight:600}.dmp-group-count{color:var(--dsw-alias-text-secondary,#888);font-size:12px}.dmp-group-arrow{color:var(--dsw-alias-text-secondary,#888);width:12px}.dmp-model{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-default,#ffffff0c);border-radius:9px;margin:0 0 5px 18px;background:var(--dsw-alias-bg-secondary,#ffffff04)}.dmp-model[data-running=true]{border-color:var(--dsw-alias-border-focused,#777)}.dmp-check{accent-color:var(--dsw-alias-interactive-primary,#ddd);margin:0;flex:none}.dmp-model-info{min-width:0;flex:1}.dmp-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dmp-model-sub{font-size:11px;color:var(--dsw-alias-text-secondary,#888);margin-top:4px;white-space:pre-wrap;word-break:break-word;max-height:52px;overflow:auto}.dmp-metrics{display:flex;gap:12px;white-space:nowrap;color:var(--dsw-alias-text-secondary,#888);font-size:12px}.dmp-metrics b{font-weight:500;color:var(--dsw-alias-text-primary,#ddd)}.dmp-badge{font-size:11px;border-radius:5px;padding:3px 7px;white-space:nowrap;min-width:48px;text-align:center}.dmp-badge-idle{color:var(--dsw-alias-text-secondary,#888);background:var(--dsw-alias-bg-secondary,#ffffff09)}.dmp-badge-running{color:var(--dsw-alias-text-warning,#dfb66c);background:#dfb66c15}.dmp-badge-success{color:var(--dsw-alias-text-success,#62c992);background:#62c99215}.dmp-badge-error{color:var(--dsw-alias-text-danger,#ef767a);background:#ef767a15}.dmp-detail-btn{border:0;background:transparent;color:var(--dsw-alias-text-secondary,#888);cursor:pointer;padding:5px}.dmp-detail{flex-basis:100%;margin:4px 0 0 25px;border-top:1px solid var(--dsw-alias-border-default,#ffffff10);padding-top:10px}.dmp-model:has(.dmp-detail){flex-wrap:wrap}.dmp-detail-title{display:flex;align-items:center;font-weight:600;margin-bottom:8px}.dmp-detail-title button{margin-left:auto}.dmp-pre{margin:7px 0 0;padding:10px;border-radius:7px;background:#0003;overflow:auto;font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word;max-height:210px;color:var(--dsw-alias-text-secondary,#bbb)}.dmp-foot{padding:10px 22px;border-top:1px solid var(--dsw-alias-border-default,#ffffff10);color:var(--dsw-alias-text-secondary,#888);font-size:11px;display:flex;justify-content:space-between;gap:10px}.dmp-model:has(.dmp-svg-preview){flex-wrap:wrap}.dmp-svg-preview{flex-basis:100%;margin:4px 0 0 25px}.dmp-svg-frame{display:block;width:100%;height:240px;border:1px solid var(--dsw-alias-border-default,#ffffff18);border-radius:10px;background:#fff}.dmp-svg-caption{font-size:11px;color:var(--dsw-alias-text-secondary,#888);margin:7px 0}.dmp-svg-source summary{cursor:pointer;color:var(--dsw-alias-text-secondary,#aaa);margin-top:10px}
@media(max-width:680px){.dmp-backdrop{padding:0}.dmp-panel{height:100%;border-radius:0}.dmp-metrics{display:none}.dmp-toolbar{padding:10px 14px}.dmp-head{padding:16px}.dmp-model{margin-left:0}.dmp-summary{padding-left:16px;gap:10px}.dmp-foot{padding:10px 16px}.dmp-settings{display:none}}
`;

return {
  inject: ['slots', 'locale'],
  apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-model-probe: dictionaries');
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;
    const h = React.createElement;
    const icon = h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M13 2 4.5 13H11l-1 9 8.5-11H12l1-9Z' }));

    async function post(path, body) {
      const response = await fetch(`${API}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
      return result;
    }

    function ModelRow({ group, model, status, selected, onSelect, onTest, t, running, type }) {
      const [details, setDetails] = useState(false);
      const result = status?.result;
      const state = status?.state || 'idle';
      const badge = state === 'running' ? t('testing') : state === 'success' ? t('success') : state === 'error' ? t('failed') : t('untested');
      const resultType = result?.type || type;
      const fallbackPrompt = resultType === 'svg' ? 'Generate an animated SVG of a pelican riding a bicycle. Reply with SVG code only.\n\nUse native SVG SMIL animation, especially <animate> and <animateTransform>, to visibly rotate the bicycle wheels and move the pelican or bicycle. Include at least one visible looping animation with repeatCount="indefinite" and a duration between 2 and 6 seconds. Nest animation elements inside their target shapes. Output one complete SVG only. Do not use scripts, CSS, <style>, <use>, external resources or links.' : 'Reply with OK only.';
      const requestText = result ? JSON.stringify(result.request || { provider: group.provider, model: model.id, messages: [{ role: 'user', content: [{ type: 'text', text: fallbackPrompt }] }], stream: true }, null, 2) : '';
      return h('div', { className: 'dmp-model', 'data-running': state === 'running' || undefined },
        h('input', { className: 'dmp-check', type: 'checkbox', checked: selected, onChange: onSelect, 'aria-label': `${t('select')} ${model.name}` }),
        h('div', { className: 'dmp-model-info' }, h('div', { className: 'dmp-model-name', title: model.id }, model.name),
          result && h('div', { className: 'dmp-model-sub' }, result.ok ? result.svg ? `${t('svgReady')} · ${result.animationCount || 0} ${t('animations')} · ${(result.svgBytes / 1024).toFixed(1)} KiB` : `${t('reply')}: ${result.reply || (result.reasoning ? `[${t('reasoning')}] ${result.reasoning}` : `(${t('emptyReply')})`)}` : `${result.code || 'ERROR'}${result.status ? ` · HTTP ${result.status}` : ''} · ${result.message}`)),
        result && h('div', { className: 'dmp-metrics' }, h('span', null, `${t('firstToken')} `, h('b', null, ms(result.firstTokenMs))), h('span', null, `${t('total')} `, h('b', null, ms(result.elapsedMs)))),
        h('span', { className: `dmp-badge dmp-badge-${state}` }, badge),
        h('button', { className: 'dmp-detail-btn', type: 'button', title: t('testOne'), disabled: running, onClick: onTest }, '▶'),
        h('button', { className: 'dmp-detail-btn', type: 'button', title: t('details'), onClick: () => setDetails(!details) }, '⌄'),
        result?.svg && h('div', { className: 'dmp-svg-preview' }, h('iframe', { className: 'dmp-svg-frame', title: `${t('staticPreview')}: ${model.name}`, sandbox: '', srcDoc: `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}body{display:flex;align-items:center;justify-content:center}svg{max-width:100%;max-height:100%}</style></head><body>${result.svg}</body></html>` }), h('div', { className: 'dmp-svg-caption' }, t('svgNotice'))),
        details && h('div', { className: 'dmp-detail' },
          h('div', { className: 'dmp-detail-title' }, t('technicalDetails'), h('button', { className: 'dmp-btn', type: 'button', onClick: async () => { await navigator.clipboard.writeText(requestText); } }, t('copyRequest'))),
          h('div', null, `${t('model')}: ${model.id} · ${t('provider')}: ${group.name}`),
          h('div', null, `${t('prompt')}: ${resultType === 'svg' ? t('svgPromptHint') : t('promptHint')}`),
          result?.svg && h('details', { className: 'dmp-svg-source' }, h('summary', null, t('svgSource')), h('pre', { className: 'dmp-pre' }, result.svg)),
          result && h('div', null, `${t('startedAt')}: ${new Date(result.startedAt).toLocaleString()} · ${t('transport')}: ${result.mode === 'stream' ? t('stream') : result.mode}`),
          result?.usage && h('pre', { className: 'dmp-pre' }, JSON.stringify(result.usage, null, 2)),
          h('pre', { className: 'dmp-pre' }, requestText)));
    }

    function Panel({ onClose, wide }) {
      useSyncExternalStore(useCallback((listener) => ctx.locale.subscribe(listener), []), () => ctx.locale.getSnapshot().revision);
      const t = ctx.locale.bind(NS);
      const [groups, setGroups] = useState([]);
      const [loading, setLoading] = useState(true);
      const [loadError, setLoadError] = useState('');
      const [statuses, setStatuses] = useState({});
      const [selected, setSelected] = useState(() => new Set());
      const [search, setSearch] = useState('');
      const [concurrency, setConcurrency] = useState(4);
      const [timeoutMs, setTimeoutMs] = useState(45000);
      const [testType, setTestType] = useState('connection');
      const [running, setRunning] = useState(false);
      const [collapsed, setCollapsed] = useState({});
      const generation = useRef(0);
      const runIds = useRef(new Set());
      const mounted = useRef(true);
      const panelRef = useRef(null);
      const allModels = useMemo(() => groups.flatMap((group) => group.models.map((model) => ({ group, model }))), [groups]);
      const filteredGroups = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return groups.map((group) => ({ ...group, models: needle ? group.models.filter((model) => `${model.name} ${model.id} ${group.name} ${group.provider}`.toLowerCase().includes(needle)) : group.models })).filter((group) => group.models.length);
      }, [groups, search]);
      const resultList = Object.values(statuses).filter((item) => item.result).map((item) => item.result);
      const succeeded = resultList.filter((item) => item.ok).length;
      const failed = resultList.length - succeeded;

      const refresh = useCallback(async () => {
        const serial = ++generation.current;
        setLoading(true); setLoadError(''); setRunning(false); setStatuses({});
        if (runIds.current.size) void post('stop', { runIds: [...runIds.current] }).catch(() => {});
        runIds.current.clear();
        try {
          const data = await post('catalog');
          if (!data.ok) throw new Error(data.message || 'Catalog error');
          if (serial !== generation.current || !mounted.current) return;
          setGroups(data.groups);
          setSelected(new Set(data.groups.flatMap((group) => group.models.map((model) => keyOf(group.provider, model.id)))));
        } catch (error) { if (mounted.current) setLoadError(error.message || String(error)); }
        if (mounted.current) setLoading(false);
      }, []);
      useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current += 1; if (runIds.current.size) void post('stop', { runIds: [...runIds.current] }).catch(() => {}); runIds.current.clear(); }; }, [refresh]);
      useEffect(() => {
        const close = (event) => { if (event.key === 'Escape') onClose(); };
        document.addEventListener('keydown', close);
        panelRef.current?.focus();
        return () => document.removeEventListener('keydown', close);
      }, [onClose]);

      const run = useCallback(async (items) => {
        if (!items.length || running) return;
        const serial = ++generation.current;
        const queue = [...items];
        setRunning(true);
        setStatuses((previous) => {
          const next = { ...previous };
          for (const item of queue) next[keyOf(item.group.provider, item.model.id)] = { state: 'running' };
          return next;
        });
        let cursor = 0;
        const worker = async () => {
          while (cursor < queue.length && generation.current === serial) {
            const item = queue[cursor++];
            const key = keyOf(item.group.provider, item.model.id);
            const currentRunId = globalThis.crypto.randomUUID();
            runIds.current.add(currentRunId);
            try {
              const result = await post('test', { provider: item.group.provider, model: item.model.id, type: testType, timeoutMs, runId: currentRunId });
              if (generation.current === serial && mounted.current) setStatuses((previous) => ({ ...previous, [key]: { state: result.ok ? 'success' : 'error', result } }));
            } catch (error) {
              if (generation.current === serial && mounted.current) setStatuses((previous) => ({ ...previous, [key]: { state: 'error', result: { ok: false, message: error.message || String(error) } } }));
            } finally { runIds.current.delete(currentRunId); }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
        if (mounted.current && generation.current === serial) setRunning(false);
      }, [running, timeoutMs, concurrency, testType]);
      const stop = () => {
        const currentRunIds = [...runIds.current];
        runIds.current.clear();
        if (currentRunIds.length) void post('stop', { runIds: currentRunIds }).catch(() => {});
        generation.current += 1; setRunning(false);
        setStatuses((previous) => Object.fromEntries(Object.entries(previous).map(([key, value]) => [key, value.state === 'running' ? { state: 'idle' } : value])));
      };
      const toggle = (group, model) => setSelected((previous) => { const next = new Set(previous); const key = keyOf(group.provider, model.id); if (next.has(key)) next.delete(key); else next.add(key); return next; });
      const chosen = allModels.filter((item) => selected.has(keyOf(item.group.provider, item.model.id)));
      const filtered = filteredGroups.flatMap((group) => group.models.map((model) => ({ group, model })));
      const changeType = (value) => { setTestType(value); setTimeoutMs(value === 'svg' ? 300000 : 45000); setStatuses({}); };
      return h('div', { className: 'dmp-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('section', { className: 'dmp-panel', ref: panelRef, tabIndex: -1, role: 'dialog', 'aria-modal': true, 'aria-label': t('title') },
          h('style', null, css),
          h('header', { className: 'dmp-head' }, icon, h('div', null, h('div', { className: 'dmp-title' }, t('title')), h('div', { className: 'dmp-subtitle' }, t('subtitle'))), h('div', { className: 'dmp-head-spacer' }), h('button', { className: 'dmp-icon', type: 'button', title: t('refresh'), disabled: loading, onClick: refresh }, loading ? '⋯' : '↻'), h('button', { className: 'dmp-icon', type: 'button', title: t('close'), onClick: onClose }, '×')),
          h('div', { className: 'dmp-toolbar' },
            h('label', { className: 'dmp-settings' }, t('testType'), h('select', { className: 'dmp-select', value: testType, disabled: running, onChange: (event) => changeType(event.target.value) }, h('option', { value: 'connection' }, t('connectionTest')), h('option', { value: 'svg' }, t('svgTest')))),
            running ? h('button', { className: 'dmp-btn', type: 'button', onClick: stop }, t('stop')) : h('button', { className: 'dmp-btn dmp-btn-primary', type: 'button', disabled: loading || !allModels.length, onClick: () => run(allModels) }, t('testAll')),
            h('button', { className: 'dmp-btn', type: 'button', disabled: loading || running || !chosen.length, onClick: () => run(chosen) }, `${t('testSelected')} (${chosen.length})`),
            h('div', { className: 'dmp-head-spacer' }),
            h('label', { className: 'dmp-settings' }, t('concurrency'), h('select', { className: 'dmp-select', value: concurrency, disabled: running, onChange: (event) => setConcurrency(Number(event.target.value)) }, [2, 4, 8].map((value) => h('option', { key: value, value }, value)))),
            h('label', { className: 'dmp-settings' }, t('timeout'), h('select', { className: 'dmp-select', value: timeoutMs, disabled: running, onChange: (event) => setTimeoutMs(Number(event.target.value)) }, (testType === 'svg' ? [90000, 180000, 300000] : [15000, 45000, 90000]).map((value) => h('option', { key: value, value }, `${value / 1000}s`))))),
          h('div', { className: 'dmp-toolbar', style: { paddingTop: 0 } }, h('input', { className: 'dmp-search', value: search, onChange: (event) => setSearch(event.target.value), placeholder: t('search') }), h('button', { className: 'dmp-btn', type: 'button', disabled: running || !filtered.length, onClick: () => run(filtered) }, t('testFiltered'))),
          h('div', { className: 'dmp-summary' }, h('span', null, h('strong', null, allModels.length), t('models')), h('span', null, h('strong', { className: 'dmp-success-text' }, succeeded), t('succeeded')), h('span', null, h('strong', { className: 'dmp-error-text' }, failed), t('failedCount'))),
          loadError && h('div', { className: 'dmp-error' }, `${t('loadError')}: ${loadError}`),
          h('div', { className: 'dmp-body' },
            loading ? h('div', { className: 'dmp-empty' }, t('loading')) : !filteredGroups.length ? h('div', { className: 'dmp-empty' }, allModels.length ? t('noMatch') : t('empty')) : filteredGroups.map((group) => h('section', { className: 'dmp-group', key: group.provider },
              h('button', { className: 'dmp-group-head', type: 'button', onClick: () => setCollapsed((previous) => ({ ...previous, [group.provider]: !previous[group.provider] })) }, h('span', { className: 'dmp-group-arrow' }, collapsed[group.provider] ? '▸' : '▾'), h('span', { className: 'dmp-group-name' }, group.name), h('span', { className: 'dmp-group-count' }, `${group.provider} · ${group.models.length}`), group.error && h('span', { className: 'dmp-error-text', title: group.error }, ` · ${t('catalogError')}`)),
              !collapsed[group.provider] && group.models.map((model) => h(ModelRow, { key: keyOf(group.provider, model.id), group, model, selected: selected.has(keyOf(group.provider, model.id)), status: statuses[keyOf(group.provider, model.id)], type: testType, onSelect: () => toggle(group, model), onTest: () => run([{ group, model }]), t, running }))))),
          h('footer', { className: 'dmp-foot' }, h('span', null, t('footnote')), h('span', null, testType === 'svg' ? t('svgPromptHint') : t('promptHint')))));
    }

    function Launcher({ wide }) {
      const [open, setOpen] = useState(false);
      useSyncExternalStore(useCallback((listener) => ctx.locale.subscribe(listener), []), () => ctx.locale.getSnapshot().revision);
      const t = ctx.locale.bind(NS);
      return h(React.Fragment, null, open && ReactDOM.createPortal(h(Panel, { onClose: () => setOpen(false), wide }), document.body), h('div', { className: `dmp-layer${wide ? '' : ' dmp-rail'}` }, h('style', null, css), h('button', { className: 'dmp-launcher', type: 'button', 'data-active': open || undefined, title: t('title'), 'aria-label': t('title'), 'aria-expanded': open, onClick: () => setOpen(!open) }, icon, wide && h('span', null, t('title')))));
    }
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: NS, locale: NS, order: 18 }, Launcher));
    }
  };
  },
});
