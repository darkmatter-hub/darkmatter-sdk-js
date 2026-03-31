/**
 * DarkMatter JavaScript SDK
 * Replay, fork, and verify any AI workflow.
 * npm install darkmatter-js
 */

const BASE = 'https://darkmatterhub.ai';

function getKey() {
  const key = process.env.DARKMATTER_API_KEY || '';
  if (!key) {
    throw new Error(
      'No API key found. Set DARKMATTER_API_KEY environment variable ' +
      'or pass apiKey to new DarkMatter().\n' +
      'Get a free key at https://darkmatterhub.ai/signup'
    );
  }
  return key;
}

async function _req(method, path, body, key, base) {
  const url = (base || BASE) + path;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key || getKey()}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || `HTTP ${res.status}`;
    if (res.status === 401) throw Object.assign(new Error(msg), { code: 'AUTH_ERROR' });
    if (res.status === 404) throw Object.assign(new Error(msg), { code: 'NOT_FOUND' });
    throw Object.assign(new Error(msg), { code: 'API_ERROR', status: res.status });
  }
  return data;
}

// ── Module-level functions (use env key) ──────────────────────────────────────

/**
 * Commit agent context to DarkMatter.
 * @param {string} toAgentId - Recipient agent ID
 * @param {object} payload - { input, output, memory, variables }
 * @param {object} opts - { parentId, traceId, branchKey, eventType, agent }
 * @returns {Promise<object>} Context Passport
 */
async function commit(toAgentId, payload, opts = {}) {
  const body = { toAgentId, payload, eventType: opts.eventType || 'commit' };
  if (opts.parentId)  body.parentId  = opts.parentId;
  if (opts.traceId)   body.traceId   = opts.traceId;
  if (opts.branchKey) body.branchKey = opts.branchKey;
  if (opts.agent)     body.agent     = opts.agent;
  return _req('POST', '/api/commit', body);
}

/**
 * Pull all verified contexts addressed to this agent.
 * @returns {Promise<{agentId, contexts, count}>}
 */
async function pull() {
  return _req('GET', '/api/pull');
}

/**
 * Replay the full decision path for a context chain.
 * @param {string} ctxId - Context ID (tip of chain)
 * @param {string} mode - 'full' (default) or 'summary'
 */
async function replay(ctxId, mode = 'full') {
  return _req('GET', `/api/replay/${ctxId}?mode=${mode}`);
}

/**
 * Fork from a checkpoint.
 * @param {string} ctxId - Context to fork from
 * @param {object} opts - { toAgentId, branchKey, payload }
 */
async function fork(ctxId, opts = {}) {
  return _req('POST', `/api/fork/${ctxId}`, opts);
}

/**
 * Verify the integrity of a context chain.
 * @param {string} ctxId
 */
async function verify(ctxId) {
  return _req('GET', `/api/verify/${ctxId}`);
}

/**
 * Export a portable proof artifact for a context chain.
 * @param {string} ctxId
 */
async function exportChain(ctxId) {
  return _req('GET', `/api/export/${ctxId}`);
}

/**
 * Search your execution history.
 * @param {object} params - { q, model, provider, event, traceId, from, to, limit }
 */
async function search(params = {}) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
  ).toString();
  return _req('GET', `/api/search${qs ? '?' + qs : ''}`);
}

/**
 * Diff two execution chains step-by-step.
 * @param {string} ctxIdA
 * @param {string} ctxIdB
 */
async function diff(ctxIdA, ctxIdB) {
  return _req('GET', `/api/diff/${ctxIdA}/${ctxIdB}`);
}

/**
 * Return identity of the current agent.
 */
async function me() {
  return _req('GET', '/api/me');
}

// ── Class interface ───────────────────────────────────────────────────────────

class DarkMatter {
  /**
   * @param {object} opts - { apiKey, baseUrl }
   */
  constructor(opts = {}) {
    this.apiKey  = opts.apiKey  || getKey();
    this.baseUrl = opts.baseUrl || BASE;
  }

  _req(method, path, body) {
    return _req(method, path, body, this.apiKey, this.baseUrl);
  }

  commit(toAgentId, payload, opts = {}) {
    const body = { toAgentId, payload, eventType: opts.eventType || 'commit' };
    if (opts.parentId)  body.parentId  = opts.parentId;
    if (opts.traceId)   body.traceId   = opts.traceId;
    if (opts.branchKey) body.branchKey = opts.branchKey;
    if (opts.agent)     body.agent     = opts.agent;
    return this._req('POST', '/api/commit', body);
  }

