// real_work_adapter.js
var BASE = "https://thebotclub.com/api/v2";
function key(env) {
  return env?.BOTCLUB_API_KEY ? String(env.BOTCLUB_API_KEY) : null;
}
function headers(env) {
  return { "X-API-Key": key(env), "Accept": "application/json" };
}
async function request(env, path, opts = {}) {
  const k = key(env);
  if (!k) return { ok: false, code: "BOTCLUB_API_KEY_MISSING", verified: false };
  const h = { ...headers(env), ...opts.headers || {} };
  try {
    const res = await fetch(`${BASE}${path}`, { ...opts, headers: h });
    const text2 = await res.text();
    let body;
    try {
      body = JSON.parse(text2);
    } catch {
      body = { raw: text2.slice(0, 400) };
    }
    return { ok: res.ok, status: res.status, body, verified: true };
  } catch (e) {
    return { ok: false, status: null, body: null, verified: false, network_error: true, error: String(e?.message || e) };
  }
}
async function adapterStatus(env) {
  if (!key(env)) return { configured: false, verified: false, mutation_enabled: false, source: "thebotclub_api_v2" };
  const r = await request(env, "/me");
  return { configured: true, verified: r.ok, mutation_enabled: false, source: "thebotclub_api_v2", status: r.status, profile: r.ok ? r.body : null, error: r.ok ? null : r.body };
}
async function getJob(env, jobId) {
  if (!jobId) return { ok: false, code: "JOB_ID_REQUIRED", verified: false };
  return request(env, `/jobs/${encodeURIComponent(jobId)}`);
}
async function listJobs(env, filters = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== void 0 && v !== null && v !== "") q.set(k, String(v));
  return request(env, `/jobs${q.toString() ? `?${q}` : ""}`);
}
async function listBids(env, filters = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== void 0 && v !== null && v !== "") q.set(k, String(v));
  return request(env, `/bids${q.toString() ? `?${q}` : ""}`);
}
async function listSubmissions(env, filters = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== void 0 && v !== null && v !== "") q.set(k, String(v));
  return request(env, `/submissions${q.toString() ? `?${q}` : ""}`);
}
async function getWallet(env) {
  return request(env, "/wallet");
}
async function paymentEvidence(env, jobId) {
  if (!jobId) return { ok: false, code: "JOB_ID_REQUIRED", verified: false };
  const [subs, wallet] = await Promise.all([listSubmissions(env), getWallet(env)]);
  if (!subs.ok) return { ok: false, code: "SUBMISSIONS_READ_FAILED", submissions: subs, wallet: wallet.ok ? wallet : null, verified: false };
  const rows = Array.isArray(subs.body?.data) ? subs.body.data : Array.isArray(subs.body?.submissions) ? subs.body.submissions : [];
  const matches = rows.filter((x) => String(x?.jobId ?? x?.job_id ?? "") === String(jobId));
  const paymentSignals = matches.map((x) => ({ submission_id: x?.id ?? null, status: x?.status ?? null, payment_status: x?.paymentStatus ?? x?.payment_status ?? null, payment_received_at: x?.paymentReceivedAt ?? x?.payment_received_at ?? null, amount: x?.amount ?? null, updated_at: x?.updatedAt ?? x?.updated_at ?? null }));
  return { ok: true, verified: true, job_id: String(jobId), submissions: paymentSignals, wallet: wallet.ok ? wallet.body : null, payment_received: paymentSignals.some((x) => String(x.payment_status || "").toUpperCase() === "RECEIVED" || x.payment_received_at != null), source: "thebotclub_api_v2", read_only: true, external_mutation: false };
}
async function getBidStatus(env, jobId) {
  if (!jobId) return { ok: false, code: "JOB_ID_REQUIRED", verified: false };
  const r = await listBids(env);
  if (!r.ok) return { ...r, job_id: String(jobId), status: "UNKNOWN", accepted: false };
  const rows = Array.isArray(r.body?.data) ? r.body.data : Array.isArray(r.body?.bids) ? r.body.bids : [];
  const matches = rows.filter((b) => String(b?.jobId ?? b?.job_id ?? "") === String(jobId));
  const bid = matches[0] || null;
  const status = String(bid?.status || "NOT_FOUND").toUpperCase();
  return { ok: true, verified: true, job_id: String(jobId), status, bid, accepted: status === "ACCEPTED", terminal: ["ACCEPTED", "REJECTED", "WITHDRAWN"].includes(status) };
}
function buildBidPreflight({ jobId, amount, message = "", estimatedHours = null } = {}) {
  if (!jobId || !(Number(amount) > 0)) return { ok: false, code: "INVALID_BID" };
  return { ok: true, mutation: "PLACE_BID", endpoint: `POST /jobs/${jobId}/bids`, body: { amount: Number(amount), message: String(message), ...estimatedHours != null ? { estimatedHours: Number(estimatedHours) } : {} }, external_mutation: false, owner_approval_required: true };
}
function buildSubmissionPreflight({ jobId, content, fileUrls = [] } = {}) {
  if (!jobId || !String(content || "").trim()) return { ok: false, code: "INVALID_SUBMISSION" };
  return { ok: true, mutation: "SUBMIT_WORK", endpoint: `POST /jobs/${jobId}/submissions`, body: { content: String(content), fileUrls: Array.isArray(fileUrls) ? fileUrls : [] }, external_mutation: false, owner_approval_required: true };
}
async function liveReadVerification(env, opts = {}) {
  if (!key(env)) return { verified: false, live: false, code: "BOTCLUB_API_KEY_MISSING", source: "thebotclub_api_v2" };
  const profile = await request(env, "/me");
  const jobs = await request(env, `/jobs?status=OPEN&limit=${Math.min(Math.max(Number(opts.limit) || 5, 1), 20)}`);
  return {
    verified: Boolean(profile.ok && jobs.ok),
    live: true,
    source: "thebotclub_api_v2",
    profile: { ok: profile.ok, status: profile.status },
    jobs: { ok: jobs.ok, status: jobs.status, count: Array.isArray(jobs.body?.data) ? jobs.body.data.length : null },
    mutation_enabled: false,
    external_mutation: false
  };
}

// live_cycle.js
async function firstLiveBidCycle(env, opts = {}) {
  if (!env?.BOTCLUB_API_KEY) return { ok: false, verified: false, live: false, code: "BOTCLUB_API_KEY_MISSING", mutation: "PLACE_BID" };
  const read = await liveReadVerification(env, { limit: Math.min(Math.max(Number(opts.limit) || 5, 1), 20) });
  if (!read.verified) return { ok: false, verified: false, live: true, code: "LIVE_READ_FAILED", read, mutation: "PLACE_BID" };
  const jobs = await listJobs(env, { status: "OPEN", limit: Math.min(Math.max(Number(opts.limit) || 5, 1), 20) });
  const rows = Array.isArray(jobs.body?.data) ? jobs.body.data : Array.isArray(jobs.body?.jobs) ? jobs.body.jobs : [];
  const candidate = rows.find((j) => j?.id || j?.job_id);
  if (!candidate) return { ok: true, verified: true, live: true, status: "NO_OPEN_JOB", read, jobs_count: rows.length, mutation: "PLACE_BID" };
  const jobId = String(candidate.id || candidate.job_id);
  return { ok: true, verified: true, live: true, status: "JOB_READY_FOR_OWNER_REVIEW", job: { id: jobId, title: candidate.title || candidate.name || null, description: candidate.description || null, budget: candidate.budget ?? candidate.price ?? null, currency: candidate.currency || null, deadline: candidate.deadline || null }, bid_preflight: buildBidPreflight({ jobId, amount: opts.amount, message: opts.message || "", estimatedHours: opts.estimatedHours }), mutation: "PLACE_BID", external_mutation: false, owner_approval_required: true };
}

