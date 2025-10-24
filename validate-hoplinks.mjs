#!/usr/bin/env node
/**
 * Digistore24 Hoplink Validator (+ opcional Set-Cookie)
 * v1.3.1  —  Node 18+
 *
 * Mantém exatamente o que já havia:
 *  - --live | --head | --dry
 *  - --cookies (mostra Set-Cookie do 1º hop)
 *  - mesma formatação de saída
 *
 * NOVO: confirmação do afiliado esperado (EXPECTED_AFFILIATE).
 *  - Checa no path (/redir/{product}/{affiliate}/)
 *  - Checa no header Location (?aff=)
 *  - (opcional) Heurística: procura o texto no Set-Cookie decodificado
 * Se não confirmar, muda o verdict para ALARM_AFFILIATE_MISMATCH.
 *
 * Exemplos:
 *   node validate-hoplinks.mjs --live https://www.digistore24.com/redir/568660/pzadvisors/
 *   node validate-hoplinks.mjs --live --cookies urls.txt
 *   node validate-hoplinks.mjs --head https://www.digistore24.com/redir/358077/pzadvisors/
 *   node validate-hoplinks.mjs --dry https://www.digistore24.com/redir/358077/pzadvisors/
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

// ---------------------------------------------------------
// CONFIG
// ---------------------------------------------------------
const UA = 'Mozilla/5.0 (Validator; PZ Advisors)';
const EXPECTED_AFFILIATE = 'pzadvisors'; // <- ajuste aqui se necessário

const isUrlLike = (s) => /^https?:\/\//i.test(String(s || '').trim());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowFile = basename(fileURLToPath(import.meta.url));

// args (MANTIDOS)
const args = process.argv.slice(2);
const wantsCookies = args.includes('--cookies');
const mode = args.find(a => a === '--dry' || a === '--head') || '--live';
const inputs = args.filter(a => !a.startsWith('--'));

if (inputs.length === 0) {
  console.log(`Usage:
  node ${nowFile} [--live|--head|--dry] [--cookies] <url1|fileWithUrls>

Flags:
  --live      GET com redirect manual (pode contar Promoclick)
  --head      HEAD com redirect manual (alguns produtos ainda contam clique)
  --dry       Sem rede: valida sintaxe/host
  --cookies   Mostra cabeçalhos Set-Cookie do primeiro hop
`);
  process.exit(0);
}

// util (MANTIDOS)
function color(s, c) {
  const map = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', reset: '\x1b[0m' };
  return `${map[c] || ''}${s}${map.reset}`;
}
function verdictColor(v) {
  if (/^OK/.test(v) || v === 'SYNTAX_OK' || v === 'OK_INTERMEDIATE') return 'green';
  if (/WARN/.test(v) || v === 'NOT_REDIR' || v === 'NOT_DIGISTORE') return 'yellow';
  return 'red';
}

// I/O (MANTIDO)
async function loadTargets(list) {
  const targets = [];
  for (const item of list) {
    if (existsSync(item)) {
      const raw = await fs.readFile(item, 'utf8');
      raw.split(/\r?\n/).forEach(line => {
        const t = line.trim();
        if (t && !t.startsWith('#')) targets.push(t);
      });
    } else {
      targets.push(item);
    }
  }
  return targets;
}

// Classificação (MANTIDA)
function classify(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname;
    const path = u.pathname.replace(/\/+$/, '');
    const isDigi = /(^|\.)digistore24\.com$/i.test(host);
    const isCheckoutAlt = /(^|\.)checkout-ds24\.com$/i.test(host);
    const parts = path.split('/').filter(Boolean);
    const looksRedir = parts[0] === 'redir' && parts.length >= 3;
    const productId = looksRedir ? parts[1] : null;
    const affiliateId = looksRedir ? parts[2] : null;
    return { host, path, isDigi, isCheckoutAlt, looksRedir, productId, affiliateId };
  } catch {
    return { error: 'invalid_url' };
  }
}

// Interpretação HTTP (MANTIDA)
function verdictFromHttp({ status, location, bodySnippet }) {
  const blockedText = /Redirect not possible|domain.*not trustworthy|DSB-\d+/i.test(bodySnippet || '');
  if (status >= 500) return { verdict: 'ERROR_5XX', note: 'Server error at redir' };
  if (blockedText) return { verdict: 'BLOCKED_DOMAIN', note: 'DSB/blocked destination' };
  if (status >= 400) return { verdict: 'ERROR_4XX', note: 'Client error at redir' };
  if (status >= 300 && status < 400) {
    if (!location) return { verdict: 'WARN_NO_LOCATION', note: '3xx without Location' };
    try {
      const loc = new URL(location);
      const destHost = loc.hostname;
      const destIsDigi = /digistore24\.com$/i.test(destHost) || /checkout-ds24\.com$/i.test(destHost);
      return {
        verdict: destIsDigi ? 'OK_INTERMEDIATE' : 'OK_REDIRECT',
        note: destIsDigi ? `Intermediate to ${destHost}` : `Redirect to ${destHost}`
      };
    } catch {
      return { verdict: 'WARN_BAD_LOCATION', note: 'Invalid Location header' };
    }
  }
  if (status >= 200 && status < 300) {
    if (blockedText) return { verdict: 'BLOCKED_DOMAIN', note: 'DSB/blocked (200 body)' };
    return { verdict: 'WARN_200_BODY', note: '200 at redir (unexpected)' };
  }
  return { verdict: 'UNKNOWN', note: `Status ${status}` };
}

// ---------- NOVO: confirmação do afiliado (mínima, sem alterar o resto) ----------
const urlDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

function confirmAffiliate(meta, location, setCookies) {
  // 1) Path do hoplink
  if (meta?.affiliateId && meta.affiliateId.toLowerCase() === EXPECTED_AFFILIATE.toLowerCase()) {
    return { ok: true, reason: 'path_affiliate' };
  }
  // 2) Query no Location (?aff=)
  if (location) {
    try {
      const lu = new URL(location, 'https://www.digistore24.com');
      const aff = (lu.searchParams.get('aff') || '').toLowerCase();
      if (aff === EXPECTED_AFFILIATE.toLowerCase()) return { ok: true, reason: 'location_aff_query' };
    } catch { /* ignore */ }
    if (location.toLowerCase().includes(`aff=${EXPECTED_AFFILIATE.toLowerCase()}`)) {
      return { ok: true, reason: 'location_text' };
    }
  }
  // 3) Heurística: procurar o texto no Set-Cookie decodificado (quando --cookies)
  if (Array.isArray(setCookies) && setCookies.length) {
    const needle = EXPECTED_AFFILIATE.toLowerCase();
    for (const sc of setCookies) {
      if (urlDecode(sc).toLowerCase().includes(needle)) {
        return { ok: true, reason: 'setcookie_contains_affiliate' };
      }
    }
  }
  return { ok: false, reason: 'not_confirmed' };
}

