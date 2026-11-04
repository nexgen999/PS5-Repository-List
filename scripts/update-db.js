#!/usr/bin/env node
'use strict';

/**
 * Génère json/repos-database.json à partir de json/repos-config.json.
 *
 * Le script était le goulot d'étranglement du workflow : une boucle strictement
 * séquentielle (4 requêtes HTTP par dépôt, ~1,5 s par dépôt) imposait ~12 minutes
 * pour 468 dépôts, et le moindre ajout dans repos-config.json coûtait donc un
 * rafraîchissement complet.
 *
 * Optimisations :
 *  - requêtes GitHub exécutées en parallèle (pool borné, 16 par défaut) : ~2 min
 *    de gagnées sur un run à froid, et le run manuel après édition de la config
 *    passe sous la minute ;
 *  - cache incrémental : le README (~13 Ko en moyenne) et les 10 derniers commits
 *    d'un dépôt ne sont re-téléchargés que si son `pushed_at` a changé depuis la
 *    dernière génération. Un run « rien n'a bougé » ne fait plus que 2 requêtes
 *    par dépôt (métadonnées + dernière release) ;
 *  - dépôts listés plusieurs fois dans la config (catégories différentes) :
 *    une seule collecte réseau, une entrée de sortie par ligne de config ;
 *  - `releases?per_page=1` au lieu de la liste complète (payload plus petit) ;
 *  - timeouts, retries avec backoff et respect des en-têtes de rate limit
 *    (`x-ratelimit-*`, `retry-after`) pour rester fiable en parallèle ;
 *  - identifiants stables (repris du JSON précédent).
 *
 * Variables d'environnement :
 *  - GITHUB_TOKEN / GH_TOKEN : token API (indispensable : 60 req/h sans token).
 *  - UPDATE_CONCURRENCY       : requêtes simultanées (défaut 16, max 32).
 *  - FORCE_REFRESH=1          : ignore le cache et retélécharge README/commits.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../json/repos-config.json');
const OUTPUT_PATH = path.join(__dirname, '../json/repos-database.json');
const API_BASE = 'https://api.github.com';

const TOKEN = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const REQUESTED_CONCURRENCY = Number.parseInt(process.env.UPDATE_CONCURRENCY || '', 10);
const CONCURRENCY = Number.isFinite(REQUESTED_CONCURRENCY) && REQUESTED_CONCURRENCY > 0
  ? Math.min(REQUESTED_CONCURRENCY, 32)
  : 16;
const FORCE_REFRESH = /^(1|true|yes)$/i.test((process.env.FORCE_REFRESH || '').trim());

const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_GLOBAL_PAUSE_MS = 120000;

const headers = {
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'PS5-Repository-List-Builder',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(TOKEN ? { 'Authorization': `Bearer ${TOKEN}` } : {})
};

const stats = {
  requests: 0,
  notFound: 0,
  retries: 0,
  throttled: 0,
  cachedReadmes: 0,
  fetchedReadmes: 0,
  failedGroups: 0
};

// Dépôts volontairement écartés de la base (URL invalide ou dépôt supprimé).
const ignored = [];

let syntheticIdCounter = 0;
const startedTimestamp = Date.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt) {
  return Math.min(250 * 2 ** (attempt - 1), 4000) + Math.floor(Math.random() * 250);
}

// Pause partagée : dès qu'une requête est throttlée, tous les workers attendent.
let globalPauseUntil = 0;

async function waitForGlobalPause() {
  let wait = globalPauseUntil - Date.now();
  while (wait > 0) {
    await sleep(wait);
    wait = globalPauseUntil - Date.now();
  }
}

function applyThrottle(response, attempt) {
  const retryAfter = Number.parseFloat(response.headers.get('retry-after') || '');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = Number.parseFloat(response.headers.get('x-ratelimit-reset') || '');
  let waitMs;

  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    waitMs = retryAfter * 1000;
  } else if (remaining === '0' && Number.isFinite(reset)) {
    waitMs = reset * 1000 - Date.now() + 1000;
  } else {
    waitMs = backoffMs(attempt);
  }

  waitMs = Math.min(Math.max(waitMs, 250), MAX_GLOBAL_PAUSE_MS);
  globalPauseUntil = Math.max(globalPauseUntil, Date.now() + waitMs);
  stats.throttled++;
}

/**
 * Exécute une requête GET et renvoie la Response si elle est OK, `null` sur 404.
 * Retente les erreurs réseau, les 5xx et les 403/429 de rate limiting.
 */
