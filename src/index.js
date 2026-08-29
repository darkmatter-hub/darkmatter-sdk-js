/**
 * DarkMatter JavaScript SDK v1.4.2
 * Replay, fork, and verify any AI workflow.
 * npm install darkmatter-js
 *
 * Changelog v1.4.2
 * - commit() now computes payload_hash on the client with RFC 8785 canonical
 *   JSON, matching the server and the Python SDK. Before this the SDK sent no
 *   hash at all and the server computed one from what it received, so nothing
 *   about the payload was established before it left the machine.
 * - canonicalize() and hashPayload() exported so callers can recompute it

 * Changelog v1.4.1
 * - commit() toAgentId is now optional, defaults to DARKMATTER_AGENT_ID env var
 *
 * Changelog v1.4.0
 * - dmOpenAIClient now instruments openai.responses.create() in addition to
 *   openai.chat.completions.create()
 * - DarkMatterTracer.invoke() now commits the full graph run as a parent record
 * - Added configure() module-level helper
 */

const crypto = require('node:crypto');

const BASE = 'https://darkmatterhub.ai';

/**
 * RFC 8785 (JCS) canonical serialization.
 *
 * This has to agree byte for byte with canonicalize() in DarkMatter's
 * src/integrity.js, because the server recomputes the hash from the payload it
 * receives and rejects the commit if the two disagree. Until v1.4.2 this SDK
 * computed nothing and let the server hash, which meant every claim about the
 * payload being hashed before it left your machine was true of the Python SDK
 * and false here.
 *
 * Two details are load-bearing:
 *
 *   Key order is by UTF-16 code unit, which is what Array.prototype.sort does
 *   on strings. That is the same as code point order across the whole BMP and
 *   differs above it, because an astral character is a surrogate pair: U+1F600
 *   is D83D DE00, which sorts below U+FF01 in UTF-16 and above it by code
 *   point. Python's sorted() gets this wrong; JavaScript is correct by default.
 *
 *   undefined is dropped, null is kept. JSON.stringify drops both, so a payload
 *   with an explicit null would hash differently if this delegated to it.
 */
function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (typeof value === 'number') {
    if (!isFinite(value)) {
      throw new TypeError('canonicalize: non-finite number rejected: ' + value);
    }
    if (Number.isInteger(value)) return String(value);
    let s = value.toPrecision(17);
    if (s.includes('.') && !s.includes('e')) {
      s = s.replace(/\.?0+$/, '');
      if (!s.includes('.')) s += '.0';
    }
    return s;
  }

  if (typeof value === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }

  if (typeof value === 'object') {
    const keys  = Object.keys(value).sort();
    const pairs = [];
    for (const k of keys) {
      const v = value[k];
      if (v === undefined) continue;
      pairs.push(JSON.stringify(k) + ':' + canonicalize(v));
    }
    return '{' + pairs.join(',') + '}';
  }

  throw new TypeError('canonicalize: unsupported type ' + typeof value);
}

/**
 * SHA-256 of the canonical form. Lowercase hex, no prefix, matching
 * hashPayload() on the server and hash_payload() in the Python SDK.
 */
function hashPayload(payload) {
  return crypto.createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
}

/**
 * The commit body every caller sends. One builder, because the module-level
 * commit() and DarkMatter#commit() had identical copies and a hash added to
 * one of them would have been missing from the other.
 */
function buildCommitBody(resolvedTo, payload, opts) {
  const body = {
    toAgentId: resolvedTo,
    payload,
    eventType: opts.eventType || 'commit',
    payload_hash: hashPayload(payload),
  };
  if (opts.parentId)  body.parentId  = opts.parentId;
  if (opts.traceId)   body.traceId   = opts.traceId;
  if (opts.branchKey) body.branchKey = opts.branchKey;
  if (opts.agent)     body.agent     = opts.agent;
  return body;
}

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
 * @param {string} [toAgentId] - Recipient agent ID. Defaults to DARKMATTER_AGENT_ID env var.
 * @param {object} payload - { input, output, memory, variables }
 * @param {object} opts - { parentId, traceId, branchKey, eventType, agent }
 * @returns {Promise<object>} Context Passport
 */