// market_connectors.js
var BOTCLUB_BASE = "https://thebotclub.com/api/v1";
var NEAR_BASE = "https://market.near.ai/v1";
function normalizeJob(source, j) {
  return {
    source,
    id: String(j?.id ?? ""),
    title: String(j?.title ?? j?.name ?? ""),
    description: String(j?.description ?? ""),
    status: String(j?.status ?? "UNKNOWN"),
    budget: j?.budget ?? j?.amount ?? null,
    currency: j?.currency ?? null,
    deadline: j?.deadline ?? null,
    url: j?.url ?? j?.source_url ?? null,
    raw: j
  };
}
async function botClubJobs(env, opts = {}) {
  if (!env.BOTCLUB_API_KEY) return { ok: false, source: "botclub", code: "NO_API_KEY", jobs: [] };
  const u = new URL(BOTCLUB_BASE + "/jobs");
  u.searchParams.set("status", "OPEN");
  u.searchParams.set("page", String(opts.page || 1));
  u.searchParams.set("pageSize", String(Math.min(Number(opts.pageSize || 20), 50)));
  if (opts.category) u.searchParams.set("category", String(opts.category));
  try {
    const r = await fetch(u, { headers: { "x-api-key": env.BOTCLUB_API_KEY, "accept": "application/json" } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, source: "botclub", code: r.status === 401 || r.status === 403 ? "AUTH_FAILED" : "HTTP_ERROR", status: r.status, jobs: [] };
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    return { ok: true, source: "botclub", jobs: list.map((x) => normalizeJob("botclub", x)), total: body?.total ?? list.length, hasMore: Boolean(body?.hasMore) };
  } catch (e) {
    return { ok: false, source: "botclub", code: "NETWORK_ERROR", error: String(e), jobs: [] };
  }
}
async function nearJobs(env, opts = {}) {
  if (!env.NEAR_AGENT_TOKEN) return { ok: false, source: "near", code: "NO_API_KEY", jobs: [] };
  const u = new URL(NEAR_BASE + "/jobs/board");
  u.searchParams.set("limit", String(Math.min(Number(opts.limit || 20), 50)));
  u.searchParams.set("offset", String(Number(opts.offset || 0)));
  if (opts.q) u.searchParams.set("q", String(opts.q));
  if (opts.sort) u.searchParams.set("sort", String(opts.sort));
  try {
    const r = await fetch(u, { headers: { "authorization": `Bearer ${env.NEAR_AGENT_TOKEN}`, "accept": "application/json" } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, source: "near", code: r.status === 401 || r.status === 403 ? "AUTH_FAILED" : "HTTP_ERROR", status: r.status, jobs: [] };
    const list = Array.isArray(body?.jobs) ? body.jobs : Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    return { ok: true, source: "near", jobs: list.map((x) => normalizeJob("near", x)), raw_count: list.length };
  } catch (e) {
    return { ok: false, source: "near", code: "NETWORK_ERROR", error: String(e), jobs: [] };
  }
}
async function scanMarkets(env, opts = {}) {
  const [near, botclub] = await Promise.all([nearJobs(env, opts.near || {}), botClubJobs(env, opts.botclub || {})]);
  return {
    ok: true,
    read_only: true,
    external_mutation: false,
    sources: [near, botclub],
    jobs: [...near.jobs, ...botclub.jobs],
    summary: {
      available_sources: [near, botclub].filter((x) => x.ok).map((x) => x.source),
      unavailable_sources: [near, botclub].filter((x) => !x.ok).map((x) => ({ source: x.source, code: x.code })),
      job_count: near.jobs.length + botclub.jobs.length
    }
  };
}

// sha256_sync.js
var K = new Uint32Array([1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298]);

// opportunity_pipeline.js
var RISK_PATTERNS = [
  [/credential|password|api key|private key|secret/i, "CREDENTIAL_ACCESS"],
  [/impersonat|fake identity|identity verification|kyc bypass/i, "IDENTITY_OR_KYC"],
  [/bypass|circumvent|evad(e|ing)|ban|restriction/i, "PLATFORM_BYPASS"],
  [/spam|mass message|bulk unsolicited/i, "SPAM_OR_ABUSE"],
  [/financial transaction|transfer funds|withdraw money|payment account/i, "FINANCIAL_ACTION"]
];
function num(v) {
  if (v === null || v === void 0 || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s3 = String(v).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return s3 ? Number(s3[0]) : null;
}
function normalizeBudget(job) {
  const value = num(job?.budget);
  const currency = job?.currency ? String(job.currency).toUpperCase() : null;
  return { value: value !== null && value >= 0 ? value : null, currency };
}
function deadlineState(deadline, nowMs) {
  if (!deadline) return { known: false, expired: false };
  const t = Date.parse(String(deadline));
  if (!Number.isFinite(t)) return { known: false, expired: false, invalid: true };
  return { known: true, expired: t <= nowMs, timestamp: t };
}
function detectRisks(job) {
  const text2 = `${job?.title || ""}
${job?.description || ""}`;
  const flags = [];
  for (const [rx, code] of RISK_PATTERNS) if (rx.test(text2) && !flags.includes(code)) flags.push(code);
  return flags;
}
function knownFee(job) {
  const fee = num(job?.platform_fee ?? job?.fee ?? job?.platformFee);
  if (fee === null) return { known: false, amount: null, basis: null };
  const raw = String(job?.platform_fee ?? job?.fee ?? job?.platformFee ?? "");
  const percent = /%|percent|percentage/i.test(raw) || Number(job?.platform_fee_percent) >= 0;
  if (percent) {
    const pct = Number(job?.platform_fee_percent ?? fee);
    return Number.isFinite(pct) ? { known: true, amount: null, percent: pct, basis: "PERCENT" } : { known: false, amount: null, basis: null };
  }
  return { known: true, amount: fee, percent: null, basis: "FIXED" };
}
function estimateAiCost(job, opts) {
  if (Number.isFinite(Number(opts?.ai_cost))) return Math.max(0, Number(opts.ai_cost));
  return 0;
}
function estimateToolCost(job, opts) {
  if (Number.isFinite(Number(opts?.tool_cost))) return Math.max(0, Number(opts.tool_cost));
  return 0;
}
function scoreOpportunity(x) {
  if (x.eligibility === "REJECT") return -Infinity;
  const profit = x.economics.net_profit_known;
  const margin = x.economics.margin_percent;
  const minutes = Math.max(1, x.economics.estimated_minutes);
  const riskPenalty = x.risk_flags.length * 100;
  const uncertaintyPenalty = x.economics.unknown_costs.length * 50 + (x.economics.fee_known ? 0 : 75);
  const profitScore = profit === null ? -25 : profit;
  const marginScore = margin === null ? 0 : margin;
  return Math.round((profitScore + marginScore - riskPenalty - uncertaintyPenalty + 1e3 / minutes) * 100) / 100;
}
function evaluateOpportunity(job, opts = {}) {
  const budget = normalizeBudget(job);
  const deadline = deadlineState(job?.deadline, opts.now_ms ?? Date.now());
  const risk_flags = detectRisks(job);
  const fee = knownFee(job);
  const minutes = Number(opts.estimated_minutes ?? job?.estimated_minutes ?? 30);
  const aiCost = estimateAiCost(job, opts);
  const toolCost = estimateToolCost(job, opts);
  const unknown_costs = [];
  if (!budget.value && budget.value !== 0) unknown_costs.push("BUDGET");
  if (!fee.known) unknown_costs.push("PLATFORM_FEE");
  const feeAmount = fee.known ? fee.basis === "PERCENT" && budget.value !== null ? budget.value * fee.percent / 100 : fee.amount : null;
  if (fee.known && feeAmount === null) unknown_costs.push("FEE_CALCULATION");
  const knownCosts = aiCost + toolCost + (feeAmount ?? 0);
  const net = budget.value === null || feeAmount === null ? null : budget.value - knownCosts;
  const margin = net === null || budget.value <= 0 ? null : net / budget.value * 100;
  const blockers = [];
  if (deadline.expired) blockers.push("EXPIRED_DEADLINE");
  if (budget.value === null) blockers.push("MISSING_OR_INVALID_BUDGET");
  if (budget.value === 0) blockers.push("ZERO_BUDGET");
  if (net !== null && net <= 0) blockers.push("NON_POSITIVE_NET_PROFIT");
  if (risk_flags.length) blockers.push("RISK_REVIEW_REQUIRED");
  if (unknown_costs.length) blockers.push("UNKNOWN_ECONOMICS");
  let eligibility = "ELIGIBLE";
  if (deadline.expired || net !== null && net <= 0) eligibility = "REJECT";
  else if (risk_flags.length || unknown_costs.length || deadline.invalid) eligibility = "REVIEW";
  const result = {
    source: job?.source ?? "unknown",
    id: String(job?.id ?? ""),
    title: String(job?.title ?? ""),
    url: job?.url ?? null,
    currency: budget.currency,
    eligibility,
    blockers,
    risk_flags,
    economics: {
      budget: budget.value,
      fee_known: fee.known,
      fee_amount: feeAmount,
      fee_basis: fee.basis ?? null,
      ai_cost: aiCost,
      tool_cost: toolCost,
      known_costs: knownCosts,
      net_profit_known: net,
      margin_percent: margin,
      estimated_minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 30,
      unknown_costs,
      assumptions: ["FREE_AI_COST_ASSUMPTION_ONLY"]
    },
    deadline,
    raw_status: job?.status ?? null
  };
  result.rank_score = scoreOpportunity(result);
  return result;
}
function rankOpportunities(jobs, opts = {}) {
  const evaluated = (Array.isArray(jobs) ? jobs : []).map((j) => evaluateOpportunity(j, opts));
  return evaluated.sort((a, b) => b.rank_score - a.rank_score || String(a.id).localeCompare(String(b.id)));
}
function buildOpportunityPipeline(scan, opts = {}) {
  const ranked = rankOpportunities(scan?.jobs || [], opts);
  return {
    ok: true,
    read_only: true,
    external_mutation: false,
    generated_at: new Date(opts.now_ms ?? Date.now()).toISOString(),
    source_summary: scan?.summary ?? null,
    opportunities: ranked,
    summary: {
      total: ranked.length,
      eligible: ranked.filter((x) => x.eligibility === "ELIGIBLE").length,
      review: ranked.filter((x) => x.eligibility === "REVIEW").length,
      rejected: ranked.filter((x) => x.eligibility === "REJECT").length,
      executable: false,
      external_actions_enabled: false
    }
  };
}

// work_plan.js
var RISK_BLOCKERS = /* @__PURE__ */ new Set(["credential_access", "identity_impersonation", "platform_bypass"]);
function text(v) {
  return String(v ?? "").trim();
}
function buildWorkPlan(opportunity, opts = {}) {
  const o = opportunity || {};
  const risks = Array.isArray(o.risk_flags) ? o.risk_flags : [];
  const blockers = [];
  if (o.eligibility === "REJECT") blockers.push("opportunity_rejected");
  if (o.eligibility !== "ELIGIBLE") blockers.push("opportunity_requires_review");
  if (risks.some((r) => RISK_BLOCKERS.has(r))) blockers.push("safety_or_access_risk");
  if (o.economics?.unknown_costs?.length) blockers.push("unknown_economics");
  const title = text(o.title) || "Untitled opportunity";
  const steps = [
    { id: 1, name: "requirements", action: "Extract deliverables, constraints, deadline and acceptance criteria.", status: "PENDING" },
    { id: 2, name: "source_verification", action: "Verify the opportunity source and required facts using approved read-only access.", status: "PENDING" },
    { id: 3, name: "resource_plan", action: "Select available free AI/search/browser/API capabilities; do not assume unavailable access.", status: "PENDING" },
    { id: 4, name: "work_product", action: "Produce the requested work product within the verified scope.", status: "PENDING" },
    { id: 5, name: "quality_assurance", action: "Check completeness, factual support, formatting and acceptance criteria.", status: "PENDING" },
    { id: 6, name: "delivery_preflight", action: "Prepare a delivery package without submitting or mutating any external platform.", status: "BLOCKED" }
  ];
  return {
    ok: true,
    plan_version: "2.2",
    mode: "WORK_PLAN_ONLY",
    execution_enabled: false,
    external_mutation: false,
    opportunity: { source: o.source || null, id: o.id || null, title, url: o.url || null, eligibility: o.eligibility || null },
    economics: o.economics || null,
    risk_flags: risks,
    blockers: [...new Set(blockers)],
    steps,
    required_inputs: [
      "verified_job_requirements",
      "verified_acceptance_criteria",
      "available_free_tools_and_access"
    ],
    prohibited_actions: ["bid", "claim", "stake", "submit", "payment", "withdrawal", "credential_submission"],
    owner_approval_required: true,
    executable: false,
    generated_at: new Date(opts.now_ms ?? Date.now()).toISOString()
  };
}
function buildPlans(opportunities, opts = {}) {
  const list = Array.isArray(opportunities) ? opportunities : [];
  return list.map((o) => buildWorkPlan(o, opts));
}

// free_tool_router.js
var DEFAULT_GEMINI = "gemini-3.1-flash-lite";
var FALLBACK_GEMINI = "gemini-2.5-flash-lite";
var DEFAULT_CF_MODEL = "@cf/zai-org/glm-4.7-flash";
var DEFAULT_MISTRAL = "mistral-small-latest";
var TIMEOUT_MS = 25e3;
var SYSTEM_RULES = "You are a general-purpose work agent. Never perform external mutations, payments, credential submission, identity impersonation, or platform bypass. Mark unknown facts explicitly.";
function clean(v) {
  return String(v ?? "").trim();
}
function freeProviderStatus(env) {
  return {
    free_only: true,
    paid_fallback: false,
    providers: [
      { id: "gemini", configured: Boolean(env.GEMINI_API_KEY), mode: "api_key_free_tier", model: env.GEMINI_MODEL || DEFAULT_GEMINI },
      { id: "cloudflare_workers_ai", configured: Boolean(env.AI), mode: "workers_free_allocation", model: env.CF_AI_MODEL || DEFAULT_CF_MODEL },
      { id: "mistral", configured: Boolean(env.MISTRAL_API_KEY), mode: "free_mode", model: env.MISTRAL_MODEL || DEFAULT_MISTRAL }
    ]
  };
}
function order(env) {
  const out = [];
  if (env.GEMINI_API_KEY) out.push("gemini");
  if (env.AI) out.push("cloudflare_workers_ai");
  if (env.MISTRAL_API_KEY) out.push("mistral");
  return out;
}
async function geminiCall(model, task, env) {
  const body = { contents: [{ role: "user", parts: [{ text: `You are a general-purpose work agent. Complete this legitimate task as far as available tools allow. Do not purchase, pay, bid, claim, submit, withdraw, expose credentials, or perform external mutations. Mark unknown facts explicitly. TASK:
${task}` }] }], tools: [{ google_search: {} }] };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": String(env.GEMINI_API_KEY) }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}
async function gemini(task, env) {
  let model = env.GEMINI_MODEL || DEFAULT_GEMINI;
  let { r, j } = await geminiCall(model, task, env);
  if (r.status === 404 && !env.GEMINI_MODEL) {
    model = FALLBACK_GEMINI;
    ({ r, j } = await geminiCall(model, task, env));
  }
  if (!r.ok) return { ok: false, provider: "gemini", code: r.status === 429 ? "PROVIDER_LIMIT" : r.status === 404 ? "MODEL_NOT_FOUND" : "PROVIDER_ERROR", status: r.status, model, details: j };
  const text2 = j?.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join("") || "";
  if (!text2.trim()) return { ok: false, provider: "gemini", code: "EMPTY_PROVIDER_RESPONSE", model };
  return { ok: true, provider: "gemini", model, text: text2, raw_grounding_metadata: j?.candidates?.[0]?.groundingMetadata || null };
}
function cfText(r) {
  if (typeof r === "string") return r;
  const c = r?.choices?.[0];
  const cands = [r?.response, r?.result?.response, typeof r?.result === "string" ? r.result : null, c?.message?.content, c?.text];
  for (const x of cands) {
    if (typeof x === "string" && x.trim()) return x;
  }
  return "";
}
async function cloudflare(task, env) {
  const model = env.CF_AI_MODEL || DEFAULT_CF_MODEL;
  try {
    const r = await env.AI.run(model, { messages: [{ role: "system", content: SYSTEM_RULES }, { role: "user", content: task }] });
    const text2 = cfText(r);
    if (!text2.trim()) return { ok: false, provider: "cloudflare_workers_ai", code: "EMPTY_PROVIDER_RESPONSE", model };
    return { ok: true, provider: "cloudflare_workers_ai", model, text: text2 };
  } catch (e) {
    return { ok: false, provider: "cloudflare_workers_ai", code: "PROVIDER_ERROR", details: String(e) };
  }
}
async function mistral(task, env) {
  const model = env.MISTRAL_MODEL || DEFAULT_MISTRAL;
  const r = await fetch("https://api.mistral.ai/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${env.MISTRAL_API_KEY}` }, body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM_RULES }, { role: "user", content: task }] }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, provider: "mistral", code: r.status === 429 ? "PROVIDER_LIMIT" : "PROVIDER_ERROR", status: r.status, details: j };
  const text2 = j?.choices?.[0]?.message?.content || "";
  if (!String(text2).trim()) return { ok: false, provider: "mistral", code: "EMPTY_PROVIDER_RESPONSE", model };
  return { ok: true, provider: "mistral", model, text: text2 };
}
async function runFreeAI(task, env) {
  const prompt = clean(task);
  if (!prompt) return { ok: false, code: "TASK_REQUIRED" };
  const providers = order(env);
  if (!providers.length) return { ok: false, code: "NO_FREE_PROVIDER_CONFIGURED", attempts: [], paid_fallback: false };
  const attempts = [];
  for (const p of providers) {
    let r;
    try {
      r = p === "gemini" ? await gemini(prompt, env) : p === "cloudflare_workers_ai" ? await cloudflare(prompt, env) : await mistral(prompt, env);
    } catch (e) {
      r = { ok: false, provider: p, code: "PROVIDER_EXCEPTION", details: String(e) };
    }
    attempts.push({ provider: p, ok: r.ok, code: r.code || null });
    if (r.ok) return { ...r, attempts, paid_fallback: false, free_only: true };
  }
  return { ok: false, code: "ALL_FREE_PROVIDERS_FAILED", attempts, paid_fallback: false, free_only: true };
}

// work_execution.js
function clean2(v) {
  return String(v ?? "").trim();
}
function sha256Hex(input) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)).then(
    (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("")
  );
}
function qaWork(task, result) {
  const issues = [];
  const text2 = clean2(result?.text);
  if (!result?.ok) issues.push("ai_work_failed");
  if (!text2) issues.push("empty_work_product");
  if (text2.length < 40) issues.push("work_product_too_short");
  if (/I cannot|I can't|unable to complete/i.test(text2)) issues.push("provider_declined_or_incomplete");
  return { passed: issues.length === 0, issues, checks: { non_empty: Boolean(text2), minimum_length: text2.length >= 40, provider_success: Boolean(result?.ok) } };
}
async function executeWork(task, env, opts = {}) {
  const t = clean2(task);
  if (!t) return { ok: false, code: "TASK_REQUIRED" };
  if (t.length > 4e3) return { ok: false, code: "TASK_TOO_LONG" };
  const assessment = opts.assessment ?? (typeof opts.assess === "function" ? opts.assess(t) : null);
  if (assessment?.decision === "REJECT") {
    return { ok: false, status: "REJECTED", code: "TASK_REJECTED", assessment, external_mutation: false };
  }
  if (assessment?.risk_flags?.length) {
    return { ok: false, status: "REVIEW_REQUIRED", code: "RISK_REVIEW_REQUIRED", assessment, external_mutation: false };
  }
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const result = await runFreeAI(t, env);
  const qa = qaWork(t, result);
  const workProduct = clean2(result?.text);
  const proofHash = workProduct ? await sha256Hex(workProduct) : null;
  const completedAt = (/* @__PURE__ */ new Date()).toISOString();
  return {
    ok: result.ok && qa.passed,
    status: result.ok && qa.passed ? "WORK_PRODUCT_READY" : "WORK_PRODUCT_FAILED",
    mode: "SAFE_AGENT_EXECUTION",
    task: t,
    started_at: startedAt,
    completed_at: completedAt,
    provider: result.provider || null,
    model: result.model || null,
    work_product: workProduct || null,
    proof_hash: proofHash,
    quality_gate: qa,
    attempts: result.attempts || [],
    free_only: true,
    paid_fallback: false,
    external_mutation: false,
    external_delivery: "BLOCKED",
    owner_approval_required: true,
    external_actions: { bid: false, claim: false, stake: false, submit: false, payment: false, withdrawal: false, credential_submission: false, account_change: false, external_message: false }
  };
}

// work_run_state_machine.js
var WORK_RUN_STATES = Object.freeze([
  "CLAIMED",
  "AI_STARTED",
  "AI_FINISHED",
  "QA_PASSED",
  "SUBMISSION_READY",
  "WORK_FAILED"
]);
var ALLOWED = Object.freeze({
  START: ["CLAIMED"],
  CLAIMED: ["AI_STARTED", "WORK_FAILED"],
  AI_STARTED: ["AI_FINISHED", "WORK_FAILED"],
  AI_FINISHED: ["QA_PASSED", "WORK_FAILED"],
  QA_PASSED: ["SUBMISSION_READY", "WORK_FAILED"],
  SUBMISSION_READY: [],
  WORK_FAILED: []
});
function allowedNext(current) {
  const key2 = current == null || current === "" ? "START" : String(current);
  return ALLOWED[key2] ? [...ALLOWED[key2]] : [];
}
function validateTransition(current, next) {
  const n = String(next || "");
  if (!WORK_RUN_STATES.includes(n)) return { ok: false, code: "UNKNOWN_WORK_RUN_STATE", current: current ?? null, next: n };
  const allowed = allowedNext(current);
  if (!allowed.includes(n)) return { ok: false, code: "INVALID_WORK_RUN_TRANSITION", current: current ?? null, next: n, allowed };
  return { ok: true, current: current ?? null, next: n, allowed };
}
function validateHistory(history = []) {
  const rows = Array.isArray(history) ? history : [];
  let current = null;
  for (const item of rows) {
    const r = validateTransition(current, item?.phase);
    if (!r.ok) return { ok: false, index: rows.indexOf(item), ...r };
    current = r.next;
  }
  return { ok: true, current, history_length: rows.length };
}

// work_run_claim.js
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function runId(jobId) {
  return `JOBRUN:${String(jobId)}`;
}
async function claimWorkRun(env, { jobId, bidId = null } = {}) {
  if (!jobId) return { ok: false, code: "JOB_ID_REQUIRED" };
  if (!env?.DB) return { ok: false, code: "DB_NOT_CONFIGURED" };
  const rid = runId(jobId);
  const createdAt = now();
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO work_runs(run_id,job_id,bid_id,status,created_at,updated_at,result) VALUES(?,?,?,?,?,?,?)").bind(rid, String(jobId), bidId != null ? String(bidId) : null, "WORK_IN_PROGRESS", createdAt, createdAt, null).run();
  const inserted = Number(claim?.meta?.changes || 0) > 0;
  if (inserted) return { ok: true, claimed: true, run_id: rid, job_id: String(jobId), status: "WORK_IN_PROGRESS", created_at: createdAt };
  const existing = await env.DB.prepare("SELECT * FROM work_runs WHERE run_id=?").bind(rid).first();
  if (existing) {
    let stored = null;
    try {
      stored = existing.result ? JSON.parse(existing.result) : null;
    } catch {
    }
    if (["WORK_IN_PROGRESS", "WORK_QA_PASSED", "SUBMISSION_READY"].includes(existing.status)) {
      return { ok: true, claimed: false, reused: true, run_id: rid, job_id: String(jobId), status: existing.status, result: stored, external_mutation: false };
    }
    return { ok: false, blocked: true, code: "WORK_RUN_ALREADY_EXISTS", run_id: rid, job_id: String(jobId), status: existing.status, result: stored, external_mutation: false, reason: "Existing run is terminal; no automatic re-execution is allowed." };
  }
  return { ok: false, blocked: true, code: "WORK_RUN_CLAIM_FAILED", run_id: rid, job_id: String(jobId), external_mutation: false };
}

// accepted_job.js
function s(v) {
  return String(v ?? "").trim();
}
function now2() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
async function sha256Hex2(value) {
  const b = new TextEncoder().encode(String(value));
  const h = await crypto.subtle.digest("SHA-256", b);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function checkpoint(env, jobId, phase, details = {}) {
  if (!env?.DB) return { ok: false, code: "DB_NOT_CONFIGURED" };
  const rid = runId(jobId);
  const row = await env.DB.prepare("SELECT * FROM work_runs WHERE run_id=?").bind(rid).first();
  if (!row) return { ok: false, code: "WORK_RUN_NOT_FOUND" };
  let state = {};
  try {
    state = row.result ? JSON.parse(row.result) : {};
  } catch {
    state = {};
  }
  const history = Array.isArray(state.checkpoint_history) ? state.checkpoint_history.slice() : [];
  const previous = history.length ? String(history[history.length - 1]?.phase || "") : null;
  const transition = validateTransition(previous, phase);
  if (!transition.ok) return { ok: false, code: transition.code, current: previous, next: String(phase), allowed: transition.allowed || [], external_mutation: false };
  const entry = { phase: String(phase), previous_phase: previous, at: now2(), ...details };
  history.push(entry);
  state.current_checkpoint = entry;
  state.checkpoint_history = history.slice(-20);
  const expectedResult = row.result ?? null;
  const nextResult = JSON.stringify(state);
  let updated;
  if (expectedResult == null) {
    updated = await env.DB.prepare("UPDATE work_runs SET updated_at=?,result=? WHERE run_id=? AND result IS NULL").bind(entry.at, nextResult, rid).run();
  } else {
    updated = await env.DB.prepare("UPDATE work_runs SET updated_at=?,result=? WHERE run_id=? AND result=?").bind(entry.at, nextResult, rid, expectedResult).run();
  }
  const changed = Number(updated?.meta?.changes || 0);
  if (changed !== 1) return { ok: false, code: "CHECKPOINT_CONCURRENCY_CONFLICT", run_id: rid, current: previous, next: String(phase), external_mutation: false };
  const prior = await env.DB.prepare("SELECT id,payload FROM work_run_events WHERE run_id=? ORDER BY id DESC LIMIT 1").bind(rid).first();
  let previousHash = null;
  try {
    const priorPayload = prior?.payload ? JSON.parse(prior.payload) : null;
    previousHash = priorPayload?.integrity?.event_hash || null;
  } catch {
  }
  const eventSeq = history.length;
  const core = JSON.stringify({ ...entry, event_seq: eventSeq });
  const eventHash = await sha256Hex2(`${previousHash || ""}|${core}`);
  const eventPayload = { ...entry, event_seq: eventSeq, integrity: { algorithm: "SHA-256", previous_event_hash: previousHash, event_hash: eventHash } };
  await env.DB.prepare("INSERT INTO work_run_events(run_id,job_id,event_type,payload,created_at) VALUES(?,?,?,?,?)").bind(rid, String(jobId), "CHECKPOINT", JSON.stringify(eventPayload), entry.at).run();
  return { ok: true, checkpoint: entry };
}
async function prepareAcceptedJob(env, { jobId } = {}) {
  if (!jobId) return { ok: false, code: "JOB_ID_REQUIRED" };
  const bid = await getBidStatus(env, String(jobId));
  if (!bid.ok) return { ok: false, code: "BID_STATUS_UNAVAILABLE", bid_status: bid };
  if (!bid.accepted) return { ok: false, code: "BID_NOT_ACCEPTED", job_id: String(jobId), status: bid.status, bid: bid.bid || null, external_mutation: false };
  const job = await getJob(env, String(jobId));
  if (!job.ok) return { ok: false, code: "JOB_DETAILS_UNAVAILABLE", bid_status: bid, job_status: job };
  const j = job.body?.data || job.body?.job || job.body;
  if (!j || typeof j !== "object") return { ok: false, code: "JOB_DETAILS_EMPTY" };
  const opportunity = { source: "thebotclub", id: String(jobId), title: s(j.title) || `Accepted job ${jobId}`, url: j.url || null, description: s(j.description), eligibility: "ELIGIBLE", risk_flags: [], economics: { revenue: Number(j.budget) || null, known_costs: [], unknown_costs: ["Platform/payment fees not independently verified"] } };
  const plan2 = buildWorkPlan(opportunity);
  return { ok: true, stage: "JOB_ACCEPTED", job_id: String(jobId), bid_status: bid.status, accepted_bid: bid.bid || null, job: j, work_plan: plan2, execution_ready: true, external_mutation: false, submission_blocked: true, owner_approval_required_for_submission: true, run_id: runId(jobId) };
}
async function executeAcceptedJob(env, { jobId } = {}, opts = {}) {
  const rid = runId(jobId);
  if (env.DB) {
    const existing = await env.DB.prepare("SELECT * FROM work_runs WHERE run_id=?").bind(rid).first();
    if (existing) {
      let stored = null;
      try {
        stored = existing.result ? JSON.parse(existing.result) : null;
      } catch {
      }
      if (["WORK_IN_PROGRESS", "WORK_QA_PASSED", "SUBMISSION_READY"].includes(existing.status)) {
        return { ok: true, reused: true, run_id: rid, job_id: String(jobId), stage: existing.status, status: existing.status, result: stored, external_mutation: false, submission_blocked: true, owner_approval_required_for_submission: true };
      }
      return { ok: false, blocked: true, code: "WORK_RUN_ALREADY_EXISTS", run_id: rid, job_id: String(jobId), stage: existing.status, status: existing.status, result: stored, external_mutation: false, reason: "Existing run is terminal; no automatic re-execution is allowed." };
    }
  }
  const prepared = await prepareAcceptedJob(env, { jobId });
  if (!prepared.ok) return prepared;
  if (env.DB) {
    const claim = await claimWorkRun(env, { jobId, bidId: prepared.accepted_bid?.id });
    if (!claim.ok) return claim;
    if (claim.reused) return { ok: true, reused: true, run_id: claim.run_id, job_id: String(jobId), stage: claim.status, status: claim.status, result: claim.result, external_mutation: false, submission_blocked: true, owner_approval_required_for_submission: true };
  }
  await checkpoint(env, jobId, "CLAIMED", { bid_id: prepared.accepted_bid?.id != null ? String(prepared.accepted_bid.id) : null });
  await checkpoint(env, jobId, "AI_STARTED", { provider_mode: "free_provider_router" });
  const description = s(prepared.job.description);
  const title = s(prepared.job.title);
  const task = `Accepted client job. Produce the requested work product only; do not send messages, submit externally, bid, claim, pay, withdraw, or change any account.
JOB TITLE:
${title}
JOB REQUIREMENTS:
${description}
Acceptance criteria and other verified job fields:
${JSON.stringify({ budget: prepared.job.budget, deadline: prepared.job.deadline, requirements: prepared.job.requirements || null, acceptance_criteria: prepared.job.acceptanceCriteria || prepared.job.acceptance_criteria || null }, null, 2)}`;
  const assessment = typeof opts.assess === "function" ? opts.assess(description) : null;
  const result = await executeWork(task, env, { ...opts, assessment });
  await checkpoint(env, jobId, "AI_FINISHED", { provider: result.provider || null, model: result.model || null, ok: Boolean(result.ok) });
  const submission = result.ok ? buildSubmissionPreflight({ jobId, content: result.work_product, fileUrls: [] }) : null;
  const status = result.ok ? "SUBMISSION_READY" : "WORK_FAILED";
  if (result.ok) {
    await checkpoint(env, jobId, "QA_PASSED", { proof_hash: result.proof_hash || null, provider: result.provider || null });
    await checkpoint(env, jobId, "SUBMISSION_READY", { proof_hash: result.proof_hash || null });
  } else {
    await checkpoint(env, jobId, "WORK_FAILED", { code: result.code || null, provider: result.provider || null });
  }
  if (env.DB) {
    const row = await env.DB.prepare("SELECT * FROM work_runs WHERE run_id=?").bind(runId(jobId)).first();
    let state = {};
    try {
      state = row?.result ? JSON.parse(row.result) : {};
    } catch {
      state = {};
    }
    state.execution = result;
    state.submission_preflight = submission;
    await env.DB.prepare("UPDATE work_runs SET status=?,updated_at=?,result=? WHERE run_id=?").bind(status, now2(), JSON.stringify(state), runId(jobId)).run();
  }
  return { ...prepared, ok: result.ok, stage: status, execution: result, submission_preflight: submission, external_mutation: false, submission_owner_approval_required: true };
}

// submission_gate.js
async function sha256Hex3(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function submissionGuardKey(jobId, bidId) {
  return `SUBMIT_WORK:${String(jobId)}:${String(bidId || "")}`;
}
function validateSubmissionApproval(row, { jobId, bidId, contentHash } = {}) {
  if (!row) return { ok: false, code: "APPROVAL_NOT_FOUND" };
  if (row.action !== "SUBMIT_WORK") return { ok: false, code: "APPROVAL_ACTION_MISMATCH" };
  if (row.status !== "APPROVED") return { ok: false, code: "APPROVAL_NOT_APPROVED", status: row.status };
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return { ok: false, code: "APPROVAL_EXPIRED" };
  let summary = {};
  try {
    summary = JSON.parse(row.summary || "{}");
  } catch {
    return { ok: false, code: "APPROVAL_SUMMARY_INVALID" };
  }
  ;
  const target = summary.target || {};
  if (String(summary.task_id || row.task_id) !== String(jobId)) return { ok: false, code: "APPROVAL_JOB_MISMATCH" };
  if (String(target.job_id || "") !== String(jobId)) return { ok: false, code: "APPROVAL_TARGET_JOB_MISMATCH" };
  if (bidId != null && String(target.bid_id || "") !== String(bidId)) return { ok: false, code: "APPROVAL_BID_MISMATCH" };
  if (String(target.content_sha256 || "") !== String(contentHash || "")) return { ok: false, code: "APPROVAL_CONTENT_HASH_MISMATCH" };
  return { ok: true, summary, target };
}

// recovery_analysis.js
function parseResult(row) {
  try {
    return row?.result ? JSON.parse(row.result) : {};
  } catch {
    return {};
  }
}
function analyzeRecovery(row, integrity = {}) {
  if (!row) return { ok: false, code: "WORK_RUN_NOT_FOUND", external_mutation: false };
  if (integrity && integrity.checked && integrity.consistent === false) {
    return { ok: true, job_id: String(row.job_id), run_id: String(row.run_id), status: String(row.status || ""), disposition: "RECOVERY_BLOCKED_INTEGRITY", reason: "Work-run event/history reconciliation failed; recovery is blocked until the evidence record is repaired or explicitly reviewed.", safe_to_reuse: false, automatic_reexecution: false, external_mutation: false, fail_closed: true, integrity_errors: integrity.errors || [] };
  }
  const state = parseResult(row);
  const history = Array.isArray(state.checkpoint_history) ? state.checkpoint_history : [];
  const phases = history.map((x) => String(x?.phase || "")).filter(Boolean);
  const last = state.current_checkpoint?.phase || phases[phases.length - 1] || null;
  const status = String(row.status || "");
  const has = (p) => phases.includes(p);
  let disposition = "NO_RECOVERY_REQUIRED";
  let reason = "";
  let safeToReuse = false;
  if (status === "WORK_IN_PROGRESS") {
    disposition = "RECOVERY_REQUIRED";
    if (last === "AI_STARTED" && !has("AI_FINISHED")) reason = "Provider invocation may have completed without a durable completion record; automatic rerun could duplicate work or cost.";
    else if (last === "AI_FINISHED" && !has("QA_PASSED")) reason = "Provider returned, but QA/result persistence is not durably complete; inspect the stored execution state before any retry.";
    else if (last === "CLAIMED") reason = "Execution was claimed but provider execution was not durably started.";
    else reason = "Run is incomplete and must not be automatically re-executed.";
  } else if (status === "RECOVERY_REQUIRED") {
    disposition = "RECOVERY_REQUIRED";
    reason = "Run was previously quarantined by recovery logic; no automatic rerun is permitted.";
  } else if (status === "SUBMISSION_READY") {
    disposition = "REUSE_EXISTING_WORK";
    safeToReuse = true;
    reason = "A completed work product is already prepared; reuse it rather than regenerating it.";
  } else if (status === "WORK_QA_PASSED") {
    disposition = "REUSE_EXISTING_WORK";
    safeToReuse = true;
    reason = "QA has passed; regeneration is unnecessary.";
  } else if (status === "WORK_FAILED") {
    disposition = "MANUAL_REVIEW";
    reason = "The run failed; automatic retry is disabled.";
  } else if (status === "WORK_ABORTED") {
    disposition = "ABORTED";
    reason = "The run was explicitly aborted.";
  }
  return { ok: true, job_id: String(row.job_id), run_id: String(row.run_id), status, last_checkpoint: last, checkpoint_count: history.length, disposition, reason, safe_to_reuse: safeToReuse, automatic_reexecution: false, external_mutation: false, checkpoints: history };
}

// work_run_reconciliation.js
var CHECKPOINTS = ["CLAIMED", "AI_STARTED", "AI_FINISHED", "QA_PASSED", "SUBMISSION_READY", "WORK_FAILED"];
function parse(v) {
  try {
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
async function sha256Hex4(value) {
  const b = new TextEncoder().encode(String(value));
  const h = await crypto.subtle.digest("SHA-256", b);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function reconcileWorkRun(row, events = []) {
  if (!row) return { ok: false, code: "WORK_RUN_NOT_FOUND", consistent: false, fail_closed: true, external_mutation: false };
  const state = parse(row.result) || {};
  const history = Array.isArray(state.checkpoint_history) ? state.checkpoint_history : [];
  const checkpointEvents = (Array.isArray(events) ? events : []).filter((e) => String(e?.event_type || "") === "CHECKPOINT");
  const errors = [];
  if (!row.run_id || !row.job_id) errors.push("RUN_ID_OR_JOB_ID_MISSING");
  for (const e of events || []) {
    if (String(e?.run_id || "") !== String(row.run_id || "")) errors.push("EVENT_RUN_ID_MISMATCH");
    if (String(e?.job_id || "") !== String(row.job_id || "")) errors.push("EVENT_JOB_ID_MISMATCH");
  }
  const eventEntries = [];
  for (const e of checkpointEvents) {
    const p = parse(e.payload);
    if (!p || !p.phase) {
      errors.push("CHECKPOINT_EVENT_PAYLOAD_INVALID");
      continue;
    }
    if (!CHECKPOINTS.includes(String(p.phase))) errors.push("UNKNOWN_CHECKPOINT_PHASE");
    eventEntries.push({ phase: String(p.phase), previous_phase: p.previous_phase ?? null, at: p.at || e.created_at, id: e.id, event_seq: p.event_seq ?? null, payload: p });
  }
  if (eventEntries.length !== history.length) errors.push("CHECKPOINT_EVENT_COUNT_MISMATCH");
  const n = Math.min(eventEntries.length, history.length);
  for (let i = 0; i < n; i++) {
    if (String(eventEntries[i].phase) !== String(history[i]?.phase || "")) errors.push("CHECKPOINT_SEQUENCE_MISMATCH");
    if (String(eventEntries[i].previous_phase ?? "") !== String(history[i]?.previous_phase ?? "")) errors.push("CHECKPOINT_PREVIOUS_STATE_MISMATCH");
  }
  const stateMachine = validateHistory(history);
  if (!stateMachine.ok) errors.push("STATE_MACHINE_HISTORY_INVALID");
  const current = state.current_checkpoint?.phase || null;
  const lastHistory = history.at(-1)?.phase || null;
  const lastEvent = eventEntries.at(-1)?.phase || null;
  if (current !== lastHistory) errors.push("CURRENT_CHECKPOINT_MISMATCH");
  if (lastHistory !== lastEvent) errors.push("LAST_EVENT_CHECKPOINT_MISMATCH");
  const ids = eventEntries.map((x) => Number(x.id)).filter(Number.isFinite);
  for (let i = 1; i < ids.length; i++) if (ids[i] <= ids[i - 1]) errors.push("EVENT_ORDER_INVALID");
  const seqs = eventEntries.map((x) => Number(x.event_seq));
  const hasAnySeq = eventEntries.some((x) => x.event_seq != null);
  if (hasAnySeq) {
    if (eventEntries.some((x) => x.event_seq == null || !Number.isInteger(Number(x.event_seq)))) errors.push("EVENT_SEQUENCE_MISSING");
    else {
      for (let i = 0; i < seqs.length; i++) {
        const expected = i + 1;
        if (seqs[i] !== expected) errors.push("EVENT_SEQUENCE_GAP_OR_DUPLICATE");
      }
    }
  }
  let prevHash = null;
  for (const e of eventEntries) {
    const integ = e.payload?.integrity;
    if (!integ || integ.algorithm !== "SHA-256" || !integ.event_hash) {
      errors.push("EVENT_INTEGRITY_MISSING");
      continue;
    }
    if ((integ.previous_event_hash || null) !== (prevHash || null)) errors.push("EVENT_HASH_CHAIN_MISMATCH");
    const core = { ...e.payload };
    delete core.integrity;
    const expected = await sha256Hex4(`${prevHash || ""}|${JSON.stringify(core)}`);
    if (String(integ.event_hash) !== expected) errors.push("EVENT_HASH_INVALID");
    prevHash = String(integ.event_hash);
  }
  const unique = [...new Set(errors)];
  return {
    ok: true,
    consistent: unique.length === 0,
    fail_closed: unique.length > 0,
    disposition: unique.length ? "INCONSISTENT_EVIDENCE" : "CONSISTENT",
    errors: unique,
    run_id: String(row.run_id),
    job_id: String(row.job_id),
    status: String(row.status || ""),
    checkpoint_count: history.length,
    event_checkpoint_count: eventEntries.length,
    current_checkpoint: current,
    last_checkpoint: lastHistory,
    last_event_checkpoint: lastEvent,
    event_chain_head: prevHash,
    external_mutation: false
  };
}

// work_run_snapshot.js
async function sha256Hex5(value) {
  const b = new TextEncoder().encode(String(value));
  const h = await crypto.subtle.digest("SHA-256", b);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function parse2(v) {
  try {
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
function canonicalEvidence(row, events) {
  const state = parse2(row?.result) || {};
  return {
    run_id: String(row?.run_id || ""),
    job_id: String(row?.job_id || ""),
    checkpoint_history: Array.isArray(state.checkpoint_history) ? state.checkpoint_history : [],
    current_checkpoint: state.current_checkpoint || null,
    events: (Array.isArray(events) ? events : []).map((e) => ({ id: Number(e.id), run_id: String(e.run_id || ""), job_id: String(e.job_id || ""), event_type: String(e.event_type || ""), payload: parse2(e.payload), created_at: e.created_at || null }))
  };
}
async function buildWorkRunSnapshot(row, events = []) {
  const evidence = canonicalEvidence(row, events);
  return { ok: true, run_id: evidence.run_id, job_id: evidence.job_id, algorithm: "SHA-256", evidence_hash: await sha256Hex5(JSON.stringify(evidence)), evidence };
}
async function createRecoverySnapshot(env, row, events = []) {
  if (!env?.DB) return { ok: false, code: "DB_NOT_CONFIGURED" };
  const snap = await buildWorkRunSnapshot(row, events);
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const payload = JSON.stringify(snap.evidence);
  await env.DB.prepare("INSERT OR IGNORE INTO work_run_snapshots(run_id,job_id,evidence_hash,evidence,created_at) VALUES(?,?,?,?,?)").bind(snap.run_id, snap.job_id, snap.evidence_hash, payload, ts).run();
  const stored = await env.DB.prepare("SELECT * FROM work_run_snapshots WHERE run_id=?").bind(snap.run_id).first();
  if (!stored) return { ok: false, code: "RECOVERY_SNAPSHOT_NOT_PERSISTED" };
  if (String(stored.evidence_hash) !== String(snap.evidence_hash)) return { ok: false, code: "RECOVERY_SNAPSHOT_HASH_CONFLICT", fail_closed: true };
  return { ok: true, run_id: snap.run_id, job_id: snap.job_id, evidence_hash: snap.evidence_hash, created_at: stored.created_at || ts, created: true };
}
async function verifyRecoverySnapshot(env, row, events = []) {
  if (!env?.DB) return { ok: false, code: "DB_NOT_CONFIGURED" };
  const stored = await env.DB.prepare("SELECT * FROM work_run_snapshots WHERE run_id=?").bind(String(row?.run_id || "")).first();
  if (!stored) return { ok: true, exists: false, consistent: true, fail_closed: false };
  const current = await buildWorkRunSnapshot(row, events);
  const consistent = String(stored.evidence_hash) === String(current.evidence_hash);
  return { ok: true, exists: true, consistent, fail_closed: !consistent, stored_hash: String(stored.evidence_hash || ""), current_hash: current.evidence_hash, created_at: stored.created_at || null, errors: consistent ? [] : ["RECOVERY_SNAPSHOT_EVIDENCE_MISMATCH"] };
}

// recovery_transition.js
function now3() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
async function atomicRecoveryTransition(env, { runId: runId2, fromStatus, toStatus, state, reason } = {}) {
  if (!env?.DB) return { ok: false, code: "DB_NOT_CONFIGURED", external_mutation: false };
  const ts = now3();
  const result = await env.DB.prepare("UPDATE work_runs SET status=?,updated_at=?,result=? WHERE run_id=? AND status=?").bind(String(toStatus), ts, JSON.stringify(state || {}), String(runId2), String(fromStatus)).run();
  const changes = Number(result?.meta?.changes || 0);
  if (changes !== 1) {
    return { ok: false, code: "RECOVERY_CONCURRENCY_LOST", from_status: String(fromStatus), to_status: String(toStatus), run_id: String(runId2), reason: reason || null, external_mutation: false, fail_closed: true };
  }
  return { ok: true, run_id: String(runId2), from_status: String(fromStatus), to_status: String(toStatus), updated_at: ts, external_mutation: false };
}
async function atomicRecoveryDecision(env, { runId: runId2, decision, state } = {}) {
  const d = String(decision || "").toUpperCase();
  if (d !== "ABORT") return { ok: false, code: "RECOVERY_DECISION_NOT_MUTATING", external_mutation: false };
  return atomicRecoveryTransition(env, { runId: runId2, fromStatus: "RECOVERY_REQUIRED", toStatus: "WORK_ABORTED", state, reason: "owner_abort" });
}

// run_recovery.js
function now4() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function runKey(jobId) {
  return `JOBRUN:${String(jobId)}`;
}
async function readEvents(env, runId2) {
  const rows = await env.DB.prepare("SELECT id,run_id,job_id,event_type,payload,created_at FROM work_run_events WHERE run_id=? ORDER BY id ASC").bind(runId2).all();
  return rows.results || [];
}
async function readWorkRun(env, jobId) {
  if (!env?.DB) return { ok: false, code: "DB_NOT_CONFIGURED" };
  const row = await env.DB.prepare("SELECT * FROM work_runs WHERE run_id=?").bind(runKey(jobId)).first();
  if (!row) return { ok: false, code: "WORK_RUN_NOT_FOUND", job_id: String(jobId) };
  let result = null;
  try {
    result = row.result ? JSON.parse(row.result) : null;
  } catch {
    result = null;
  }
  const events = await readEvents(env, row.run_id);
  const integrity = await reconcileWorkRun(row, events);
  const snapshot = await verifyRecoverySnapshot(env, row, events);
  const combined = { checked: true, consistent: integrity.consistent && snapshot.consistent, errors: [...integrity.errors || [], ...snapshot.errors || []] };
  return { ok: true, row, result, checkpoint: result?.current_checkpoint || null, checkpoint_history: Array.isArray(result?.checkpoint_history) ? result.checkpoint_history : [], events, integrity: combined, snapshot, analysis: analyzeRecovery(row, combined) };
}
function isStale(row, maxAgeMs = 15 * 60 * 1e3) {
  if (!row || row.status !== "WORK_IN_PROGRESS") return false;
  const t = Date.parse(row.updated_at || row.created_at || "");
  return !Number.isFinite(t) || Date.now() - t >= maxAgeMs;
}
async function recoverInterruptedRun(env, { jobId, maxAgeMs = 15 * 60 * 1e3 } = {}) {
  const r = await readWorkRun(env, jobId);
  if (!r.ok) return r;
  if (r.integrity && !r.integrity.consistent) return { ok: true, recovered: false, stage: r.row.status, code: "RECOVERY_BLOCKED_INTEGRITY", run: r.row, result: r.result, external_mutation: false, automatic_reexecution: false, fail_closed: true, integrity_errors: r.integrity.errors || [] };
  if (r.row.status !== "WORK_IN_PROGRESS") return { ok: true, recovered: false, stage: r.row.status, run: r.row, result: r.result, external_mutation: false };
  if (!isStale(r.row, maxAgeMs)) return { ok: true, recovered: false, stage: "WORK_IN_PROGRESS", code: "RUN_NOT_STALE", run: r.row, result: r.result, external_mutation: false };
  const snapshot = await createRecoverySnapshot(env, r.row, r.events || []);
  if (!snapshot.ok) return { ok: false, code: snapshot.code || "RECOVERY_SNAPSHOT_FAILED", fail_closed: true, external_mutation: false };
  const ts = now4();
  let state = {};
  try {
    state = r.result || {};
  } catch {
    state = {};
  }
  state.recovery = { ...state.recovery || {}, reason: "stale_work_run", detected_at: ts, automatic_reexecution: false, snapshot_hash: snapshot.evidence_hash };
  const transition = await atomicRecoveryTransition(env, { runId: r.row.run_id, fromStatus: "WORK_IN_PROGRESS", toStatus: "RECOVERY_REQUIRED", state, reason: "stale_work_run" });
  if (!transition.ok) return { ok: false, code: transition.code || "RECOVERY_CONCURRENCY_LOST", fail_closed: true, external_mutation: false, automatic_reexecution: false };
  const fresh = await readWorkRun(env, jobId);
  return { ok: true, recovered: true, stage: "RECOVERY_REQUIRED", run: fresh.row, result: fresh.result, external_mutation: false, automatic_reexecution: false, reason: "Execution may have been interrupted after provider invocation; the system will not rerun it automatically.", checkpoint: r.checkpoint, checkpoint_history: r.checkpoint_history, snapshot_hash: snapshot.evidence_hash };
}
async function explicitRecoveryDecision(env, { jobId, decision } = {}) {
  const d = String(decision || "").toUpperCase();
  const r = await readWorkRun(env, jobId);
  if (!r.ok) return r;
  if (r.integrity && !r.integrity.consistent) return { ok: false, code: "RECOVERY_BLOCKED_INTEGRITY", fail_closed: true, integrity_errors: r.integrity.errors || [], external_mutation: false };
  if (r.row.status !== "RECOVERY_REQUIRED") return { ok: false, code: "RECOVERY_NOT_REQUIRED", stage: r.row.status, external_mutation: false };
  if (d === "ACKNOWLEDGE") return { ok: true, stage: "RECOVERY_REQUIRED", acknowledged: true, run: r.row, result: r.result, external_mutation: false };
  if (d === "ABORT") {
    const ts = now4();
    const state = { ...r.result || {}, recovery: { ...r.result?.recovery || {}, decision: "ABORT", at: ts, automatic_reexecution: false } };
    const transition = await atomicRecoveryDecision(env, { runId: r.row.run_id, decision: "ABORT", state });
    if (!transition.ok) return { ok: false, code: transition.code || "RECOVERY_CONCURRENCY_LOST", fail_closed: true, external_mutation: false };
    return { ok: true, stage: "WORK_ABORTED", external_mutation: false };
  }
  return { ok: false, code: "RECOVERY_DECISION_INVALID", allowed: ["ACKNOWLEDGE", "ABORT"], external_mutation: false };
}

// real_cycle.js
function s2(v) {
  return String(v ?? "").trim();
}
function upper(v) {
  return s2(v).toUpperCase();
}
function firstRows(body) {
  return Array.isArray(body?.data) ? body.data : Array.isArray(body?.submissions) ? body.submissions : [];
}
function submissionForJob(rows, jobId) {
  return rows.filter((x) => s2(x?.jobId ?? x?.job_id) === s2(jobId));
}
async function realCycle(env, { jobId } = {}) {
  const id = s2(jobId);
  if (!id) return { ok: false, code: "JOB_ID_REQUIRED", read_only: true, external_mutation: false };
  const result = { ok: true, verified: false, job_id: id, read_only: true, external_mutation: false, stage: "JOB_FOUND", stages: [], job: null, bid: null, work_run: null, submission: null, payment: null };
  const add = (stage, status, source, data = {}) => result.stages.push({ stage, status, source, ...data });
  const job = await getJob(env, id);
  if (job.ok) {
    result.verified = true;
    result.job = job.body?.data || job.body?.job || job.body || null;
    add("JOB_FOUND", "VERIFIED", "thebotclub_api_v2");
  } else {
    add("JOB_FOUND", "UNVERIFIED", "thebotclub_api_v2", { code: job.code || null, status: job.status || null });
  }
  const bid = await getBidStatus(env, id);
  result.bid = { status: bid.status || "UNKNOWN", accepted: Boolean(bid.accepted), id: bid.bid?.id ?? null, amount: bid.bid?.amount ?? null, created_at: bid.bid?.createdAt ?? bid.bid?.created_at ?? null, updated_at: bid.bid?.updatedAt ?? bid.bid?.updated_at ?? null };
  if (bid.ok) {
    result.verified = true;
    add(bid.accepted ? "BID_ACCEPTED" : "BID_PENDING", bid.accepted ? "VERIFIED" : "VERIFIED", "thebotclub_api_v2", { bid_status: result.bid.status });
  } else add("BID_PENDING", "UNVERIFIED", "thebotclub_api_v2", { code: bid.code || null });
  if (env.DB) {
    const row = await env.DB.prepare("SELECT run_id,job_id,bid_id,status,created_at,updated_at,result FROM work_runs WHERE run_id=?").bind(`JOBRUN:${id}`).first();
    if (row) {
      let stored = null;
      try {
        stored = row.result ? JSON.parse(row.result) : null;
      } catch {
      }
      result.work_run = { run_id: row.run_id, bid_id: row.bid_id, status: row.status, created_at: row.created_at, updated_at: row.updated_at, result: stored };
    }
  }
  const wr = upper(result.work_run?.status);
  if (wr === "SUBMISSION_READY") add("WORK_EXECUTED", "VERIFIED", "local_work_run", { work_run_status: wr });
  else if (wr === "WORK_QA_PASSED" || wr === "WORK_IN_PROGRESS") add("WORK_EXECUTED", "IN_PROGRESS", "local_work_run", { work_run_status: wr });
  else if (result.bid.accepted) add("WORK_READY", "READY", "accepted_bid");
  const subs = await listSubmissions(env);
  if (subs.ok) {
    const matches = submissionForJob(firstRows(subs.body), id);
    const latest = matches.length ? matches[matches.length - 1] : null;
    result.submission = latest ? { id: latest?.id ?? null, status: latest?.status ?? null, updated_at: latest?.updatedAt ?? latest?.updated_at ?? null, amount: latest?.amount ?? null } : null;
    const ss = upper(latest?.status);
    if (latest) {
      const submissionStage = ["APPROVED", "ACCEPTED", "COMPLETED", "REVIEWED"].includes(ss) ? "SUBMISSION_SENT" : ["REJECTED", "DECLINED", "FAILED"].includes(ss) ? "SUBMISSION_SENT" : "SUBMISSION_SENT";
      add(submissionStage, ss === "APPROVED" || ss === "ACCEPTED" || ss === "COMPLETED" || ss === "REVIEWED" ? "VERIFIED" : "FOUND", "thebotclub_api_v2", { submission_id: latest?.id ?? null, status: latest?.status ?? null });
    } else if (wr === "SUBMISSION_READY") add("SUBMISSION_PENDING_APPROVAL", "READY", "local_work_run");
  } else add("SUBMISSION_PENDING_APPROVAL", "UNVERIFIED", "thebotclub_api_v2", { code: subs.code || null });
  const wallet = await getWallet(env);
  result.wallet_read_ok = wallet.ok;
  const rows = subs.ok ? submissionForJob(firstRows(subs.body), id) : [];
  const paymentSignals = rows.map((x) => ({ payment_status: x?.paymentStatus ?? x?.payment_status ?? null, payment_received_at: x?.paymentReceivedAt ?? x?.payment_received_at ?? null }));
  const received = paymentSignals.some((x) => upper(x.payment_status) === "RECEIVED" || x.payment_received_at != null);
  result.payment = { payment_received: received, evidence: paymentSignals, wallet: wallet.ok ? wallet.body : null, verified: Boolean(subs.ok) };
  add(received ? "PAYMENT_RECEIVED" : "PAYMENT_EVIDENCE_PENDING", received ? "VERIFIED" : "PENDING", "thebotclub_api_v2", { explicit_evidence: received });
  if (received) result.stage = "PAYMENT_RECEIVED";
  else if (result.submission) result.stage = "SUBMISSION_SENT";
  else if (wr === "SUBMISSION_READY") result.stage = "SUBMISSION_PENDING_APPROVAL";
  else if (result.bid.accepted) result.stage = wr ? "WORK_EXECUTED" : "WORK_READY";
  else result.stage = "BID_PENDING";
  const integrity = [];
  const bidId = s2(result.bid?.id);
  const subJobId = s2(result.submission?.job_id ?? result.submission?.jobId);
  if (result.submission && subJobId && subJobId !== id) integrity.push({ code: "SUBMISSION_JOB_MISMATCH", severity: "ERROR" });
  if (result.work_run?.bid_id && bidId && s2(result.work_run.bid_id) !== bidId) integrity.push({ code: "WORK_BID_MISMATCH", severity: "ERROR" });
  if (received && !result.submission) integrity.push({ code: "PAYMENT_WITHOUT_SUBMISSION_RECORD", severity: "ERROR" });
  if (received && result.submission) {
    const ss = upper(result.submission.status);
    if (["REJECTED", "DECLINED", "FAILED"].includes(ss)) integrity.push({ code: "PAYMENT_SIGNAL_WITH_REJECTED_SUBMISSION", severity: "ERROR" });
  }
  result.integrity = { ok: integrity.length === 0, issues: integrity };
  if (integrity.some((x) => x.severity === "ERROR")) {
    result.stage = "INCONSISTENT_EVIDENCE";
    result.payment.payment_received = false;
    result.payment.explicit_evidence = false;
  }
  return result;
}

// worker.js
var VERSION = "5.8.1";
var SKILLS = {
  research: /research|بحث|دراسة|find|investigate|مصادر|sources/i,
  writing: /write|writing|article|content|copy|اكتب|مقال|محتوى|صياغ/i,
  translation: /translate|translation|ترجم|ترجمة/i,
  coding: /code|coding|python|javascript|api|debug|برمج|كود|تطوير|تصحيح/i,
  data: /data|dataset|csv|excel|spreadsheet|بيانات|جدول|إكسل/i,
  analysis: /analy[sz]e|analysis|compare|تحليل|قارن|مقارنة/i,
  design: /design|logo|image|graphic|تصميم|شعار|صورة/i,
  support: /support|customer|ticket|عميل|دعم/i,
  automation: /automate|automation|workflow|أتمتة|سير عمل/i,
  web: /website|web page|url|site|موقع|صفحة|رابط/i
};
var RISKS = {
  financial_transaction: /pay|payment|transfer|withdraw|deposit|شراء|دفع|تحويل|سحب|إيداع/i,
  credential_access: /password|api key|token|login|credential|كلمة مرور|مفتاح|تسجيل دخول/i,
  identity_impersonation: /impersonat|fake identity|انتحال|هوية مزيفة/i,
  platform_bypass: /bypass|circumvent|evade|تجاوز|تحايل/i,
  spam_outreach: /spam|bulk message|mass email|رسائل جماعية|إرسال جماعي/i
};
function assess(task) {
  if (!task || task.length > 4e3) throw new Error("\u0627\u0644\u0645\u0647\u0645\u0629 \u0641\u0627\u0631\u063A\u0629 \u0623\u0648 \u062A\u062A\u062C\u0627\u0648\u0632 4000 \u062D\u0631\u0641");
  let skills = Object.entries(SKILLS).filter(([, r]) => r.test(task)).map(([k]) => k);
  if (!skills.length) skills = ["general_reasoning"];
  const risks = Object.entries(RISKS).filter(([, r]) => r.test(task)).map(([k]) => k);
  const missing = [];
  if (skills.includes("design")) missing.push("visual_tool");
  if (skills.includes("automation")) missing.push("approved_api_credentials");
  if (skills.includes("web")) missing.push("web_access");
  const mutation = ["financial_transaction", "credential_access", "identity_impersonation", "platform_bypass", "spam_outreach"].some((x) => risks.includes(x));
  const complexity = task.split(/\s+/).length <= 25 && skills.length <= 2 ? "LOW" : task.split(/\s+/).length <= 100 && skills.length <= 4 ? "MEDIUM" : "HIGH";
  let decision = "READY_FOR_EXECUTION_PLAN";
  if (risks.includes("platform_bypass") || risks.includes("identity_impersonation")) decision = "REJECT";
  else if (mutation || missing.length) decision = "REVIEW";
  return { decision, skills, risk_flags: risks, missing_tools_or_access: missing, complexity, estimated_minutes: { LOW: 10, MEDIUM: 30, HIGH: 90 }[complexity], execution_enabled: false };
}
function plan(task, a) {
  const blockers = [];
  if (a.missing_tools_or_access?.length) blockers.push("required_tools_or_access_missing");
  if (a.risk_flags?.length) blockers.push("risk_review_required");
  if (a.decision !== "READY_FOR_EXECUTION_PLAN") blockers.push("preflight_not_ready");
  return { plan_version: "1.1", mode: "planning_only", execution_enabled: false, task, assessment: a, steps: [
    { id: 1, name: "requirements", status: "pending" },
    { id: 2, name: "source_verification", status: "pending" },
    { id: 3, name: "work_product", status: "pending" },
    { id: 4, name: "quality_assurance", status: "pending" },
    { id: 5, name: "external_delivery", status: "blocked" }
  ], blockers: [...new Set(blockers)], external_actions: { bid: false, claim: false, submit: false, payment: false, withdrawal: false, credential_submission: false } };
}
function now5() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function taskId() {
  return crypto.randomUUID();
}
async function dbStatus(env) {
  if (!env.DB) return { configured: false, mode: "not_configured" };
  try {
    await env.DB.prepare("SELECT 1").run();
    return { configured: true, mode: "d1" };
  } catch (e) {
    return { configured: true, mode: "error", error: String(e) };
  }
}
async function setAgentState(env, status, currentTaskId = null) {
  if (!env.DB) return false;
  const t = now5();
  await env.DB.prepare("INSERT INTO agent_state(id,status,current_task_id,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,current_task_id=excluded.current_task_id,updated_at=excluded.updated_at").bind(status, currentTaskId, t).run();
  return true;
}
async function audit(env, event, tid = null, details = {}) {
  if (!env.DB) return false;
  await env.DB.prepare("INSERT INTO audit_log(event,task_id,details,created_at) VALUES(?,?,?,?)").bind(event, tid, JSON.stringify(details), now5()).run();
  return true;
}
async function saveTask(env, row) {
  if (!env.DB) return false;
  await env.DB.prepare("INSERT INTO tasks(id,task,status,decision,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(row.id, row.task, row.status, row.decision || null, row.result ? JSON.stringify(row.result) : null, row.created_at, row.updated_at).run();
  return true;
}
async function createApproval(env, row) {
  if (!env.DB) return { ok: false, code: "DB_NOT_CONFIGURED" };
  await env.DB.prepare("INSERT INTO approvals(id,task_id,action,status,summary,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(row.id, row.task_id, row.action, "PENDING", JSON.stringify(row.summary || {}), row.expires_at, now5(), now5()).run();
  return { ok: true, id: row.id, status: "PENDING", expires_at: row.expires_at };
}
async function getApproval(env, id) {
  if (!env.DB) return null;
  return await env.DB.prepare("SELECT * FROM approvals WHERE id=?").bind(id).first();
}
function approvalSummary(d) {
  return { task_id: String(d.task_id || ""), action: String(d.action || "EXTERNAL_MUTATION"), opportunity_id: d.opportunity_id || null, revenue: d.revenue ?? null, costs: d.costs ?? null, expected_net_profit: d.expected_net_profit ?? null, risk_flags: Array.isArray(d.risk_flags) ? d.risk_flags : [], target: d.target || null };
}
function safeEq(a, b) {
  a = String(a);
  b = String(b);
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return d === 0;
}
function suppliedOwnerToken(req) {
  const h = req.headers.get("x-owner-approval-token");
  if (h) return h;
  const a = req.headers.get("authorization") || "";
  return /^Bearer /i.test(a) ? a.slice(7).trim() : "";
}
function ownerTokenValid(req, env) {
  const expected = env?.OWNER_APPROVAL_TOKEN;
  const supplied = suppliedOwnerToken(req);
  return Boolean(expected && supplied && safeEq(supplied, expected));
}
function isPublicApi(req, u) {
  const m = req.method, p = u.pathname;
  return m === "GET" && (p === "/api/status" || p === "/api/phone/readiness") || m === "POST" && p === "/api/phone/smoke";
}
function ownerGate(req, env, u) {
  if (!u.pathname.startsWith("/api/") || isPublicApi(req, u)) return null;
  if (!env?.OWNER_APPROVAL_TOKEN) return Response.json({ ok: false, code: "OWNER_APPROVAL_TOKEN_NOT_CONFIGURED", message: "Set the OWNER_APPROVAL_TOKEN secret before using protected routes." }, { status: 503 });
  if (!ownerTokenValid(req, env)) return Response.json({ ok: false, code: "OWNER_APPROVAL_TOKEN_REQUIRED" }, { status: 401 });
  return null;
}
async function approveGate(env, id) {
  const row = await getApproval(env, id);
  if (!row) return { ok: false, code: "APPROVAL_NOT_FOUND" };
  if (row.status !== "PENDING") return { ok: false, code: "APPROVAL_NOT_PENDING", status: row.status };
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare("UPDATE approvals SET status=?,updated_at=? WHERE id=?").bind("EXPIRED", now5(), id).run();
    return { ok: false, code: "APPROVAL_EXPIRED" };
  }
  await env.DB.prepare("UPDATE approvals SET status=?,updated_at=? WHERE id=?").bind("APPROVED", now5(), id).run();
  await audit(env, "OWNER_APPROVAL_GRANTED", row.task_id, { approval_id: id, action: row.action });
  return { ok: true, id, status: "APPROVED", task_id: row.task_id, action: row.action };
}
async function updateTask(env, id, status, result = null) {
  if (!env.DB) return false;
  await env.DB.prepare("UPDATE tasks SET status=?,result=?,updated_at=? WHERE id=?").bind(status, result ? JSON.stringify(result) : null, now5(), id).run();
  return true;
}
async function getControl(env) {
  if (!env.DB) return { persistent: false, status: "UNKNOWN", current_task_id: null, updated_at: null };
  const r = await env.DB.prepare("SELECT status,current_task_id,updated_at FROM agent_state WHERE id=1").first();
  return { persistent: true, status: r?.status || "IDLE", current_task_id: r?.current_task_id || null, updated_at: r?.updated_at || null };
}
async function browserRead(url, env) {
  if (!env.BROWSER) return { ok: false, code: "BROWSER_NOT_CONFIGURED", message: "Browser Run binding \u063A\u064A\u0631 \u0645\u0636\u0628\u0648\u0637." };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, code: "INVALID_URL" };
  }
  if (!["https:", "http:"].includes(u.protocol)) return { ok: false, code: "URL_SCHEME_BLOCKED" };
  try {
    const result = await env.BROWSER.quickAction("markdown", { url: u.toString() });
    const text2 = typeof result?.text === "string" ? result.text : String(result ?? "");
    return { ok: true, mode: "READ_ONLY", url: u.toString(), text: text2.slice(0, 5e4) };
  } catch (e) {
    return { ok: false, code: "BROWSER_READ_FAILED", error: String(e) };
  }
}
function executionAdapter(task, assessment) {
  const base = { adapter_version: "1.0", external_execution_enabled: false, owner_approval_required: true, idempotency_required: true };
  if (assessment.decision !== "READY_FOR_EXECUTION_PLAN") return { ...base, status: "BLOCKED", reason: "preflight_not_ready" };
  if (assessment.risk_flags?.length) return { ...base, status: "BLOCKED", reason: "risk_review_required" };
  if (assessment.missing_tools_or_access?.length) return { ...base, status: "BLOCKED", reason: "required_access_missing" };
  if (assessment.skills?.includes("web")) return { ...base, status: "READY", route: "BROWSER_OR_HTTP_READ_ONLY" };
  return { ...base, status: "READY", route: "FREE_LLM_WORK_PRODUCT" };
}
function idempotencyKey(task) {
  return crypto.randomUUID();
}
async function executionPreflight(task, env) {
  const assessment = assess(task);
  const adapter = executionAdapter(task, assessment);
  return { ok: adapter.status === "READY", assessment, adapter, idempotency_key: idempotencyKey(task), external_mutation: false };
}
function chooseTool(assessment) {
  if (assessment.risk_flags?.length) return { tool: "OWNER_REVIEW", reason: "risk_flags" };
  if (assessment.missing_tools_or_access?.length) return { tool: "MISSING_ACCESS", reason: "required_access_missing" };
  if (assessment.skills?.includes("web")) return { tool: "BROWSER_OR_HTTP", reason: "web_task" };
  if (assessment.skills?.includes("research") || assessment.skills?.includes("analysis")) return { tool: "FREE_LLM_RESEARCH", reason: "research_or_analysis" };
  return { tool: "FREE_LLM_GENERAL", reason: "general_task" };
}
function qualityGate(task, result) {
  const issues = [];
  if (!result || result.ok !== true) issues.push("work_result_not_available");
  if (result?.text && result.text.length < 20) issues.push("result_too_short_for_confident_delivery");
  return { passed: issues.length === 0, issues, rule: "minimum_result_integrity" };
}
async function autonomousRun(task, env) {
  const assessment = assess(task);
  if (assessment.decision === "REJECT") return { ok: false, status: "REJECTED", assessment, tool: { tool: "NONE", reason: "rejected" } };
  const selected = chooseTool(assessment);
  if (selected.tool === "OWNER_REVIEW" || selected.tool === "MISSING_ACCESS") return { ok: true, status: "REVIEW_REQUIRED", assessment, tool: selected, external_actions: { submit: false, payment: false, withdrawal: false } };
  const result = await runFreeAI(task, env);
  const qa = qualityGate(task, result);
  const status = result.ok && qa.passed ? "READY_FOR_DELIVERY" : "WAITING";
  return { ok: result.ok && qa.passed, status, assessment, tool: selected, result, quality_gate: qa, external_actions: { bid: false, claim: false, stake: false, submit: false, payment: false, withdrawal: false, credential_submission: false, account_change: false, external_message: false } };
}
var html = `<!doctype html><html lang="ar" dir="rtl"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0f172a"><title>Agent Economy v5.8.1</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:auto;padding:14px;background:#f1f5f9;color:#0f172a}h1{font-size:22px;margin:4px 0}.card{background:#fff;padding:14px;border-radius:16px;margin:10px 0;box-shadow:0 1px 4px #0001}label{display:block;font-size:13px;color:#475569;margin-top:9px}input,textarea,button{width:100%;box-sizing:border-box;font:inherit}input,textarea{margin-top:5px;padding:11px;border:1px solid #cbd5e1;border-radius:11px;background:#fff}textarea{min-height:90px}button{margin-top:9px;padding:12px;border:0;border-radius:11px;background:#0f172a;color:#fff;font-weight:700}.secondary{background:#475569}.approve{background:#166534}.danger{background:#991b1b}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.metric{padding:10px;border:1px solid #e2e8f0;border-radius:11px}.muted{color:#64748b;font-size:13px}.ok{color:#166534}.warn{color:#92400e}.bad{color:#991b1b}pre{white-space:pre-wrap;overflow:auto;font-size:12px}</style><h1>\u{1F916} Agent Economy</h1><div class="card"><b>v5.8.1 \u2014 \u0644\u0648\u062D\u0629 \u062A\u062D\u0643\u0645 \u0627\u0644\u0647\u0627\u062A\u0641</b><div id=s class="muted">\u0641\u062D\u0635 \u0627\u0644\u062D\u0627\u0644\u0629...</div></div><div class="card"><b>\u0627\u062E\u062A\u0628\u0627\u0631 \u0627\u0644\u0647\u0627\u062A\u0641 \u0627\u0644\u0622\u0645\u0646</b><div class="muted">\u064A\u0641\u062D\u0635 Worker \u0648\u0627\u0644\u0640API \u0648\u0627\u0644\u0640free router \u0641\u0642\u0637. \u0644\u0627 \u064A\u0646\u0641\u0630 AI \u0648\u0644\u0627 Bid \u0648\u0644\u0627 Submission.</div><button class="secondary" onclick=phoneSmoke()>\u062A\u0634\u063A\u064A\u0644 \u0627\u062E\u062A\u0628\u0627\u0631 \u0627\u0644\u0647\u0627\u062A\u0641</button><div id=phoneSmokeOut></div></div><div class="card"><b>\u0623\u0648\u0644 Bid \u062D\u0642\u064A\u0642\u064A</b><label>Job ID</label><input id=job placeholder="\u0645\u0639\u0631\u0651\u0641 \u0627\u0644\u0648\u0638\u064A\u0641\u0629"><label>\u0645\u0628\u0644\u063A \u0627\u0644\u0640Bid</label><input id=amt type=number step="0.01" placeholder="\u0645\u062B\u0627\u0644: 120"><label>\u0627\u0644\u0633\u0627\u0639\u0627\u062A \u0627\u0644\u0645\u062A\u0648\u0642\u0639\u0629</label><input id=hrs type=number step="0.1" placeholder="\u0645\u062B\u0627\u0644: 4"><label>\u0631\u0633\u0627\u0644\u0629 \u0627\u0644\u0640Bid</label><textarea id=msg placeholder="\u0631\u0633\u0627\u0644\u0629 \u0645\u062E\u062A\u0635\u0631\u0629 \u0644\u0644\u0639\u0645\u064A\u0644"></textarea><button onclick=prepare()>\u0625\u0638\u0647\u0627\u0631 \u0628\u0637\u0627\u0642\u0629 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629</button></div><div id=review class="card" style="display:none"><b>\u0628\u0637\u0627\u0642\u0629 \u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0645\u0627\u0644\u0643</b><div id=card></div><button class="approve" onclick=requestBidApproval()>\u0637\u0644\u0628 \u0645\u0648\u0627\u0641\u0642\u0629 PLACE_BID</button><button class="secondary" onclick=approveBid()>\u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0645\u0627\u0644\u0643 \u062B\u0645 \u0627\u0644\u0625\u0631\u0633\u0627\u0644</button></div><div class="card"><b>\u062A\u0646\u0641\u064A\u0630 \u0627\u0644\u0648\u0638\u064A\u0641\u0629 \u0627\u0644\u0645\u0642\u0628\u0648\u0644\u0629</b><div class="muted">\u064A\u0628\u062F\u0623 \u0627\u0644\u062A\u0646\u0641\u064A\u0630 \u0627\u0644\u062F\u0627\u062E\u0644\u064A \u0641\u0642\u0637 \u0628\u0639\u062F \u0627\u0644\u062A\u062D\u0642\u0642 \u0645\u0646 ACCEPTED. \u0644\u0627 \u064A\u062A\u0645 \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0639\u0645\u0644 \u062E\u0627\u0631\u062C\u064A\u064B\u0627.</div><label>Job ID \u0627\u0644\u0645\u0642\u0628\u0648\u0644</label><input id=acceptedJob placeholder="\u0645\u0639\u0631\u0651\u0641 \u0627\u0644\u0648\u0638\u064A\u0641\u0629 \u0627\u0644\u0645\u0642\u0628\u0648\u0644\u0629"><button class="secondary" onclick=prepareAccepted()>\u0641\u062D\u0635 \u0648\u062A\u062C\u0647\u064A\u0632 \u0627\u0644\u0648\u0638\u064A\u0641\u0629</button><button onclick=executeAccepted()>\u062A\u0646\u0641\u064A\u0630 \u0627\u0644\u0639\u0645\u0644 \u0639\u0628\u0631 \u0627\u0644\u0645\u0632\u0648\u062F \u0627\u0644\u0645\u062C\u0627\u0646\u064A</button><button class=approve onclick=requestSubmissionApproval()>\u0625\u0646\u0634\u0627\u0621 \u0628\u0637\u0627\u0642\u0629 \u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0625\u0631\u0633\u0627\u0644</button><div id=submissionOut></div><div id=acceptedOut></div></div><div class="card"><b>\u0627\u0644\u062F\u0648\u0631\u0629 \u0627\u0644\u062D\u0642\u064A\u0642\u064A\u0629: Job \u2192 Bid \u2192 Work \u2192 Submission \u2192 Payment</b><div class="muted">\u0642\u0631\u0627\u0621\u0629 \u0641\u0642\u0637 \u2014 \u0644\u0627 \u062A\u0646\u0641\u0630 \u0623\u064A \u0625\u062C\u0631\u0627\u0621 \u062E\u0627\u0631\u062C\u064A.</div><label>Job ID</label><input id=cycleJob placeholder="\u0645\u0639\u0631\u0651\u0641 \u0627\u0644\u0648\u0638\u064A\u0641\u0629"><button class="secondary" onclick=monitorCycle()>\u062A\u062D\u062F\u064A\u062B \u0627\u0644\u062F\u0648\u0631\u0629</button><div id=cycleOut></div></div><div class="card"><b>\u0645\u0631\u0627\u0642\u0628\u0629 \u0627\u0644\u0640Bids</b><div class="muted">\u0642\u0631\u0627\u0621\u0629 \u0641\u0642\u0637 \u2014 \u0644\u0627 \u062A\u0631\u0633\u0644 \u0623\u064A \u0634\u064A\u0621.</div><button class="secondary" onclick=monitorBids()>\u062A\u062D\u062F\u064A\u062B \u062D\u0627\u0644\u0629 \u0627\u0644\u0640Bids</button><div id=monitor></div></div><div class="card"><b>\u0627\u0633\u062A\u0631\u062F\u0627\u062F \u062A\u0646\u0641\u064A\u0630 \u0627\u0644\u0639\u0645\u0644 \u0628\u0639\u062F \u0627\u0644\u0627\u0646\u0642\u0637\u0627\u0639</b><div class="muted">\u064A\u0641\u062D\u0635 \u0641\u0642\u0637. \u0644\u0627 \u064A\u0639\u064A\u062F \u062A\u0634\u063A\u064A\u0644 \u0627\u0644\u0630\u0643\u0627\u0621 \u0627\u0644\u0627\u0635\u0637\u0646\u0627\u0639\u064A \u062A\u0644\u0642\u0627\u0626\u064A\u064B\u0627 \u0639\u0646\u062F \u0648\u062C\u0648\u062F \u062A\u0646\u0641\u064A\u0630 \u0642\u062F \u064A\u0643\u0648\u0646 \u0627\u0646\u0642\u0637\u0639.</div><label>Job ID</label><input id=recoveryJob placeholder="\u0645\u0639\u0631\u0651\u0641 \u0627\u0644\u0648\u0638\u064A\u0641\u0629"><button class="secondary" onclick=checkRecovery()>\u0641\u062D\u0635 \u062D\u0627\u0644\u0629 \u0627\u0644\u0627\u0633\u062A\u0631\u062F\u0627\u062F</button><div id=recoveryOut></div></div><div class="card"><b>\u0627\u0644\u0646\u062A\u064A\u062C\u0629</b><pre id=o>\u062C\u0627\u0647\u0632.</pre></div><script>
(function(){const f=window.fetch.bind(window);window.fetch=async function(u,o){o=o||{};const mine=String(u).charAt(0)==='/';const run=function(){const h=new Headers(o.headers||{});let t='';try{t=localStorage.getItem('owner_token')||''}catch(e){}if(mine&&t&&!h.has('x-owner-approval-token'))h.set('x-owner-approval-token',t);return f(u,Object.assign({},o,{headers:h}))};let r=await run();if(mine&&r.status===401){const t=prompt('\u0623\u062F\u062E\u0644 \u0631\u0645\u0632 \u0627\u0644\u0645\u0627\u0644\u0643 (OWNER_APPROVAL_TOKEN)');if(t){try{localStorage.setItem('owner_token',t.trim())}catch(e){}r=await run()}}return r}})();
async function get(u,o){let r=await fetch(u,o);return r.json()}async function status(){try{let x=await get('/api/status');s.innerHTML='\u0627\u0644\u0625\u0635\u062F\u0627\u0631 '+x.version+' \u2022 \u0645\u062C\u0627\u0646\u064A \u0641\u0642\u0637: '+(x.free_only?'\u0646\u0639\u0645':'\u0644\u0627')+' \u2022 \u0627\u0644\u062A\u0646\u0641\u064A\u0630 \u0627\u0644\u062E\u0627\u0631\u062C\u064A: '+(x.execution_enabled?'\u0645\u0641\u062A\u0648\u062D':'\u0645\u0642\u0641\u0648\u0644')}catch(e){s.textContent='\u062A\u0639\u0630\u0631 \u0627\u0644\u0627\u062A\u0635\u0627\u0644'}}status();
let current=null,submissionCurrent=null;
async function phoneSmoke(){phoneSmokeOut.textContent='\u0641\u062D\u0635...';try{const r=await get('/api/phone/smoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:'\u0627\u062E\u062A\u0628\u0627\u0631 \u0622\u0645\u0646 \u0644\u0627\u062A\u0635\u0627\u0644 \u0648\u0643\u064A\u0644 \u0627\u0644\u0647\u0627\u062A\u0641'})});phoneSmokeOut.innerHTML='<pre>'+esc(JSON.stringify(r,null,2))+'</pre>';}catch(e){phoneSmokeOut.textContent='\u062A\u0639\u0630\u0631 \u0627\u0644\u0627\u062A\u0635\u0627\u0644: '+e}}
async function prepare(){const jobId=job.value.trim(),amount=Number(amt.value),hours=Number(hrs.value)||null;if(!jobId||!(amount>0)){o.textContent='\u0623\u062F\u062E\u0644 Job ID \u0648\u0645\u0628\u0644\u063A\u064B\u0627 \u0635\u062D\u064A\u062D\u064B\u0627.';return}o.textContent='\u0642\u0631\u0627\u0621\u0629 \u0627\u0644\u0648\u0638\u064A\u0641\u0629...';try{const r=await get('/api/real-work/jobs?status=OPEN&limit=20');const rows=Array.isArray(r.body?.data)?r.body.data:[];const j=rows.find(x=>String(x.id)===jobId);if(!j){o.textContent='\u0627\u0644\u0648\u0638\u064A\u0641\u0629 \u063A\u064A\u0631 \u0645\u0648\u062C\u0648\u062F\u0629 \u0636\u0645\u0646 \u0627\u0644\u0646\u062A\u0627\u0626\u062C \u0627\u0644\u062D\u0627\u0644\u064A\u0629\u061B \u0644\u0645 \u064A\u062A\u0645 \u0625\u0646\u0634\u0627\u0621 \u0645\u0648\u0627\u0641\u0642\u0629.';return}const revenue=Number(j.budget)||amount;current={job_id:jobId,amount,message:msg.value,estimated_hours:hours,revenue,known_costs:[],unknown_costs:['\u0631\u0633\u0648\u0645 \u0627\u0644\u0645\u0646\u0635\u0629/\u0627\u0644\u062F\u0641\u0639 \u063A\u064A\u0631 \u0645\u062B\u0628\u062A\u0629 \u0625\u0646 \u0644\u0645 \u064A\u0648\u0641\u0631\u0647\u0627 \u0627\u0644\u0645\u0635\u062F\u0631'],risk_flags:[] ,title:j.title,description:j.description};render();}catch(e){o.textContent='\u062E\u0637\u0623 \u0641\u064A \u0627\u0644\u0642\u0631\u0627\u0621\u0629: '+e}}
function render(){review.style.display='block';card.innerHTML='<div class="metric"><b>'+esc(current.title||'\u0648\u0638\u064A\u0641\u0629')+'</b><div class="muted">Job: '+esc(current.job_id)+'</div></div><div class="grid"><div class="metric">\u0627\u0644\u0625\u064A\u0631\u0627\u062F<br><b>'+current.revenue+'</b></div><div class="metric">Bid<br><b>'+current.amount+'</b></div><div class="metric">\u0627\u0644\u062A\u0643\u0627\u0644\u064A\u0641 \u0627\u0644\u0645\u0639\u0631\u0648\u0641\u0629<br><b>0</b></div><div class="metric">\u0635\u0627\u0641\u064A \u0645\u0639\u0631\u0648\u0641<br><b>'+current.revenue+'</b></div></div><p class="warn">\u26A0 \u0627\u0644\u062A\u0643\u0627\u0644\u064A\u0641 \u063A\u064A\u0631 \u0627\u0644\u0645\u0639\u0631\u0648\u0641\u0629: '+current.unknown_costs.join('\u060C ')+'</p><p class="muted">\u0644\u0627 \u064A\u0648\u062C\u062F \u0625\u0631\u0633\u0627\u0644 \u062E\u0627\u0631\u062C\u064A \u062D\u062A\u0649 \u062A\u062A\u0645 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629.</p>'}
async function requestBidApproval(){if(!current)return;o.textContent='\u0625\u0646\u0634\u0627\u0621 \u0637\u0644\u0628 \u0645\u0648\u0627\u0641\u0642\u0629...';const r=await get('/api/real-work/bid-approval-card',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(current)});if(r.id)current.approval_id=r.id;o.textContent=JSON.stringify(r,null,2)}
async function approveBid(){if(!current?.approval_id){o.textContent='\u0623\u0646\u0634\u0626 \u0637\u0644\u0628 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0623\u0648\u0644\u064B\u0627.';return}const token=prompt('\u0631\u0645\u0632 \u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0645\u0627\u0644\u0643');if(!token)return;o.textContent='\u062A\u0623\u0643\u064A\u062F \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629...';const a=await get('/api/approval/approve',{method:'POST',headers:{'content-type':'application/json','x-owner-approval-token':token},body:JSON.stringify({approval_id:current.approval_id})});if(!a.ok){o.textContent=JSON.stringify(a,null,2);return}o.textContent='\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u062A\u0645\u062A. \u0625\u0631\u0633\u0627\u0644 Bid \u0645\u0631\u0629 \u0648\u0627\u062D\u062F\u0629...';const b=await get('/api/real-work/place-bid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({approvalId:current.approval_id,jobId:current.job_id,amount:current.amount,message:current.message,estimatedHours:current.estimated_hours})});o.textContent=JSON.stringify({approval:a,bid:b},null,2)}
async function requestSubmissionApproval(){submissionOut.textContent='\u0641\u062D\u0635 \u0648\u062A\u062C\u0647\u064A\u0632 \u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0625\u0631\u0633\u0627\u0644...';try{const id=acceptedJob.value.trim();if(!id){submissionOut.textContent='\u0623\u062F\u062E\u0644 Job ID \u0627\u0644\u0645\u0642\u0628\u0648\u0644.';return}const prep=await get('/api/real-work/accepted-job/prepare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:id})});if(!prep.ok){submissionOut.textContent=JSON.stringify(prep,null,2);return}const exec=await get('/api/real-work/accepted-job/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:id})});if(!exec.ok||!exec.execution?.work_product){submissionOut.textContent=JSON.stringify(exec,null,2);return}const r=await get('/api/real-work/submission-approval-card',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:id,content:exec.execution.work_product,fileUrls:[]})});if(r.id){submissionCurrent={approval_id:r.id,job_id:id,bid_id:r.card?.bid_id||'',content:exec.execution.work_product,fileUrls:[]};submissionOut.innerHTML='<pre>'+esc(JSON.stringify(r,null,2))+'</pre><button class=approve onclick=approveAndSubmit()>\u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0645\u0627\u0644\u0643 \u062B\u0645 \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0639\u0645\u0644</button>';}else{submissionOut.innerHTML='<pre>'+esc(JSON.stringify(r,null,2))+'</pre>'}}catch(e){submissionOut.textContent='\u062E\u0637\u0623: '+e}}
async function approveAndSubmit(){if(!submissionCurrent?.approval_id){submissionOut.textContent='\u0623\u0646\u0634\u0626 \u0637\u0644\u0628 \u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0625\u0631\u0633\u0627\u0644 \u0623\u0648\u0644\u064B\u0627.';return}const token=prompt('\u0631\u0645\u0632 \u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0645\u0627\u0644\u0643');if(!token)return;submissionOut.textContent='\u062A\u0623\u0643\u064A\u062F \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u062B\u0645 \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0639\u0645\u0644 \u0645\u0631\u0629 \u0648\u0627\u062D\u062F\u0629...';const a=await get('/api/approval/approve',{method:'POST',headers:{'content-type':'application/json','x-owner-approval-token':token},body:JSON.stringify({approval_id:submissionCurrent.approval_id})});if(!a.ok){submissionOut.textContent=JSON.stringify(a,null,2);return}const b=await get('/api/real-work/submission/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(submissionCurrent)});submissionOut.innerHTML='<pre>'+esc(JSON.stringify({approval:a,submission:b},null,2))+'</pre>'}
async function checkRecovery(){recoveryOut.textContent='\u0641\u062D\u0635...';try{const id=recoveryJob.value.trim();if(!id){recoveryOut.textContent='\u0623\u062F\u062E\u0644 Job ID.';return}const r=await get('/api/real-work/work-run/recover',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:id})});recoveryOut.innerHTML='<pre>'+esc(JSON.stringify(r,null,2))+'</pre>';}catch(e){recoveryOut.textContent='\u062E\u0637\u0623: '+e}}
async function prepareAccepted(){acceptedOut.textContent='\u0641\u062D\u0635...';try{const id=acceptedJob.value.trim();const r=await get('/api/real-work/accepted-job/prepare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:id})});acceptedOut.innerHTML='<pre>'+esc(JSON.stringify(r,null,2))+'</pre>';}catch(e){acceptedOut.textContent='\u062E\u0637\u0623: '+e}}
async function executeAccepted(){acceptedOut.textContent='\u062A\u0646\u0641\u064A\u0630...';try{const id=acceptedJob.value.trim();const r=await get('/api/real-work/accepted-job/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:id})});acceptedOut.innerHTML='<pre>'+esc(JSON.stringify(r,null,2))+'</pre>';}catch(e){acceptedOut.textContent='\u062E\u0637\u0623: '+e}}
async function monitorCycle(){cycleOut.textContent='\u0642\u0631\u0627\u0621\u0629 \u0627\u0644\u062F\u0648\u0631\u0629...';try{const id=cycleJob.value.trim();if(!id){cycleOut.textContent='\u0623\u062F\u062E\u0644 Job ID.';return}const r=await get('/api/real-work/cycle?job_id='+encodeURIComponent(id));if(!r.ok){cycleOut.innerHTML='<pre>'+esc(JSON.stringify(r,null,2))+'</pre>';return}const labels={JOB_FOUND:'\u0627\u0644\u0648\u0638\u064A\u0641\u0629',BID_PENDING:'\u0627\u0644\u0640Bid',BID_ACCEPTED:'\u0627\u0644\u0640Bid \u0645\u0642\u0628\u0648\u0644',WORK_READY:'\u0627\u0644\u0639\u0645\u0644 \u062C\u0627\u0647\u0632',WORK_EXECUTED:'\u0627\u0644\u0639\u0645\u0644 \u0646\u064F\u0641\u0651\u0630',SUBMISSION_PENDING_APPROVAL:'\u0628\u0627\u0646\u062A\u0638\u0627\u0631 \u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0625\u0631\u0633\u0627\u0644',SUBMISSION_SENT:'\u062A\u0645 \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0639\u0645\u0644',PAYMENT_EVIDENCE_PENDING:'\u0628\u0627\u0646\u062A\u0638\u0627\u0631 \u062F\u0644\u064A\u0644 \u0627\u0644\u062F\u0641\u0639',PAYMENT_RECEIVED:'\u062A\u0645 \u0625\u062B\u0628\u0627\u062A \u0627\u0644\u062F\u0641\u0639'};cycleOut.innerHTML='<div class=metric><b>\u0627\u0644\u0645\u0631\u062D\u0644\u0629 \u0627\u0644\u062D\u0627\u0644\u064A\u0629: '+esc(labels[r.stage]||r.stage)+'</b></div>'+r.stages.map(x=>'<div class=metric>'+esc(labels[x.stage]||x.stage)+' \u2014 '+esc(x.status)+'</div>').join('')+'<div class=muted>\u0642\u0631\u0627\u0621\u0629 \u0641\u0642\u0637: '+esc(String(r.read_only))+' | \u062A\u063A\u064A\u064A\u0631 \u062E\u0627\u0631\u062C\u064A: '+esc(String(r.external_mutation))+'</div>';}catch(e){cycleOut.textContent='\u062A\u0639\u0630\u0631 \u0642\u0631\u0627\u0621\u0629 \u0627\u0644\u062F\u0648\u0631\u0629: '+e}}
async function monitorBids(){monitor.textContent='\u0642\u0631\u0627\u0621\u0629 \u0627\u0644\u062D\u0627\u0644\u0627\u062A...';try{const r=await get('/api/real-work/monitor-bids');if(!r.ok){monitor.textContent=JSON.stringify(r,null,2);return}monitor.innerHTML=r.bids.length?r.bids.map(b=>'<div class=metric><b>'+esc(b.status)+'</b> \u2014 Job '+esc(b.job_id)+' \u2014 '+esc(b.next_action)+'</div>').join(''):'\u0644\u0627 \u062A\u0648\u062C\u062F Bids.';}catch(e){monitor.textContent='\u062A\u0639\u0630\u0631 \u0642\u0631\u0627\u0621\u0629 \u0627\u0644\u062D\u0627\u0644\u0627\u062A: '+e}}
function esc(x){return String(x??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
</script></html>`;
var worker_default = { async fetch(req, env) {
  const u = new URL(req.url);
  try {
    const gate = ownerGate(req, env, u);
    if (gate) return gate;
    if (req.method === "GET" && u.pathname === "/") return new Response(html, { headers: { "content-type": "text/html;charset=UTF-8" } });
    if (req.method === "POST" && u.pathname === "/api/markets/scan") {
      const d = await req.json().catch(() => ({}));
      const result = await scanMarkets(env, d);
      await audit(env, "MARKET_SCAN", null, { sources: result.summary.available_sources, job_count: result.summary.job_count, read_only: true });
      return Response.json(result);
    }
    if (req.method === "POST" && u.pathname === "/api/work-plan/opportunity") {
      const d = await req.json().catch(() => ({}));
      const opportunity = d.opportunity;
      if (!opportunity) return Response.json({ ok: false, error: "OPPORTUNITY_REQUIRED" }, { status: 400 });
      return Response.json(buildWorkPlan(opportunity, { now_ms: d.now_ms }));
    }
    if (req.method === "POST" && u.pathname === "/api/work-plan/opportunities") {
      const d = await req.json().catch(() => ({}));
      return Response.json({ ok: true, plans: buildPlans(d.opportunities, { now_ms: d.now_ms }), external_mutation: false, execution_enabled: false });
    }
    if (req.method === "POST" && u.pathname === "/api/opportunities/scan") {
      const d = await req.json().catch(() => ({}));
      const scan = await scanMarkets(env, d);
      const result = buildOpportunityPipeline(scan, { ...d.pipeline || {}, now_ms: d.now_ms });
      await audit(env, "OPPORTUNITY_PIPELINE", null, { job_count: result.summary.total, eligible: result.summary.eligible, review: result.summary.review, rejected: result.summary.rejected, read_only: true });
      return Response.json(result);
    }
    if (req.method === "GET" && u.pathname === "/api/tools/free-status") return Response.json(freeProviderStatus(env));
    if (req.method === "POST" && u.pathname === "/api/ai/free") {
      const d = await req.json().catch(() => ({}));
      const task = String(d.task || "").trim();
      if (!task) return Response.json({ ok: false, error: "TASK_REQUIRED" }, { status: 400 });
      return Response.json(await runFreeAI(task, env));
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/status") {
      return Response.json(await adapterStatus(env));
    }
    if (req.method === "POST" && u.pathname === "/api/real-work/first-live-cycle") {
      const d = await req.json().catch(() => ({}));
      return Response.json(await firstLiveBidCycle(env, d));
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/verify-read") {
      const d = Object.fromEntries(u.searchParams.entries());
      return Response.json(await liveReadVerification(env, d));
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/jobs") {
      const d = Object.fromEntries(u.searchParams.entries());
      return Response.json(await listJobs(env, d));
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/bids") {
      const d = Object.fromEntries(u.searchParams.entries());
      return Response.json(await listBids(env, d));
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/cycle") {
      const jobId = String(u.searchParams.get("job_id") || "").trim();
      const r = await realCycle(env, { jobId });
      await audit(env, r.ok ? "REAL_CYCLE_READ" : "REAL_CYCLE_READ_FAILED", jobId, { stage: r.stage || null, integrity_ok: r.integrity?.ok !== false, read_only: true, external_mutation: false });
      return Response.json(r, { status: r.ok ? 200 : 400 });
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/payment-evidence") {
      const jobId = String(u.searchParams.get("job_id") || "").trim();
      const r = await paymentEvidence(env, jobId);
      await audit(env, r.ok ? "PAYMENT_EVIDENCE_READ" : "PAYMENT_EVIDENCE_READ_FAILED", jobId, { payment_received: Boolean(r.payment_received), read_only: true });
      return Response.json(r, { status: r.ok ? 200 : 503 });
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/monitor-bids") {
      const d = Object.fromEntries(u.searchParams.entries());
      const r = await listBids(env, d);
      if (!r.ok) {
        await audit(env, "BID_MONITOR_FAILED", null, { status: r.status || null, code: r.code || null });
        return Response.json({ ...r, monitor: false }, { status: 503 });
      }
      const rows = Array.isArray(r.body?.data) ? r.body.data : Array.isArray(r.body?.bids) ? r.body.bids : [];
      const bids = rows.map((b) => {
        const status = String(b?.status || "UNKNOWN").toUpperCase();
        let next_action = "WAIT";
        if (status === "ACCEPTED") next_action = "WORK_EXECUTION_READY";
        else if (status === "REJECTED") next_action = "NO_ACTION_REJECTED";
        else if (status === "WITHDRAWN") next_action = "NO_ACTION_WITHDRAWN";
        return { id: b?.id || null, job_id: b?.jobId ?? b?.job_id ?? null, status, amount: b?.amount ?? null, created_at: b?.createdAt ?? b?.created_at ?? null, next_action };
      });
      const accepted = bids.filter((x) => x.status === "ACCEPTED");
      const pending = bids.filter((x) => x.status === "PENDING");
      await audit(env, "BID_MONITOR_READ", null, { count: bids.length, accepted: accepted.length, pending: pending.length, read_only: true });
      return Response.json({ ok: true, verified: true, live: true, read_only: true, bids, summary: { total: bids.length, accepted: accepted.length, pending: pending.length, actionable_accepted: accepted.length }, external_mutation: false });
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/bid-status") {
      const jobId = String(u.searchParams.get("job_id") || "").trim();
      const r = await getBidStatus(env, jobId);
      await audit(env, r.ok ? "BID_STATUS_READ" : "BID_STATUS_READ_FAILED", jobId, { status: r.status || null, accepted: Boolean(r.accepted) });
      return Response.json(r, { status: r.ok ? 200 : 503 });
    }
    if (req.method === "POST" && u.pathname === "/api/real-work/bid-preflight") {
      const d = await req.json().catch(() => ({}));
      return Response.json(buildBidPreflight(d));
    }
    if (req.method === "POST" && u.pathname === "/api/real-work/place-bid") {
      const d = await req.json().catch(() => ({}));
      const r = await placeBid(env, d);
      await audit(env, r.ok ? "BID_PLACED" : "BID_BLOCKED", String(d.jobId || ""), { approval_id: d.approvalId || null, status: r.status || null, code: r.code || null });
      return Response.json(r, { status: r.ok ? 200 : r.code === "OWNER_APPROVAL_REQUIRED" ? 409 : 502 });
    }
    if (req.method === "POST" && u.pathname === "/api/real-work/accepted-job/prepare") {
      const d = await req.json().catch(() => ({}));
      const r = await prepareAcceptedJob(env, d);
      await audit(env, r.ok ? "ACCEPTED_JOB_PREPARED" : "ACCEPTED_JOB_PREPARE_BLOCKED", String(d.jobId || ""), { code: r.code || null, stage: r.stage || null, external_mutation: false });
      return Response.json(r, { status: r.ok ? 200 : r.code === "BID_NOT_ACCEPTED" ? 409 : 503 });
    }
    if (req.method === "POST" && u.pathname === "/api/real-work/accepted-job/execute") {
      const d = await req.json().catch(() => ({}));
      const r = await executeAcceptedJob(env, d, { assess });
      await audit(env, r.ok ? "ACCEPTED_JOB_EXECUTED" : "ACCEPTED_JOB_EXECUTION_FAILED", String(d.jobId || ""), { code: r.code || null, stage: r.stage || null, proof_hash: r.execution?.proof_hash || null, external_mutation: false });
      return Response.json(r, { status: r.ok ? 200 : r.code === "BID_NOT_ACCEPTED" ? 409 : 503 });
    }
    if (req.method === "POST" && u.pathname === "/api/real-work/submission-approval-card") {
      const d = await req.json().catch(() => ({}));
      const jobId = String(d.jobId || d.job_id || "").trim();
      const content = String(d.content || "").trim();
      if (!jobId || !content) return Response.json({ ok: false, code: "INVALID_SUBMISSION_REVIEW" }, { status: 400 });
      const bs = await getBidStatus(env, jobId);
      if (!bs.ok) return Response.json({ ok: false, blocked: true, code: "BID_STATUS_UNAVAILABLE", bid_status: bs }, { status: 503 });
      if (!bs.accepted) return Response.json({ ok: false, blocked: true, code: "BID_NOT_ACCEPTED", job_id: jobId, bid_status: bs.status, external_mutation: false }, { status: 409 });
      const proofHash = await sha256Hex3(content);
      let workRun = null;
      if (env.DB) {
        workRun = await env.DB.prepare("SELECT * FROM work_runs WHERE run_id=?").bind(`JOBRUN:${jobId}`).first();
        if (!workRun) return Response.json({ ok: false, blocked: true, code: "WORK_RUN_NOT_FOUND", job_id: jobId, external_mutation: false }, { status: 409 });
        let stored = null;
        try {
          stored = workRun.result ? JSON.parse(workRun.result) : null;
        } catch {
        }
        const storedProduct = String(stored?.execution?.work_product || stored?.result?.work_product || stored?.work_product || "").trim();
        if (!storedProduct) return Response.json({ ok: false, blocked: true, code: "WORK_PRODUCT_NOT_PERSISTED", job_id: jobId, external_mutation: false }, { status: 409 });
        const storedHash = await sha256Hex3(storedProduct);
        if (storedHash !== proofHash) return Response.json({ ok: false, blocked: true, code: "WORK_PRODUCT_HASH_MISMATCH", job_id: jobId, expected_hash: storedHash, provided_hash: proofHash, external_mutation: false }, { status: 409 });
        if (!["SUBMISSION_READY", "WORK_QA_PASSED"].includes(workRun.status)) return Response.json({ ok: false, blocked: true, code: "WORK_RUN_NOT_READY", status: workRun.status, external_mutation: false }, { status: 409 });
      }
      const bidId = bs.bid?.id != null ? String(bs.bid.id) : "";
      const ttl = Math.min(Math.max(Number(d.ttl_minutes) || 30, 5), 1440);
      const id = taskId();
      const expires = new Date(Date.now() + ttl * 6e4).toISOString();
      const summary = { task_id: jobId, action: "SUBMIT_WORK", opportunity_id: jobId, expected_net_profit: d.expected_net_profit ?? null, risk_flags: Array.isArray(d.risk_flags) ? d.risk_flags.map(String) : [], target: { job_id: jobId, bid_id: bidId, content_sha256: proofHash, file_urls: Array.isArray(d.fileUrls) ? d.fileUrls : [] } };
      const r = await createApproval(env, { id, task_id: jobId, action: "SUBMIT_WORK", summary, expires_at: expires });
      if (r.ok) await audit(env, "SUBMISSION_APPROVAL_REQUESTED", jobId, { approval_id: id, proof_hash: proofHash, external_mutation: false });
      return Response.json({ ...r, card: { job_id: jobId, accepted_bid: bs.bid || null, content_sha256: proofHash, bid_id: bidId, work_run_id: workRun?.run_id || null, content_length: content.length, file_urls: Array.isArray(d.fileUrls) ? d.fileUrls : [], external_mutation: false, submission_still_disabled: true } }, { status: r.ok ? 201 : 503 });
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/work-run/reconciliation") {
      const jobId = String(u.searchParams.get("job_id") || "").trim();
      if (!jobId) return Response.json({ ok: false, code: "JOB_ID_REQUIRED" }, { status: 400 });
      if (!env.DB) return Response.json({ ok: false, code: "DB_NOT_CONFIGURED" }, { status: 503 });
      const rid = `JOBRUN:${jobId}`;
      const row = await env.DB.prepare("SELECT * FROM work_runs WHERE run_id=?").bind(rid).first();
      if (!row) return Response.json({ ok: false, code: "WORK_RUN_NOT_FOUND", job_id: jobId }, { status: 404 });
      const rows = await env.DB.prepare("SELECT id,run_id,job_id,event_type,payload,created_at FROM work_run_events WHERE run_id=? ORDER BY id ASC").bind(rid).all();
      const r = await reconcileWorkRun(row, rows.results || []);
      await audit(env, r.consistent ? "WORK_RUN_RECONCILIATION_OK" : "WORK_RUN_RECONCILIATION_FAILED", jobId, { consistent: r.consistent, errors: r.errors || [], fail_closed: r.fail_closed });
      return Response.json(r, { status: r.consistent ? 200 : 409 });
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/work-run/events") {
      const jobId = String(u.searchParams.get("job_id") || "").trim();
      if (!jobId) return Response.json({ ok: false, code: "JOB_ID_REQUIRED" }, { status: 400 });
      if (!env.DB) return Response.json({ ok: false, code: "DB_NOT_CONFIGURED" }, { status: 503 });
      const rows = await env.DB.prepare("SELECT id,run_id,job_id,event_type,payload,created_at FROM work_run_events WHERE job_id=? ORDER BY id ASC").bind(jobId).all();
      const events = (rows.results || []).map((x) => {
        let payload = null;
        try {
          payload = x.payload ? JSON.parse(x.payload) : null;
        } catch {
        }
        return { ...x, payload };
      });
      await audit(env, "WORK_RUN_EVENTS_READ", jobId, { count: events.length, read_only: true });
      return Response.json({ ok: true, job_id: jobId, events, read_only: true, external_mutation: false });
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/work-run/checkpoints") {
      const jobId = String(u.searchParams.get("job_id") || "").trim();
      if (!jobId) return Response.json({ ok: false, code: "JOB_ID_REQUIRED" }, { status: 400 });
      if (!env.DB) return Response.json({ ok: false, code: "DB_NOT_CONFIGURED" }, { status: 503 });
      const row = await env.DB.prepare("SELECT * FROM work_runs WHERE run_id=?").bind(`JOBRUN:${jobId}`).first();
      if (!row) return Response.json({ ok: false, code: "WORK_RUN_NOT_FOUND", job_id: jobId }, { status: 404 });
      let result = {};
      try {
        result = row.result ? JSON.parse(row.result) : {};
      } catch {
      }
      return Response.json({ ok: true, job_id: jobId, run_id: row.run_id, status: row.status, current_checkpoint: result.current_checkpoint || null, checkpoint_history: Array.isArray(result.checkpoint_history) ? result.checkpoint_history : [], external_mutation: false });
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/work-run/recovery-analysis") {
      const jobId = String(u.searchParams.get("job_id") || "").trim();
      if (!jobId) return Response.json({ ok: false, code: "JOB_ID_REQUIRED" }, { status: 400 });
      if (!env.DB) return Response.json({ ok: false, code: "DB_NOT_CONFIGURED" }, { status: 503 });
      const row = await env.DB.prepare("SELECT * FROM work_runs WHERE run_id=?").bind(`JOBRUN:${jobId}`).first();
      let integrity = { checked: false };
      if (row) {
        const rows = await env.DB.prepare("SELECT id,run_id,job_id,event_type,payload,created_at FROM work_run_events WHERE run_id=? ORDER BY id ASC").bind(`JOBRUN:${jobId}`).all();
        const rr = await reconcileWorkRun(row, rows.results || []);
        integrity = { checked: true, consistent: rr.consistent, errors: rr.errors || [] };
      }
      const r = analyzeRecovery(row, integrity);
      await audit(env, r.ok ? "WORK_RUN_RECOVERY_ANALYSIS" : "WORK_RUN_RECOVERY_ANALYSIS_FAILED", jobId, { disposition: r.disposition || null, automatic_reexecution: false, integrity_checked: integrity.checked, integrity_consistent: integrity.consistent ?? null });
      return Response.json(r, { status: r.ok ? 200 : 404 });
    }
    if (req.method === "POST" && u.pathname === "/api/real-work/work-run/recover") {
      const d = await req.json().catch(() => ({}));
      const r = await recoverInterruptedRun(env, d);
      await audit(env, r.ok ? "WORK_RUN_RECOVERY_CHECK" : "WORK_RUN_RECOVERY_CHECK_FAILED", String(d.jobId || ""), { stage: r.stage || null, automatic_reexecution: false });
      return Response.json(r, { status: r.ok ? 200 : 503 });
    }
    if (req.method === "POST" && u.pathname === "/api/real-work/work-run/recovery-decision") {
      const d = await req.json().catch(() => ({}));
      const r = await explicitRecoveryDecision(env, d);
      await audit(env, r.ok ? "WORK_RUN_RECOVERY_DECISION" : "WORK_RUN_RECOVERY_DECISION_FAILED", String(d.jobId || ""), { decision: d.decision || null, stage: r.stage || null, external_mutation: false });
      return Response.json(r, { status: r.ok ? 200 : 409 });
    }
    if (req.method === "GET" && u.pathname === "/api/real-work/work-run") {
      const jobId = String(u.searchParams.get("job_id") || "").trim();
      if (!jobId) return Response.json({ ok: false, code: "JOB_ID_REQUIRED" }, { status: 400 });
      if (!env.DB) return Response.json({ ok: false, code: "DB_NOT_CONFIGURED" }, { status: 503 });
      const row = await env.DB.prepare("SELECT * FROM work_runs WHERE run_id=?").bind(`JOBRUN:${jobId}`).first();
      if (!row) return Response.json({ ok: false, code: "WORK_RUN_NOT_FOUND", job_id: jobId }, { status: 404 });
      let result = null;
      try {
        result = row.result ? JSON.parse(row.result) : null;
      } catch {
      }
      return Response.json({ ok: true, run: { run_id: row.run_id, job_id: row.job_id, bid_id: row.bid_id, status: row.status, created_at: row.created_at, updated_at: row.updated_at, result, checkpoint: result?.current_checkpoint || null, checkpoint_history: Array.isArray(result?.checkpoint_history) ? result.checkpoint_history : [] }, external_mutation: false });
    }
    if ((req.method === "POST" || req.method === "GET") && u.pathname === "/api/real-work/submission-approval-status") {
      const d = req.method === "GET" ? { approval_id: u.searchParams.get("approval_id") || "" } : await req.json().catch(() => ({}));
      const id = String(d.approval_id || "").trim();
      const row = await getApproval(env, id);
      if (!row) return Response.json({ ok: false, code: "APPROVAL_NOT_FOUND" }, { status: 404 });
      return Response.json({ ok: true, approval: { id: row.id, action: row.action, status: row.status, task_id: row.task_id, summary: JSON.parse(row.summary || "{}"), expires_at: row.expires_at }, external_mutation: false, submission_enabled: false });
    }
    if (req.method === "POST" && u.pathname === "/api/real-work/submission/validate") {
      const d = await req.json().catch(() => ({}));
      const jobId = String(d.jobId || d.job_id || "").trim();
      const approvalId = String(d.approval_id || "").trim();
      const content = String(d.content || "");
      if (!jobId || !approvalId || !content) return Response.json({ ok: false, code: "VALIDATION_INPUT_REQUIRED" }, { status: 400 });
      const bs = await getBidStatus(env, jobId);
      if (!bs.ok) return Response.json({ ok: false, blocked: true, code: "BID_STATUS_UNAVAILABLE", bid_status: bs }, { status: 503 });
      if (!bs.accepted) return Response.json({ ok: false, blocked: true, code: "BID_NOT_ACCEPTED", status: bs.status, external_mutation: false }, { status: 409 });
      const approval = await getApproval(env, approvalId);
      const contentHash = await sha256Hex3(content);
      const bidId = bs.bid?.id != null ? String(bs.bid.id) : null;
      const gate2 = validateSubmissionApproval(approval, { jobId, bidId, contentHash });
      if (!gate2.ok) return Response.json({ ok: false, blocked: true, ...gate2, external_mutation: false }, { status: 409 });
      if (!env.DB) return Response.json({ ok: false, blocked: true, code: "DB_NOT_CONFIGURED", external_mutation: false }, { status: 503 });
      const guardKey = submissionGuardKey(jobId, bidId);
      const existing = await env.DB.prepare("SELECT * FROM mutation_guard WHERE guard_key=?").bind(guardKey).first();
      if (existing) return Response.json({ ok: false, blocked: true, code: "MUTATION_ALREADY_ATTEMPTED", guard_key: guardKey, status: existing.status, external_mutation: false }, { status: 409 });
      await audit(env, "SUBMISSION_PREMUTATION_VALIDATED", jobId, { approval_id: approvalId, bid_id: bidId, content_hash: contentHash, guard_key: guardKey });
      return Response.json({ ok: true, ready: true, blocked: false, code: "SUBMISSION_VALIDATED", approval_id: approvalId, job_id: jobId, bid_id: bidId, content_sha256: contentHash, guard_key: guardKey, external_mutation: false, reason: "Validation passed. External submission still requires the owner approval and the guarded submit endpoint." });
    }
    if (req.method === "POST" && u.pathname === "/api/real-work/submission/submit") {
      const d = await req.json().catch(() => ({}));
      const jobId = String(d.jobId || d.job_id || "").trim();
      const approvalId = String(d.approval_id || "").trim();
      const content = String(d.content || "");
      if (!jobId || !approvalId || !content.trim()) return Response.json({ ok: false, code: "VALIDATION_INPUT_REQUIRED" }, { status: 400 });
      const bs = await getBidStatus(env, jobId);
      if (!bs.ok) return Response.json({ ok: false, blocked: true, code: "BID_STATUS_UNAVAILABLE", bid_status: bs, external_mutation: false }, { status: 503 });
      if (!bs.accepted) return Response.json({ ok: false, blocked: true, code: "BID_NOT_ACCEPTED", status: bs.status, bid: bs.bid || null, external_mutation: false }, { status: 409 });
      const bidId = bs.bid?.id != null ? String(bs.bid.id) : "";
      const approval = await getApproval(env, approvalId);
      const contentHash = await sha256Hex3(content);
      const gate2 = validateSubmissionApproval(approval, { jobId, bidId, contentHash });
      if (!gate2.ok) {
        await audit(env, "SUBMISSION_BLOCKED", jobId, { approval_id: approvalId, bid_id: bidId, code: gate2.code, content_hash: contentHash });
        return Response.json({ ok: false, blocked: true, ...gate2, external_mutation: false }, { status: 409 });
      }
      const job = await getJob(env, jobId);
      if (!job.ok) {
        await audit(env, "SUBMISSION_BLOCKED", jobId, { approval_id: approvalId, bid_id: bidId, code: "JOB_DETAILS_UNAVAILABLE" });
        return Response.json({ ok: false, blocked: true, code: "JOB_DETAILS_UNAVAILABLE", job_status: job, external_mutation: false }, { status: 503 });
      }
      const result = await submitApprovedWork(env, { approvalId, jobId, bidId, content, fileUrls: Array.isArray(d.fileUrls) ? d.fileUrls : [] });
      await audit(env, result.ok ? "SUBMISSION_SENT" : "SUBMISSION_FAILED", jobId, { approval_id: approvalId, bid_id: bidId, code: result.code || null, status: result.status || null, content_hash: contentHash, external_mutation: Boolean(result.ok) });
      return Response.json({ ...result, external_mutation: Boolean(result.ok), submission_endpoint: "POST /api/v2/jobs/:id/submissions" }, { status: result.ok ? 200 : result.code === "MUTATION_ALREADY_ATTEMPTED" ? 409 : 502 });
    }
    if (req.method === "POST" && u.pathname === "/api/real-work/submission-preflight") {
      const d = await req.json().catch(() => ({}));
      const pre = buildSubmissionPreflight(d);
      if (!pre.ok) return Response.json(pre, { status: 400 });
      const bs = await getBidStatus(env, String(d.jobId || ""));
      if (!bs.ok) return Response.json({ ok: false, blocked: true, code: "BID_STATUS_UNAVAILABLE", bid_status: bs }, { status: 503 });
      if (!bs.accepted) return Response.json({ ok: false, blocked: true, code: "BID_NOT_ACCEPTED", job_id: String(d.jobId), bid_status: bs.status, bid: bs.bid || null, external_mutation: false }, { status: 409 });
      return Response.json({ ...pre, accepted_bid: bs.bid, external_mutation: false, owner_approval_required: true });
    }
    if (req.method === "POST" && u.pathname === "/api/real-work/bid-approval-card") {
      const d = await req.json().catch(() => ({}));
      const jobId = String(d.job_id || "").trim();
      const amount = Number(d.amount);
      if (!jobId || !(amount > 0)) return Response.json({ ok: false, code: "INVALID_BID_REVIEW" }, { status: 400 });
      const revenue = d.revenue != null ? Number(d.revenue) : amount;
      const knownCosts = Array.isArray(d.known_costs) ? d.known_costs.map((x) => ({ name: String(x?.name || "cost"), amount: Number(x?.amount) || 0 })) : [];
      const costTotal = knownCosts.reduce((a, x) => a + x.amount, 0);
      const expectedNet = revenue - costTotal;
      const unknownCosts = Array.isArray(d.unknown_costs) ? d.unknown_costs.map(String) : [];
      const riskFlags = Array.isArray(d.risk_flags) ? d.risk_flags.map(String) : [];
      const taskIdValue = String(d.task_id || jobId);
      const ttl = Math.min(Math.max(Number(d.ttl_minutes) || 30, 5), 1440);
      const id = taskId();
      const expires = new Date(Date.now() + ttl * 6e4).toISOString();
      const summary = { task_id: taskIdValue, action: "PLACE_BID", opportunity_id: jobId, revenue, costs: { known_total: costTotal, items: knownCosts, unknown: unknownCosts }, expected_net_profit: expectedNet, risk_flags: riskFlags, target: { job_id: jobId, amount, message: String(d.message || ""), estimated_hours: d.estimated_hours != null ? Number(d.estimated_hours) : null } };
      const r = await createApproval(env, { id, task_id: taskIdValue, action: "PLACE_BID", summary, expires_at: expires });
      if (r.ok) await audit(env, "BID_APPROVAL_REQUESTED", taskIdValue, { approval_id: id, job_id: jobId, amount, expected_net_profit: expectedNet, unknown_costs: unknownCosts.length });
      return Response.json({ ...r, card: { job_id: jobId, bid_amount: amount, revenue, known_costs: knownCosts, known_cost_total: costTotal, expected_net_profit: expectedNet, unknown_costs: unknownCosts, risk_flags: riskFlags, message: String(d.message || ""), estimated_hours: d.estimated_hours != null ? Number(d.estimated_hours) : null } }, { status: r.ok ? 201 : 503 });
    }
    if (req.method === "POST" && u.pathname === "/api/approval/request") {
      const d = await req.json().catch(() => ({}));
      const taskIdValue = String(d.task_id || "").trim();
      if (!taskIdValue) return Response.json({ ok: false, error: "TASK_ID_REQUIRED" }, { status: 400 });
      const allowedActions = /* @__PURE__ */ new Set(["PLACE_BID", "SUBMIT_WORK", "EXTERNAL_MUTATION"]);
      if (!allowedActions.has(String(d.action || "EXTERNAL_MUTATION"))) return Response.json({ ok: false, code: "INVALID_APPROVAL_ACTION" }, { status: 400 });
      const ttl = Math.min(Math.max(Number(d.ttl_minutes) || 30, 5), 1440);
      const id = taskId();
      const expires = new Date(Date.now() + ttl * 6e4).toISOString();
      const r = await createApproval(env, { id, task_id: taskIdValue, action: d.action || "EXTERNAL_MUTATION", summary: approvalSummary(d), expires_at: expires });
      await audit(env, "OWNER_APPROVAL_REQUESTED", taskIdValue, { approval_id: id, action: d.action || "EXTERNAL_MUTATION", expires_at: expires });
      return Response.json(r, { status: r.ok ? 201 : 503 });
    }
    if (req.method === "POST" && u.pathname === "/api/approval/approve") {
      if (!ownerTokenValid(req, env)) return Response.json({ ok: false, code: "OWNER_APPROVAL_TOKEN_REQUIRED" }, { status: 401 });
      const d = await req.json().catch(() => ({}));
      const r = await approveGate(env, String(d.approval_id || ""));
      return Response.json(r, { status: r.ok ? 200 : 409 });
    }
    if (req.method === "POST" && u.pathname === "/api/approval/revoke") {
      if (!ownerTokenValid(req, env)) return Response.json({ ok: false, code: "OWNER_APPROVAL_TOKEN_REQUIRED" }, { status: 401 });
      const d = await req.json().catch(() => ({}));
      const id = String(d.approval_id || "");
      const row = await getApproval(env, id);
      if (!row) return Response.json({ ok: false, code: "APPROVAL_NOT_FOUND" }, { status: 404 });
      await env.DB.prepare("UPDATE approvals SET status=?,updated_at=? WHERE id=? AND status=?").bind("REVOKED", now5(), id, "PENDING").run();
      await audit(env, "OWNER_APPROVAL_REVOKED", row.task_id, { approval_id: id });
      return Response.json({ ok: true, id, status: "REVOKED" });
    }
    if (req.method === "GET" && u.pathname === "/api/approval") {
      const id = String(u.searchParams.get("id") || "");
      const row = await getApproval(env, id);
      if (!row) return Response.json({ ok: false, code: "APPROVAL_NOT_FOUND" }, { status: 404 });
      return Response.json({ ok: true, approval: { id: row.id, task_id: row.task_id, action: row.action, status: row.status, summary: JSON.parse(row.summary || "{}"), expires_at: row.expires_at, created_at: row.created_at, updated_at: row.updated_at } });
    }
    if (req.method === "GET" && u.pathname === "/api/phone/readiness") {
      const db = await dbStatus(env);
      const providers = freeProviderStatus(env);
      const checks = {
        worker: true,
        phone_control: true,
        free_only: true,
        paid_fallback: false,
        external_execution_enabled: false,
        owner_approval_gate: true,
        persistence_configured: Boolean(db.configured && db.mode === "d1"),
        free_provider_configured: providers.providers.some((x) => x.configured),
        browser_optional: true
      };
      const blockers = [];
      if (!checks.persistence_configured) blockers.push("D1_NOT_CONFIGURED");
      if (!checks.free_provider_configured) blockers.push("FREE_PROVIDER_NOT_CONFIGURED");
      return Response.json({ ok: true, version: VERSION, checks, blockers, ready_for_phone_smoke: blockers.length === 0, ready_for_safe_phone_ui: true, free_providers: providers.providers, persistence: db, external_actions: { bid: false, submit: false, payment: false, withdrawal: false }, message: "Deployment readiness only; no external mutation is performed." });
    }
    if (req.method === "POST" && u.pathname === "/api/phone/smoke") {
      const d = await req.json().catch(() => ({}));
      const task = String(d.task || "\u0627\u062E\u062A\u0628\u0631 \u0627\u062A\u0635\u0627\u0644 \u0648\u0643\u064A\u0644 \u0627\u0644\u0647\u0627\u062A\u0641 \u0641\u0642\u0637").trim();
      const assessment = assess(task);
      const workPlan = plan(task, assessment);
      const providers = freeProviderStatus(env);
      const db = await dbStatus(env);
      const control = await getControl(env);
      const checks = [
        ["status_route", true],
        ["assessment", assessment && typeof assessment.decision === "string"],
        ["work_plan", workPlan && Array.isArray(workPlan.steps)],
        ["free_provider_router", Array.isArray(providers.providers)],
        ["control", control && typeof control.status === "string"]
      ];
      return Response.json({ ok: checks.every((x) => x[1]), mode: "SAFE_PHONE_SMOKE", checks: Object.fromEntries(checks), task, assessment, work_plan: workPlan, free_providers: providers.providers, persistence: db, control, external_mutation: false, external_actions: { bid: false, submit: false, payment: false, withdrawal: false }, provider_execution_performed: false });
    }
    if (req.method === "GET" && u.pathname === "/api/status") {
      const db = await dbStatus(env);
      const control = await getControl(env);
      return Response.json({ ok: true, version: VERSION, free_only: true, execution_enabled: false, paid_fallback: false, provider: "free-provider-router", provider_configured: Boolean(env.GEMINI_API_KEY || env.AI || env.MISTRAL_API_KEY), free_providers: freeProviderStatus(env).providers, browser_read_only: true, browser_configured: Boolean(env.BROWSER), execution_adapter: "thebotclub_v2_owner_approved_bid_gate_submission_live", external_execution_enabled: false, approved_external_mutations: { place_bid: true, submit_work: true }, owner_approval_gate: true, phone_control: true, persistence: db, control });
    }
    if (req.method === "POST" && u.pathname === "/api/browser/read") {
      const body = await req.json().catch(() => ({}));
      if (!body.url) return Response.json({ ok: false, error: "URL_REQUIRED" }, { status: 400 });
      const control = await getControl(env);
      if (control.status === "STOPPED") return Response.json({ ok: false, error: "AGENT_STOPPED" }, { status: 409 });
      const r = await browserRead(body.url, env);
      await audit(env, r.ok ? "BROWSER_READ_OK" : "BROWSER_READ_FAILED", null, { url: body.url, mode: "READ_ONLY" });
      return Response.json(r, { status: r.ok ? 200 : 503 });
    }
    if (req.method === "GET" && u.pathname === "/api/control") return Response.json({ ok: true, control: await getControl(env) });
    if (req.method === "POST" && u.pathname === "/api/control/stop") {
      await setAgentState(env, "STOPPED");
      await audit(env, "OWNER_STOP");
      return Response.json({ ok: true, status: "STOPPED" });
    }
    if (req.method === "POST" && u.pathname === "/api/control/resume") {
      await setAgentState(env, "IDLE");
      await audit(env, "OWNER_RESUME");
      return Response.json({ ok: true, status: "IDLE" });
    }
    if (req.method === "GET" && u.pathname === "/api/tasks") {
      if (!env.DB) return Response.json({ ok: true, persistent: false, tasks: [] });
      const r = await env.DB.prepare("SELECT id,task,status,decision,created_at,updated_at FROM tasks ORDER BY updated_at DESC LIMIT 50").all();
      return Response.json({ ok: true, persistent: true, tasks: r.results || [] });
    }
    if (req.method === "POST" && u.pathname === "/api/assess") {
      const d = await req.json();
      return Response.json({ ok: true, mode: "preflight_only", assessment: assess(String(d.task || "").trim()) });
    }
    if (req.method === "POST" && u.pathname === "/api/work-plan") {
      const d = await req.json();
      const a = assess(String(d.task || "").trim());
      return Response.json({ ok: true, plan: plan(String(d.task || "").trim(), a) });
    }
    if (req.method === "POST" && u.pathname === "/api/execution/preflight") {
      const d = await req.json().catch(() => ({}));
      const task = String(d.task || "").trim();
      if (!task) return Response.json({ ok: false, error: "TASK_REQUIRED" }, { status: 400 });
      return Response.json(await executionPreflight(task, env));
    }
    if (req.method === "POST" && u.pathname === "/api/execute") {
      const control = await getControl(env);
      if (control.status === "STOPPED") return Response.json({ ok: false, blocked: true, code: "OWNER_STOPPED" }, { status: 409 });
      const d = await req.json().catch(() => ({}));
      const task = String(d.task || "").trim();
      const work = String(d.work_product || "").trim();
      if (!task || !work) return Response.json({ ok: false, error: "TASK_AND_WORK_PRODUCT_REQUIRED" }, { status: 400 });
      const a = assess(task);
      const pl = plan(task, a);
      const packet = { ok: a.decision === "READY_FOR_EXECUTION_PLAN", mode: "SAFE_LOCAL", status: a.decision === "READY_FOR_EXECUTION_PLAN" ? "READY_FOR_OWNER_APPROVAL" : "BLOCKED", task, work_product: work, proof_hash: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(work)))).map((b) => b.toString(16).padStart(2, "0")).join(""), external_delivery: "BLOCKED", external_actions: { bid: false, claim: false, stake: false, submit: false, payment: false, withdrawal: false, credential_submission: false, account_change: false, external_message: false } };
      if (!packet.ok) packet.blockers = ["preflight_not_ready"];
      await audit(env, packet.ok ? "WORK_PRODUCT_READY" : "WORK_PRODUCT_BLOCKED", null, { status: packet.status, proof_hash: packet.proof_hash });
      return Response.json(packet, { status: packet.ok ? 200 : 409 });
    }
    if (req.method === "POST" && u.pathname === "/api/work/execute") {
      const control = await getControl(env);
      if (control.status === "STOPPED") return Response.json({ ok: false, blocked: true, code: "OWNER_STOPPED" }, { status: 409 });
      const d = await req.json().catch(() => ({}));
      const task = String(d.task || "").trim();
      if (!task) return Response.json({ ok: false, error: "TASK_REQUIRED" }, { status: 400 });
      const result = await executeWork(task, env, { assess });
      await audit(env, result.ok ? "WORK_EXECUTED" : "WORK_EXECUTION_FAILED", null, { provider: result.provider || null, status: result.status || null, proof_hash: result.proof_hash || null });
      return Response.json(result, { status: result.ok ? 200 : result.status === "REVIEW_REQUIRED" ? 409 : 503 });
    }
    if (req.method === "POST" && u.pathname === "/api/agent/run") {
      const control = await getControl(env);
      if (control.status === "STOPPED") return Response.json({ ok: false, blocked: true, code: "OWNER_STOPPED" }, { status: 409 });
      const d = await req.json().catch(() => ({}));
      const task = String(d.task || "").trim();
      if (!task) return Response.json({ ok: false, error: "TASK_REQUIRED" }, { status: 400 });
      const id = taskId();
      const created = now5();
      await saveTask(env, { id, task, status: "ASSESSING", decision: null, created_at: created, updated_at: created });
      await audit(env, "AGENT_RUN_STARTED", id, {});
      await setAgentState(env, "WORKING", id);
      const result = await autonomousRun(task, env);
      const finalState = result.status === "READY_FOR_DELIVERY" ? "IDLE" : result.status === "REVIEW_REQUIRED" ? "WAITING" : "WAITING";
      await updateTask(env, id, result.status, result);
      await setAgentState(env, finalState, finalState === "WAITING" ? id : null);
      await audit(env, "AGENT_RUN_FINISHED", id, { status: result.status, tool: result.tool?.tool || null });
      return Response.json({ ok: true, task_id: id, mode: "autonomous_safe_loop", ...result });
    }
    if (req.method === "POST" && u.pathname === "/api/task") {
      const control = await getControl(env);
      if (control.status === "STOPPED") return Response.json({ ok: false, blocked: true, code: "OWNER_STOPPED" });
      const d = await req.json();
      const task = String(d.task || "").trim();
      const a = assess(task);
      const id = taskId();
      const created = now5();
      await saveTask(env, { id, task, status: "ASSESSING", decision: a.decision, created_at: created, updated_at: created });
      await audit(env, "TASK_CREATED", id, { decision: a.decision });
      if (a.decision === "REJECT") {
        await updateTask(env, id, "REJECTED", { assessment: a });
        await audit(env, "TASK_REJECTED", id, { assessment: a });
        return Response.json({ ok: false, blocked: true, task_id: id, assessment: a });
      }
      if (a.decision !== "READY_FOR_EXECUTION_PLAN") {
        await updateTask(env, id, "REVIEW_REQUIRED", { assessment: a });
        await audit(env, "TASK_REVIEW_REQUIRED", id, { assessment: a });
        return Response.json({ ok: true, mode: "review_required", task_id: id, assessment: a, plan: plan(task, a) });
      }
      await setAgentState(env, "WORKING", id);
      await updateTask(env, id, "WORKING", { assessment: a });
      await audit(env, "TASK_WORKING", id, { provider: "gemini" });
      const result = await runFreeAI(task, env);
      const finalStatus = result.ok ? "COMPLETED" : "WAITING";
      await updateTask(env, id, finalStatus, { assessment: a, result });
      await setAgentState(env, result.ok ? "IDLE" : "WAITING", result.ok ? null : id);
      await audit(env, result.ok ? "TASK_COMPLETED" : "TASK_WAITING", id, { provider: result.provider || null, code: result.code || null });
      return Response.json({ ok: result.ok, mode: result.ok ? "completed" : "provider_unavailable", task_id: id, assessment: a, result, external_actions: { bid: false, claim: false, submit: false, payment: false, withdrawal: false } });
    }
    return new Response("Not Found", { status: 404 });
  } catch (e) {
    const bad = e instanceof SyntaxError;
    if (!bad) console.error("worker_error", e && e.stack || String(e));
    return Response.json({ ok: false, error: bad ? "INVALID_JSON_BODY" : "INTERNAL_ERROR" }, { status: bad ? 400 : 500 });
  }
} };
export {
  worker_default as default
};
