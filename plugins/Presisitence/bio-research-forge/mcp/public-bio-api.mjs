#!/usr/bin/env node

import readline from 'node:readline';

const SERVER = { name: 'public-bio-api', version: '0.1.0' };
const MAX_RESPONSE_BYTES = 250_000;
const DEFAULT_TIMEOUT_MS = 45_000;

const SOURCES = {
  ncbi: {
    label: 'NCBI E-utilities',
    category: 'literature-and-sequence',
    operations: ['search'],
    docs: 'https://www.ncbi.nlm.nih.gov/books/NBK25501/',
    base: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/',
    notes: 'Read-only ESearch. Without an API key, callers should remain at or below 3 requests/second.',
  },
  uniprot: {
    label: 'UniProt REST API',
    category: 'protein',
    operations: ['search'],
    docs: 'https://rest.uniprot.org/',
    base: 'https://rest.uniprot.org/',
    notes: 'Protein records and annotations. Query provenance and returned release headers should be retained.',
  },
  interpro: {
    label: 'InterPro API',
    category: 'protein-domain',
    operations: ['search', 'protein-entries'],
    docs: 'https://www.ebi.ac.uk/interpro/api/',
    base: 'https://www.ebi.ac.uk/interpro/api/',
    notes: 'Protein families, domains, and sites. Results are evidence, not automatic functional proof.',
  },
  ensembl: {
    label: 'Ensembl REST',
    category: 'genome',
    operations: ['lookup-id', 'lookup-symbol'],
    docs: 'https://rest.ensembl.org/',
    base: 'https://rest.ensembl.org/',
    notes: 'Public genome annotation lookup. Record species and stable identifier version where available.',
  },
  alphafold: {
    label: 'AlphaFold Protein Structure Database API',
    category: 'structure',
    operations: ['prediction'],
    docs: 'https://alphafold.ebi.ac.uk/api-docs',
    base: 'https://alphafold.ebi.ac.uk/api/',
    notes: 'Predicted structures. Confidence and coverage must be reported; a prediction is not experimental validation.',
  },
  rcsb: {
    label: 'RCSB PDB Data API',
    category: 'structure',
    operations: ['entry'],
    docs: 'https://data.rcsb.org/',
    base: 'https://data.rcsb.org/rest/v1/core/',
    notes: 'Experimentally deposited structure metadata. Inspect method, resolution, construct, and biological assembly.',
  },
  europepmc: {
    label: 'Europe PMC REST API',
    category: 'literature',
    operations: ['search'],
    docs: 'https://europepmc.org/RestfulWebService',
    base: 'https://www.ebi.ac.uk/europepmc/webservices/rest/',
    notes: 'Literature discovery. Search hits must be read and checked before being used to support a claim.',
  },
  string: {
    label: 'STRING API',
    category: 'network',
    operations: ['network'],
    docs: 'https://string-db.org/help/api/',
    base: 'https://string-db.org/api/',
    notes: 'Functional association network. Scores and text mining are not direct physical-interaction proof.',
  },
  jaspar: {
    label: 'JASPAR REST API',
    category: 'regulatory',
    operations: ['matrix', 'matrix-search'],
    docs: 'https://jaspar.elixir.no/api/v1/docs/',
    base: 'https://jaspar.elixir.no/api/v1/',
    notes: 'Curated transcription-factor binding profiles. Motif matches are candidates, not occupancy evidence.',
  },
  sgn: {
    label: 'Sol Genomics Network public BrAPI metadata',
    category: 'solanaceae-resource',
    operations: ['common-crop-names'],
    docs: 'https://solgenomics.net/brapi/v2/commoncropnames',
    base: 'https://solgenomics.net/brapi/v2/',
    notes: 'Generic public Solanaceae-resource metadata only. Pepper-specific operations are intentionally blocked.',
  },
};

const ALLOWED_HOSTS = new Set(
  Object.values(SOURCES).map((source) => new URL(source.base).hostname.toLowerCase()),
);

const SECRET_QUERY_PARAM = /^(?:api[_-]?key|token|access[_-]?token|auth(?:entication)?|password|secret|client[_-]?secret)$/i;
const SECRET_ENV_NAME = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH)/i;

