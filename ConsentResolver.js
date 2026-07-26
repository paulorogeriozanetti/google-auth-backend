/**
 * PZ Advisors — ConsentResolver
 * Versão: v1.0.0
 * Data: 2026-07-25
 *
 * Descrição:
 * - Isola TODA a lógica de consentimento do AdsSink numa única costura.
 * - Decisão do proprietário (2026-07-25): construir o AdsSink já a prever a
 *   recepção do sinal; o FLUXO do sinal (captura no CookieYes → persistência
 *   no FirebaseSink → propagação no postback) será construído depois.
 *
 * ESTADO DE FACTO EM 2026-07-25 (verificado em código, não presumido):
 *   - firebase_head.js usa consentimento apenas como PORTÃO DE ENVIO
 *     (PZ_CONSENT_REQUIRED / PZ_CONSENT_OK / listener cookie_consent_update).
 *     Nunca o escreve como VALOR no payload.
 *   - O backend inteiro não tem uma única ocorrência de consent/ad_user_data/
 *     ad_personalization. O FirebaseSink não grava; o postback não recebe.
 *   => readSignal() devolve null hoje, SEMPRE. É o comportamento esperado.
 *      Quando os saltos 1–3 do plano v8 §6 existirem, este ficheiro passa a
 *      encontrar o snapshot e nada mais no AdsSink precisa de mudar.
 *
 * Contrato de entrada do sinal (o que os saltos 1–3 têm de produzir):
 *   tx.consent = {
 *     ad_user_data:       'GRANTED' | 'DENIED' | 'UNSPECIFIED',
 *     ad_personalization: 'GRANTED' | 'DENIED' | 'UNSPECIFIED',
 *     source:             'cookieyes' | 'gcm' | ...,
 *     captured_at:        ISO-8601 do INSTANTE DO CLIQUE (não do postback)
 *   }
 * Aceita também a forma achatada (consent_ad_user_data / consent_ad_personalization)
 * para não obrigar a decidir já a forma final da escrita.
 */

const VALID = new Set(['GRANTED', 'DENIED', 'UNSPECIFIED']);

// Contadores de observabilidade. O risco maior desta fase é o silêncio:
// o caminho `enabled` degenerar em fallback sem ninguém reparar.
const counters = {
  resolved_total: 0,
  signal_present: 0,
  signal_absent: 0,
  fallback_used: 0,
  passthrough_disabled: 0,
  signal_invalid: 0,
};

let warnedNoSignal = false;

function _norm(v) {
  const s = String(v ?? '').trim().toUpperCase();
  return VALID.has(s) ? s : null;
}

/**
 * Lê o snapshot de consentimento do documento da transacção.
 * @returns {{ad_user_data:string, ad_personalization:string, source:string|null, captured_at:string|null}|null}
 */
function readSignal(tx) {
  if (!tx || typeof tx !== 'object') return null;

  const nested = tx.consent && typeof tx.consent === 'object' ? tx.consent : null;

  const aud = _norm(nested?.ad_user_data ?? tx.consent_ad_user_data);
  const adp = _norm(nested?.ad_personalization ?? tx.consent_ad_personalization);

  // Exige os DOIS sinais. Meio sinal não é sinal — seria enviar um campo real
  // e outro inventado dentro do mesmo ClickConversion.
  if (!aud || !adp) return null;

  return {
    ad_user_data: aud,
    ad_personalization: adp,
    source: nested?.source ?? tx.consent_source ?? null,
    captured_at: nested?.captured_at ?? tx.consent_captured_at ?? null,
  };
}

/**
 * Resolve o consentimento final a enviar no ClickConversion.
 *
 * Regra (adenda v7.3, inalterada):
 *   passthrough=enabled E sinal presente  → valor real do CMP
 *   caso contrário                        → consent_fallback do CSV
 *
 * @param {{tx:object, mapRow:object}} args
 * @returns {{adUserData:string, adPersonalization:string, source:string, signalPresent:boolean, reason:string}}
 */
function resolve({ tx, mapRow }) {
  counters.resolved_total++;

  const passthrough = String(mapRow?.consent_passthrough || 'disabled').toLowerCase();
  const fallback = String(mapRow?.consent_fallback || 'UNSPECIFIED').toUpperCase();

  const signal = readSignal(tx);

  if (signal) counters.signal_present++;
  else counters.signal_absent++;

  if (passthrough !== 'enabled') {
    counters.passthrough_disabled++;
    counters.fallback_used++;
    return {
      adUserData: fallback,
      adPersonalization: fallback,
      source: 'csv_fallback',
      signalPresent: !!signal,
      reason: 'passthrough_disabled',
    };
  }

  if (!signal) {
    counters.fallback_used++;
    // Um aviso por processo. Isto é o alarme contra o silêncio: se aparecer em
    // produção, significa que se declarou `enabled` sobre um caminho inexistente.
    if (!warnedNoSignal) {
      warnedNoSignal = true;
      console.warn(
        '[ConsentResolver] consent_passthrough=enabled mas NENHUM sinal de consentimento ' +
        'encontrado na transacção. A degradar para consent_fallback. ' +
        'O fluxo do sinal (v8 §6, saltos 1–3) ainda não está construído.'
      );
    }
    return {
      adUserData: fallback,
      adPersonalization: fallback,
      source: 'csv_fallback',
      signalPresent: false,
      reason: 'signal_absent',
    };
  }

  return {
    adUserData: signal.ad_user_data,
    adPersonalization: signal.ad_personalization,
    source: signal.source ? `cmp:${signal.source}` : 'cmp',
    signalPresent: true,
    reason: 'passthrough',
  };
}

/** Snapshot dos contadores (para healthcheck / relatório diário). */
function getCounters() {
  return { ...counters };
}

/** True quando já se resolveu algo e NUNCA houve sinal — sintoma de fluxo por construir. */
function isSignalFlowDead() {
  return counters.resolved_total > 0 && counters.signal_present === 0;
}

module.exports = { readSignal, resolve, getCounters, isSignalFlowDead };