async function apiRequest(url, accept) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await waitForGlobalPause();
    let response;

    try {
      response = await fetch(url, {
        headers: accept ? { ...headers, 'Accept': accept } : headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      stats.requests++;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      stats.retries++;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (response.ok) return response;

    if (response.status === 404) {
      stats.notFound++;
      await response.text().catch(() => {});
      return null;
    }

    const isRateLimited = response.status === 403 || response.status === 429;
    const isTransient = response.status >= 500;

    if (isRateLimited || isTransient) {
      const body = await response.text().catch(() => '');
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`Erreur API GitHub (${response.status} ${response.statusText}) après ${MAX_ATTEMPTS} tentatives pour ${url}${body ? ` — ${body.slice(0, 200)}` : ''}`);
      }
      if (isRateLimited) {
        applyThrottle(response, attempt);
      } else {
        stats.retries++;
        await sleep(backoffMs(attempt));
      }
      continue;
    }

    const body = await response.text().catch(() => '');
    throw new Error(`Erreur API GitHub (${response.status} ${response.statusText}) pour l'URL : ${url}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }

  throw new Error(`Erreur API GitHub inattendue pour l'URL : ${url}`);
}

async function getJSON(url) {
  const response = await apiRequest(url);
  return response ? response.json() : null;
}

async function getText(url, accept) {
  const response = await apiRequest(url, accept);
  return response ? response.text() : null;
}

function normalizeUrl(url) {
  return String(url || '')
    .trim()
    .toLowerCase()
    .replace(/^http:/, 'https:')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

function loadPreviousDatabase() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  } catch (error) {
    return null;
  }
}

/** Une même URL peut apparaître plusieurs fois (catégories différentes). */
function buildPreviousIndex(previous) {
  const byUrl = new Map();
  const repos = (previous && Array.isArray(previous.repos)) ? previous.repos : [];

  for (const repo of repos) {
    if (!repo || !repo.url) continue;
    const key = normalizeUrl(repo.url);
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(repo);
  }

  return byUrl;
}