// Probe (MANTIDO + check de afiliado)
async function probe(urlStr, mode) {
  const meta = classify(urlStr);
  if (meta.error) return { url: urlStr, verdict: 'INVALID_URL', note: 'Invalid URL' };
  if (!meta.isDigi && !meta.isCheckoutAlt) return { url: urlStr, verdict: 'NOT_DIGISTORE', note: 'Not a Digistore24 host' };
  if (!meta.looksRedir) return { url: urlStr, verdict: 'NOT_REDIR', note: 'Missing /redir/{product}/{affiliate}/' };

  if (mode === '--dry') {
    const confirmedByPath = meta.affiliateId && meta.affiliateId.toLowerCase() === EXPECTED_AFFILIATE.toLowerCase();
    return { url: urlStr, verdict: 'SYNTAX_OK', note: `product=${meta.productId}, affiliate=${meta.affiliateId}` + (confirmedByPath ? ' | Affiliate confirmed (path)' : ' | Affiliate NOT confirmed'), affiliate_confirmed: confirmedByPath };
  }

  const method = (mode === '--head') ? 'HEAD' : 'GET';
  try {
    const res = await fetch(urlStr, {
      method,
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }
    });

    // Coleta Set-Cookie (se solicitado)
    let setCookies = [];
    if (wantsCookies) {
      const any = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (Array.isArray(any) && any.length) setCookies = any;
      else {
        const single = res.headers.get('set-cookie');
        if (single) setCookies = [single];
      }
    }

    let bodySnippet = '';
    const ct = res.headers.get('content-type') || '';
    if (method === 'GET' && /text\/html/i.test(ct)) {
      try { bodySnippet = (await res.text()).slice(0, 4000); } catch {}
    }
    const location = res.headers.get('location') || '';

    const v = verdictFromHttp({ status: res.status, location, bodySnippet });

    // (MANTIDO) Heurística de cookies úteis
    if (wantsCookies && setCookies.length) {
      const cookieSignals = [];
      for (const c of setCookies) {
        if (/pro_\d+=/i.test(c)) cookieSignals.push('pro_*');
        if (new RegExp(`fc_clicked_${meta.productId}\\[initial\\]=`, 'i').test(c)) {
          cookieSignals.push(`fc_clicked_${meta.productId}[initial]`);
        }
      }
      if (cookieSignals.length && !v.verdict.startsWith('ERROR')) {
        v.note += (v.note ? ' | ' : '') + `Set-Cookie: ${[...new Set(cookieSignals)].join(', ')}`;
      }
    }

    // (NOVO) Confirma afiliado esperado
    const aff = confirmAffiliate(meta, location, setCookies);
    const affiliate_confirmed = aff.ok;
    let finalVerdict = v.verdict;
    let finalNote = (v.note || '');
    finalNote += (finalNote ? ' | ' : '') + (affiliate_confirmed
      ? `Affiliate confirmed (${aff.reason})`
      : `Affiliate not confirmed as "${EXPECTED_AFFILIATE}"`);

    if (!affiliate_confirmed) {
      finalVerdict = 'ALARM_AFFILIATE_MISMATCH';
    }

    return {
      url: urlStr,
      status: res.status,
      location: location || '',
      affiliate_confirmed,
      ...(wantsCookies ? { setCookies } : {}),
      verdict: finalVerdict,
      note: finalNote
    };
  } catch (e) {
    return { url: urlStr, verdict: 'NETWORK_ERROR', note: e.message || 'Network error' };
  }
}