async function commit(toAgentId, payload, opts = {}) {
  const resolvedTo = toAgentId || process.env.DARKMATTER_AGENT_ID;
  const body = buildCommitBody(resolvedTo, payload, opts);
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

/**
 * Module-level configure helper — sets DARKMATTER_API_KEY in process.env.
 * @param {object} opts - { apiKey }
 */
function configure(opts = {}) {
  if (opts.apiKey) process.env.DARKMATTER_API_KEY = opts.apiKey;
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
    const resolvedTo = toAgentId || process.env.DARKMATTER_AGENT_ID;
    return this._req('POST', '/api/commit', buildCommitBody(resolvedTo, payload, opts));
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
    const t0      = Date.now();

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

    const result = await this._app.invoke(input, config);

    // Commit the full graph run as a parent summary record
    try {
      await this._dm.commit(
        this._toAgentId,
        {
          input:      typeof input === 'object' ? JSON.stringify(input).slice(0, 400) : String(input).slice(0, 400),
          output:     typeof result === 'object' ? JSON.stringify(result).slice(0, 400) : String(result).slice(0, 400),
          latency_ms: Date.now() - t0,
          wrapper:    'langgraph',
          event:      'graph_run',
        },
        { traceId, eventType: 'langgraph_graph', agent: { provider: 'langgraph' } }
      );
    } catch (e) {
      console.warn('[DarkMatter] graph summary commit failed:', e.message);
    }

    return result;
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

  // ── chat.completions.create ───────────────────────────────────────────────
  const originalChatCreate = openaiClient.chat.completions.create.bind(openaiClient.chat.completions);

  openaiClient.chat.completions.create = async function(params) {
    const t0       = Date.now();
    const response = await originalChatCreate(params);
    const output   = response.choices?.[0]?.message?.content || '';
    try {
      const ctx = await dm.commit(
        toAgentId,
        { input:  params.messages,
          output,
          memory: { model: params.model,
                    finish_reason: response.choices?.[0]?.finish_reason,
                    usage: response.usage,
                    latency_ms: Date.now() - t0 } },
        { traceId, eventType: 'commit',
          agent: { provider: 'openai', model: params.model, wrapper: 'openai_chat' } }
      );
      lastCtxId = ctx.id;
    } catch (e) {
      console.warn('[DarkMatter] chat commit failed:', e.message);
    }
    return response;
  };

  // ── responses.create (Responses API — openai >= 4.77.0) ──────────────────
  if (openaiClient.responses && typeof openaiClient.responses.create === 'function') {
    const originalResponsesCreate = openaiClient.responses.create.bind(openaiClient.responses);

    openaiClient.responses.create = async function(params) {
      const t0       = Date.now();
      const response = await originalResponsesCreate(params);

      // Extract output text from Responses API structure
      let outputText = '';
      try {
        if (response.output_text) {
          outputText = response.output_text;
        } else if (Array.isArray(response.output)) {
          for (const item of response.output) {
            for (const block of item.content || []) {
              if (block.type === 'output_text' || block.type === 'text') {
                outputText += block.text || '';
              }
            }
          }
        }
      } catch (_) {}

      try {
        const ctx = await dm.commit(
          toAgentId,
          { input:  typeof params.input === 'string'
                      ? params.input.slice(0, 500)
                      : JSON.stringify(params.input).slice(0, 500),
            output: outputText.slice(0, 500),
            memory: { model:      params.model,
                      latency_ms: Date.now() - t0,
                      usage:      response.usage } },
          { traceId, eventType: 'commit',
            agent: { provider: 'openai', model: params.model, wrapper: 'openai_responses' } }
        );
        lastCtxId = ctx.id;
      } catch (e) {
        console.warn('[DarkMatter] responses commit failed:', e.message);
      }
      return response;
    };
  }

  Object.defineProperty(openaiClient, 'lastCtxId', { get: () => lastCtxId });
  return openaiClient;
}

module.exports = {
  DarkMatter,
  DarkMatterTracer,
  dmAnthropicClient,
  dmOpenAIClient,
  configure,
  commit, pull, replay, fork, verify,
  export: exportChain,
  search, diff, me,
  // Exported so a caller can recompute what we sent and check it themselves,
  // and so the cross-implementation test can compare against the server.
  canonicalize, hashPayload,
};