function groupConfigItems(items) {
  const groups = [];
  const byKey = new Map();

  items.forEach((item, index) => {
    const key = normalizeUrl(item.url) || `invalid:${index}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push({ item, index });
  });

  return groups;
}

function toRecentCommits(commitsData) {
  if (!Array.isArray(commitsData)) return [];
  return commitsData.map((commit) => ({
    sha: String(commit.sha || '').substring(0, 7),
    message: commit.commit && commit.commit.message ? commit.commit.message.split('\n')[0] : '',
    authorName: commit.commit && commit.commit.author ? commit.commit.author.name : 'Unknown',
    authorAvatar: commit.author ? commit.author.avatar_url : null,
    date: commit.commit && commit.commit.author ? commit.commit.author.date : new Date().toISOString(),
    url: commit.html_url
  }));
}

function toLatestRelease(releasesData) {
  if (!Array.isArray(releasesData) || releasesData.length === 0) return null;
  const rel = releasesData[0];
  return {
    id: rel.id,
    tagName: rel.tag_name,
    name: rel.name || rel.tag_name,
    publishedAt: rel.published_at,
    body: rel.body || '',
    htmlUrl: rel.html_url,
    assets: (rel.assets || []).map((asset) => ({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      downloadCount: asset.download_count,
      downloadUrl: asset.browser_download_url,
      contentType: asset.content_type,
      updatedAt: asset.updated_at
    }))
  };
}

/**
 * Collecte les données d'UN dépôt (une seule fois, même s'il est listé dans
 * plusieurs catégories). Renvoie les données partagées, ou null si introuvable.
 */
async function fetchRepoData(rawUrl, cacheCandidate, nowIso) {
  const match = String(rawUrl || '').match(/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (!match) {
    console.warn(`URL GitHub invalide ignorée : ${rawUrl}`);
    ignored.push({ url: String(rawUrl), reason: 'URL GitHub invalide' });
    return null;
  }

  const owner = match[1];
  const repoName = match[2].replace(/\.git$/i, '');
  const repoBase = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
  const startedAt = Date.now();

  const repoData = await getJSON(repoBase);
  if (!repoData) {
    console.error(`Dépôt introuvable (404), ignoré : ${rawUrl}`);
    ignored.push({ url: String(rawUrl), reason: 'dépôt introuvable (404)' });
    return null;
  }

  const reuseCache = !FORCE_REFRESH
    && cacheCandidate
    && cacheCandidate.pushedAt === repoData.pushed_at
    && cacheCandidate.readmeFetchedAt;

  let readme;
  let recentCommits;
  let readmeFetchedAt;

  if (reuseCache) {
    readme = cacheCandidate.readme || '';
    recentCommits = Array.isArray(cacheCandidate.recentCommits) ? cacheCandidate.recentCommits : [];
    readmeFetchedAt = cacheCandidate.readmeFetchedAt;
    stats.cachedReadmes++;
  } else {
    readme = (await getText(`${repoBase}/readme`, 'application/vnd.github.raw+json').catch(() => null)) || '';
    recentCommits = toRecentCommits(await getJSON(`${repoBase}/commits?per_page=10`).catch(() => null));
    readmeFetchedAt = nowIso;
    stats.fetchedReadmes++;
  }

  let latestRelease = null;
  try {
    latestRelease = toLatestRelease(await getJSON(`${repoBase}/releases?per_page=1`));
  } catch (error) {
    console.warn(`-> Attention : Impossible de récupérer la release pour ${owner}/${repoName} (${error.message})`);
  }

  let hasNewCommitsAlert = false;
  if (recentCommits.length > 0 && recentCommits[0].date) {
    const lastCommitDate = new Date(recentCommits[0].date);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    hasNewCommitsAlert = lastCommitDate >= threeDaysAgo;
  }

  console.log(`[${reuseCache ? 'cache' : 'api  '}] ${repoData.full_name} (${Date.now() - startedAt} ms)`);

  return { owner, repoData, readme, readmeFetchedAt, recentCommits, latestRelease, hasNewCommitsAlert };
}

/** Construit l'entrée de sortie d'UNE ligne de config (catégorie, notes, id propres). */
function buildRepoEntry(shared, item, previousEntry, nowIso) {
  const { owner, repoData, readme, readmeFetchedAt, recentCommits, latestRelease, hasNewCommitsAlert } = shared;

  return {
    id: (previousEntry && previousEntry.id) || `repo-${Date.now()}-${++syntheticIdCounter}`,
    url: item.url,
    owner,
    ownerAvatar: repoData.owner ? repoData.owner.avatar_url : '',
    name: repoData.name,
    fullName: repoData.full_name,
    description: repoData.description || '',
    customNotes: item.customNotes || '',
    tags: item.tags || [],
    categoryId: item.categoryId || 'unassigned',
    stars: repoData.stargazers_count || 0,
    forks: repoData.forks_count || 0,
    openIssues: repoData.open_issues_count || 0,
    language: repoData.language || 'Unknown',
    license: repoData.license ? repoData.license.spdx_id || repoData.license.key : 'NOASSERTION',
    defaultBranch: repoData.default_branch || 'main',
    pushedAt: repoData.pushed_at,
    updatedAt: repoData.updated_at,
    htmlUrl: repoData.html_url,
    readme,
    readmeFetchedAt,
    autoSaveAssets: false,
    hasNewCommitsAlert,
    recentCommits,
    latestRelease,
    lastCheckedAt: nowIso
  };
}

async function mapWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  let completed = 0;

  async function drain() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        stats.failedGroups++;
        console.error(`Erreur critique pour le dépôt ${items[index].items[0].item.url}: ${error.message}`);
        results[index] = null;
      }
      completed++;
      if (completed % 50 === 0 || completed === items.length) {
        console.log(`Progression : ${completed}/${items.length} dépôts (${Math.round((Date.now() - startedTimestamp) / 1000)} s)`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, drain));
  return results;
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Fichier de configuration introuvable : ${CONFIG_PATH}`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const categories = config.categories || [];
  const inputRepos = config.repos || [];

  const nowIso = new Date().toISOString();
  const previousIndex = buildPreviousIndex(loadPreviousDatabase());
  const groups = groupConfigItems(inputRepos);

  console.log(
    `Traitement de ${groups.length} dépôts (${inputRepos.length} entrées, ${CONCURRENCY} requêtes simultanées`
    + `${FORCE_REFRESH ? ', cache ignoré' : ''})${TOKEN ? '' : ' — ATTENTION : aucun GITHUB_TOKEN, limite de 60 requêtes/heure'}`
  );

  const output = new Array(inputRepos.length).fill(null);

  await mapWithConcurrency(groups, async (group) => {
    const previousEntries = previousIndex.get(group.key) || [];
    const shared = await fetchRepoData(group.items[0].item.url, previousEntries[0] || null, nowIso);
    if (!shared) return;

    group.items.forEach(({ item, index }, occurrence) => {
      output[index] = buildRepoEntry(shared, item, previousEntries[occurrence] || null, nowIso);
    });
  }, CONCURRENCY);

  const processedRepos = output.filter(Boolean);

  const databaseOutput = {
    version: '2.0.0',
    exportedAt: nowIso,
    appName: 'PS5-Repository-List',
    categories,
    repos: processedRepos
  };

  const serialized = JSON.stringify(databaseOutput, null, 2);
  // Écriture atomique : jamais de JSON tronqué si le runner s'arrête en cours de route.
  const tempPath = `${OUTPUT_PATH}.tmp`;
  fs.writeFileSync(tempPath, serialized, 'utf8');
  fs.renameSync(tempPath, OUTPUT_PATH);

  const seconds = ((Date.now() - startedTimestamp) / 1000).toFixed(1);

  if (ignored.length > 0) {
    console.log(`Dépôts ignorés (${ignored.length}) :`);
    for (const entry of ignored.sort((a, b) => a.url.localeCompare(b.url))) {
      console.log(`  - ${entry.url} — ${entry.reason}`);
    }
  }

  console.log(
    `Succès ! Base de données générée dans ${OUTPUT_PATH} (${processedRepos.length} dépôts intégrés) `
    + `en ${seconds} s — ${stats.requests} requêtes GitHub, ${stats.cachedReadmes} README en cache, `
    + `${stats.fetchedReadmes} retéléchargés, ${stats.notFound} réponses 404, ${ignored.length} dépôts ignorés, `
    + `${stats.throttled} throttles, ${stats.retries} retries.`
  );
}

main().catch((error) => {
  console.error(`Échec de la génération : ${error.stack || error.message}`);
  process.exit(1);
});