const TOOLS = [
  {
    name: 'bio_api_catalog',
    description: 'List the public biological API allowlist, supported operations, evidence limits, and documentation URLs. No network request is made.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: { type: 'string', description: 'Optional category filter.' },
      },
    },
  },
  {
    name: 'bio_api_query',
    description: 'Run one read-only, bounded query against a named public biological API. Arbitrary URLs, local files, private resources, and pepper-specific queries are blocked. The result includes the exact source URL and retrieval time.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', enum: Object.keys(SOURCES) },
        operation: { type: 'string' },
        query: { type: 'string' },
        id: { type: 'string' },
        species: { type: 'string' },
        database: { type: 'string' },
        identifiers: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        fields: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['source', 'operation'],
    },
  },
  {
    name: 'bio_api_health',
    description: 'Report server health and optionally perform a small live request to one public source. This never reads local research files.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        live: { type: 'boolean', default: false },
        source: { type: 'string', enum: Object.keys(SOURCES) },
      },
    },
  },
];

function rpcSend(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcResult(id, result) {
  rpcSend({ jsonrpc: '2.0', id, result });
}

function rpcError(id, code, message, data) {
  rpcSend({ jsonrpc: '2.0', id, error: { code, message: redactSecrets(message), ...(data === undefined ? {} : { data: redactSecrets(data) }) } });
}

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text: redactSecrets(text) }], ...(isError ? { isError: true } : {}) };
}

function positiveInt(value, fallback, max = 50) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function requiredText(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') throw new Error(`${label} is required`);
  return text;
}

function safeToken(value, label, pattern = /^[A-Za-z0-9_.:-]+$/) {
  const text = requiredText(value, label);
  if (!pattern.test(text)) throw new Error(`${label} contains unsupported characters`);
  return text;
}

function secretValues() {
  const secrets = new Set();
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || typeof value !== 'string') continue;
    if (!SECRET_ENV_NAME.test(key)) continue;
    if (value.length < 4) continue;
    secrets.add(value);
  }
  return [...secrets];
}

function redactSecrets(value) {
  if (value == null) return value;
  if (typeof value !== 'string') {
    try {
      return JSON.parse(redactSecrets(JSON.stringify(value)));
    } catch {
      return redactSecrets(String(value));
    }
  }
  let out = value;
  for (const secret of secretValues()) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(/([?&](?:api[_-]?key|token|access[_-]?token|auth(?:entication)?|password|secret|client[_-]?secret)=)[^&\s"'<>]+/gi, '$1[REDACTED]');
  return out;
}

function redactUrl(urlLike) {
  const url = new URL(String(urlLike));
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_PARAM.test(key)) url.searchParams.set(key, 'REDACTED');
  }
  return url.toString();
}