  pull()                           { return this._req('GET', '/api/pull'); }
  replay(ctxId, mode = 'full')     { return this._req('GET', `/api/replay/${ctxId}?mode=${mode}`); }
  fork(ctxId, opts = {})           { return this._req('POST', `/api/fork/${ctxId}`, opts); }
  verify(ctxId)                    { return this._req('GET', `/api/verify/${ctxId}`); }
  export(ctxId)                    { return this._req('GET', `/api/export/${ctxId}`); }
  diff(ctxIdA, ctxIdB)             { return this._req('GET', `/api/diff/${ctxIdA}/${ctxIdB}`); }
  me()                             { return this._req('GET', '/api/me'); }

  search(params = {}) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
    ).toString();
    return this._req('GET', `/api/search${qs ? '?' + qs : ''}`);
  }
}

// ── LangGraph integration ─────────────────────────────────────────────────────

class DarkMatterTracer {
  /**
   * Wrap a compiled LangGraph app to auto-commit after every node.
   * @param {object} app - Compiled LangGraph app
   * @param {object} opts - { agentId, toAgentId, apiKey, traceId, model, provider }
   */
  constructor(app, opts = {}) {
    this._app = app;
    this._dm  = new DarkMatter({ apiKey: opts.apiKey });
    this._toAgentId = opts.toAgentId || opts.agentId;
    this._traceId   = opts.traceId;
    this._model     = opts.model;
    this._provider  = opts.provider;
  }

  async invoke(input, config = {}) {
    let parentId = null;
    const traceId = this._traceId || `trc_${Date.now()}`;
    try {
      for await (const chunk of this._app.stream(input, config)) {
        for (const [nodeName, nodeOutput] of Object.entries(chunk)) {
          try {
            const ctx = await this._dm.commit(
              this._toAgentId,
              { input: parentId ? undefined : input, output: nodeOutput, memory: { node: nodeName } },
              { parentId, traceId, eventType: 'checkpoint',
                agent: { role: nodeName, provider: this._provider, model: this._model } }
            );
            parentId = ctx.id;
          } catch (e) {
            console.warn(`[DarkMatter] commit failed for node ${nodeName}:`, e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[DarkMatter] stream failed, falling back:', e.message);
    }
    return this._app.invoke(input, config);
  }

  stream(input, config) { return this._app.stream(input, config); }
}

// ── Anthropic SDK wrapper ─────────────────────────────────────────────────────

function dmAnthropicClient(anthropicClient, opts = {}) {
  const dm = new DarkMatter({ apiKey: opts.apiKey });
  const toAgentId = opts.toAgentId || opts.agentId;
  const traceId   = opts.traceId;
  let lastCtxId   = null;

  const originalCreate = anthropicClient.messages.create.bind(anthropicClient.messages);

  anthropicClient.messages.create = async function(params) {
    const response = await originalCreate(params);
    const output = (response.content || []).map(b => b.text || '').join('');
    try {
      const ctx = await dm.commit(
        toAgentId,
        { input: params.messages, output,
          memory: { model: params.model, stop_reason: response.stop_reason,
                    usage: response.usage } },
        { traceId, eventType: 'commit',
          agent: { provider: 'anthropic', model: params.model } }
      );
      lastCtxId = ctx.id;
    } catch (e) {
      console.warn('[DarkMatter] commit failed:', e.message);
    }
    return response;
  };

  Object.defineProperty(anthropicClient, 'lastCtxId', { get: () => lastCtxId });
  return anthropicClient;
}

// ── OpenAI SDK wrapper ────────────────────────────────────────────────────────

function dmOpenAIClient(openaiClient, opts = {}) {
  const dm = new DarkMatter({ apiKey: opts.apiKey });
  const toAgentId = opts.toAgentId || opts.agentId;
  const traceId   = opts.traceId;
  let lastCtxId   = null;

  const originalCreate = openaiClient.chat.completions.create.bind(openaiClient.chat.completions);

  openaiClient.chat.completions.create = async function(params) {
    const response = await originalCreate(params);
    const output = response.choices?.[0]?.message?.content || '';
    try {
      const ctx = await dm.commit(
        toAgentId,
        { input: params.messages, output,
          memory: { model: params.model, finish_reason: response.choices?.[0]?.finish_reason,
                    usage: response.usage } },
        { traceId, eventType: 'commit',
          agent: { provider: 'openai', model: params.model } }
      );
      lastCtxId = ctx.id;
    } catch (e) {
      console.warn('[DarkMatter] commit failed:', e.message);
    }
    return response;
  };

  Object.defineProperty(openaiClient, 'lastCtxId', { get: () => lastCtxId });
  return openaiClient;
}

module.exports = {
  DarkMatter,
  DarkMatterTracer,
  dmAnthropicClient,
  dmOpenAIClient,
  commit, pull, replay, fork, verify,
  export: exportChain,
  search, diff, me,
};