// Runner (MANTIDO)
(async () => {
  const list = await loadTargets(inputs);
  const results = [];

  for (const u of list) {
    const target = isUrlLike(u) ? u : null;
    if (!target) {
      console.log(color(`Skipping non-URL entry: ${u}`, 'yellow'));
      continue;
    }
    const r = await probe(target, mode);
    results.push(r);
    await sleep(150); // rate-limit leve
  }

  // Print (MANTIDO)
  console.log(`\nMode: ${mode.replace('--', '')}${wantsCookies ? ' + cookies' : ''} | expecting affiliate="${EXPECTED_AFFILIATE}"\n`);
  console.log('Result'.padEnd(18), 'Status'.padEnd(7), 'Verdict'.padEnd(28), 'Note');
  console.log('-'.repeat(120));
  for (const r of results) {
    const vcol = verdictColor(r.verdict);
    console.log(
      (r.url || '').slice(0, 60).padEnd(18),
      String(r.status || '').padEnd(7),
      color((r.verdict || '').padEnd(28), vcol),
      r.note || '',
      r.location ? `→ ${r.location}` : ''
    );
    if (wantsCookies && r.setCookies?.length) {
      for (const sc of r.setCookies) {
        console.log(' '.repeat(18), ' '.repeat(7), ' '.repeat(28), color('Set-Cookie:', 'yellow'), sc.split(';')[0]);
      }
    }
  }

  const hasBad = results.some(r =>
    ['INVALID_URL','NETWORK_ERROR','ERROR_4XX','ERROR_5XX','BLOCKED_DOMAIN','ALARM_AFFILIATE_MISMATCH'].includes(r.verdict)
  );
  if (hasBad) {
    console.log('\n' + color('ALARM: one or more checks failed (errors or affiliate mismatch).', 'red'));
  }
  process.exit(hasBad ? 1 : 0);
})();