function assertAllowedHost(urlLike) {
  const url = new URL(String(urlLike));
  if (url.protocol !== 'https:') {
    throw new Error(`Blocked non-HTTPS URL host: ${url.hostname}`);
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Blocked non-allowlisted host: ${url.hostname}`);
  }
}

function assertPublicScope(args) {
  const serialized = JSON.stringify(args || {});
  const banned = [
    /pepper/i,
    /capsicum/i,
    /capana/i,
    /zunla/i,
    /zhangshugang/i,
    /\bcaz\d+/i,
    /(?:[A-Za-z]:\\|\/Users\/|\/home\/)/,
    /(?:api[_-]?key|token|password)\s*[:=]/i,
  ];
  if (banned.some((rule) => rule.test(serialized))) {
    throw new Error('Query blocked by the public-data boundary: private paths, credentials, and pepper-specific resources are not allowed.');
  }
}

function urlFor(args) {
  const source = requiredText(args.source, 'source');
  const operation = requiredText(args.operation, 'operation');
  const entry = SOURCES[source];
  if (!entry) throw new Error(`Unsupported source: ${source}`);
  if (!entry.operations.includes(operation)) {
    throw new Error(`Unsupported operation for ${source}: ${operation}. Allowed: ${entry.operations.join(', ')}`);
  }

  const limit = positiveInt(args.limit, 10);
  let url;
  if (source === 'ncbi') {
    const database = safeToken(args.database || 'gene', 'database', /^[A-Za-z0-9_-]+$/);
    const query = requiredText(args.query, 'query');
    url = new URL('esearch.fcgi', entry.base);
    url.searchParams.set('db', database);
    url.searchParams.set('term', query);
    url.searchParams.set('retmode', 'json');
    url.searchParams.set('retmax', String(limit));
    if (process.env.NCBI_API_KEY) url.searchParams.set('api_key', process.env.NCBI_API_KEY);
  } else if (source === 'uniprot') {
    url = new URL('uniprotkb/search', entry.base);
    url.searchParams.set('query', requiredText(args.query, 'query'));
    url.searchParams.set('format', 'json');
    url.searchParams.set('size', String(limit));
    if (Array.isArray(args.fields) && args.fields.length > 0) {
      url.searchParams.set('fields', args.fields.map((field) => safeToken(field, 'field', /^[A-Za-z0-9_,-]+$/)).join(','));
    }
  } else if (source === 'interpro' && operation === 'search') {
    url = new URL('entry/interpro/', entry.base);
    url.searchParams.set('search', requiredText(args.query, 'query'));
    url.searchParams.set('page_size', String(limit));
  } else if (source === 'interpro') {
    const id = safeToken(args.id, 'UniProt accession');
    url = new URL(`protein/uniprot/${encodeURIComponent(id)}/entry/interpro/`, entry.base);
    url.searchParams.set('page_size', String(limit));
  } else if (source === 'ensembl' && operation === 'lookup-id') {
    const id = safeToken(args.id, 'stable identifier');
    url = new URL(`lookup/id/${encodeURIComponent(id)}`, entry.base);
    url.searchParams.set('content-type', 'application/json');
  } else if (source === 'ensembl') {
    const species = safeToken(args.species, 'species', /^[A-Za-z0-9_]+$/);
    const symbol = safeToken(args.id, 'symbol', /^[A-Za-z0-9_.-]+$/);
    url = new URL(`lookup/symbol/${encodeURIComponent(species)}/${encodeURIComponent(symbol)}`, entry.base);
    url.searchParams.set('content-type', 'application/json');
  } else if (source === 'alphafold') {
    const accession = safeToken(args.id, 'UniProt accession');
    url = new URL(`prediction/${encodeURIComponent(accession)}`, entry.base);
  } else if (source === 'rcsb') {
    const pdbId = safeToken(args.id, 'PDB identifier', /^[A-Za-z0-9]{4}$/).toUpperCase();
    url = new URL(`entry/${pdbId}`, entry.base);
  } else if (source === 'europepmc') {
    url = new URL('search', entry.base);
    url.searchParams.set('query', requiredText(args.query, 'query'));
    url.searchParams.set('format', 'json');
    url.searchParams.set('pageSize', String(limit));
  } else if (source === 'string') {
    const identifiers = Array.isArray(args.identifiers) ? args.identifiers : [];
    if (identifiers.length === 0) throw new Error('identifiers is required');
    const clean = identifiers.map((id) => safeToken(id, 'identifier', /^[A-Za-z0-9_.:-]+$/));
    const species = safeToken(args.species, 'species taxonomy identifier', /^[0-9]+$/);
    url = new URL('json/network', entry.base);
    url.searchParams.set('identifiers', clean.join('\r'));
    url.searchParams.set('species', species);
    url.searchParams.set('limit', String(limit));
  } else if (source === 'jaspar' && operation === 'matrix') {
    const id = safeToken(args.id, 'matrix identifier', /^[A-Za-z0-9_.-]+$/);
    url = new URL(`matrix/${encodeURIComponent(id)}/`, entry.base);
  } else if (source === 'jaspar') {
    url = new URL('matrix/', entry.base);
    url.searchParams.set('search', requiredText(args.query, 'query'));
    url.searchParams.set('page_size', String(limit));
  } else if (source === 'sgn') {
    url = new URL('commoncropnames', entry.base);
    url.searchParams.set('pageSize', String(limit));
  } else {
    throw new Error(`No request builder for ${source}/${operation}`);
  }
  assertAllowedHost(url);
  return { source, operation, entry, url };
}

function scrubExcludedSpecies(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !/\b(?:pepper|capsicum)\b/i.test(typeof item === 'string' ? item : JSON.stringify(item)))
      .map(scrubExcludedSpecies);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubExcludedSpecies(item)]));
  }
  return value;
}

async function readBodyLimited(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = response.headers.get('content-length');
  if (declared != null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new Error(`Response exceeded ${maxBytes} bytes. Narrow the query or lower limit.`);
    }
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`Response exceeded ${maxBytes} bytes. Narrow the query or lower limit.`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeded ${maxBytes} bytes. Narrow the query or lower limit.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* ignore */ }
    throw error;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  assertAllowedHost(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': `${SERVER.name}/${SERVER.version}`,
      },
    });
    const body = await readBodyLimited(response);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 1000)}`);
    }
    let data;
    try { data = JSON.parse(body); } catch { throw new Error(`Expected JSON but received: ${body.slice(0, 500)}`); }
    return { data, headers: Object.fromEntries([...response.headers.entries()].filter(([key]) => /^(content-type|etag|last-modified|x-|link)/i.test(key))) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(message));
  } finally {
    clearTimeout(timer);
  }
}

function catalog(category) {
  return Object.entries(SOURCES)
    .filter(([, source]) => !category || source.category === category)
    .map(([id, source]) => ({ id, ...source }));
}

async function query(args) {
  assertPublicScope(args);
  const built = urlFor(args);
  const received = await fetchJson(built.url);
  const data = built.source === 'sgn' ? scrubExcludedSpecies(received.data) : received.data;
  return {
    source: built.source,
    label: built.entry.label,
    operation: built.operation,
    retrievedAt: new Date().toISOString(),
    sourceUrl: redactUrl(built.url),
    documentation: built.entry.docs,
    evidenceNote: built.entry.notes,
    responseHeaders: received.headers,
    data,
  };
}

async function health(args = {}) {
  const base = {
    status: 'healthy',
    server: SERVER,
    node: process.version,
    publicOnly: true,
    arbitraryUrlsAllowed: false,
    localFilesRead: false,
    sources: Object.keys(SOURCES),
  };
  if (!args.live) return base;
  const source = args.source || 'ncbi';
  const probes = {
    ncbi: { source: 'ncbi', operation: 'search', database: 'gene', query: 'FLC[sym] AND Arabidopsis thaliana[orgn]', limit: 1 },
    uniprot: { source: 'uniprot', operation: 'search', query: 'gene_exact:FLC AND organism_id:3702', fields: ['accession', 'id'], limit: 1 },
    interpro: { source: 'interpro', operation: 'search', query: 'NB-ARC', limit: 1 },
    ensembl: { source: 'ensembl', operation: 'lookup-symbol', species: 'arabidopsis_thaliana', id: 'FLC' },
    alphafold: { source: 'alphafold', operation: 'prediction', id: 'Q9C5Y0' },
    rcsb: { source: 'rcsb', operation: 'entry', id: '4G0F' },
    europepmc: { source: 'europepmc', operation: 'search', query: 'plant immunity', limit: 1 },
    string: { source: 'string', operation: 'network', identifiers: ['AT5G10140'], species: '3702', limit: 1 },
    jaspar: { source: 'jaspar', operation: 'matrix-search', query: 'WRKY', limit: 1 },
    sgn: { source: 'sgn', operation: 'common-crop-names', limit: 10 },
  };
  if (!probes[source]) throw new Error(`Unsupported source: ${source}`);
  const result = await query(probes[source]);
  return { ...base, live: { source, ok: true, sourceUrl: result.sourceUrl, retrievedAt: result.retrievedAt } };
}

async function callTool(name, args) {
  if (name === 'bio_api_catalog') return textResult({ generatedAt: new Date().toISOString(), sources: catalog(args?.category) });
  if (name === 'bio_api_query') {
    try { return textResult(await query(args || {})); }
    catch (error) { return textResult(redactSecrets(error instanceof Error ? error.message : String(error)), true); }
  }
  if (name === 'bio_api_health') {
    try { return textResult(await health(args || {})); }
    catch (error) { return textResult(redactSecrets(error instanceof Error ? error.message : String(error)), true); }
  }
  return textResult(`Unknown tool: ${name}`, true);
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  const { id, method, params } = message;
  if (id === undefined || id === null) return;
  try {
    if (method === 'initialize') {
      rpcResult(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER,
      });
    } else if (method === 'ping') {
      rpcResult(id, {});
    } else if (method === 'tools/list') {
      rpcResult(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      rpcResult(id, await callTool(params?.name, params?.arguments));
    } else {
      rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    rpcError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  try { void handle(JSON.parse(trimmed)); }
  catch (error) { rpcError(null, -32700, error instanceof Error ? error.message : String(error)); }
});
