/**
 * PZ Advisors - Platform Adapter Base / Factory
 * Versão: 1.1.4
 * Data: 2025-10-24
 * Desc: Incorpora correções do quarto duplo check (reforço de segurança e consistência).
 * - REFORÇO CRÍTICO: Torna a função `safeLog` recursiva para mascarar
 * dados sensíveis em qualquer nível de aninhamento.
 * - Mantém toda a robustez da v1.1.3.
 */
class PlatformAdapterBase {
    /**
     * @param {string} platformName Nome da plataforma (ex: 'digistore24', 'clickbank')
     * @returns {PlatformAdapterBase} Instância do adapter específico.
     * @throws {Error} Se a plataforma não for suportada ou o adapter não implementar a interface.
     */
    static getInstance(platformName) {
        if (!platformName) {
            throw new Error('[AdapterFactory] Nome da plataforma é obrigatório.');
        }

        const platform = String(platformName).toLowerCase();
        let AdapterClass;

        try {
            switch (platform) {
                case 'digistore24':
                    AdapterClass = require('./Digistore24Adapter');
                    break;
                case 'clickbank':
                    AdapterClass = require('./ClickbankAdapter');
                    break;
                // Adicione outros casos aqui
                default:
                    console.warn(`[AdapterFactory v1.1.4] Plataforma não suportada: ${platformName}`);
                    throw new Error(`Plataforma não suportada: ${platformName}`);
            }

            const instance = new AdapterClass();

            // Enforcement mínimo de "interface" em runtime
            const requiredMethods = ['buildCheckoutUrl', 'verifyWebhook'];
            requiredMethods.forEach((methodName) => {
                if (typeof instance[methodName] !== 'function') {
                    throw new Error(`Adapter ${platformName} não implementa o método obrigatório: ${methodName}()`);
                }
            });

            // Adiciona metadados para logging/identificação
            instance.__meta = instance.__meta || { platform, version: instance.version || '1.1.4' }; // Usa a versão do adapter ou a desta base

            console.log(`[AdapterFactory v1.1.4] Instância criada para: ${platformName} (Versão: ${instance.__meta.version})`);
            return instance;

        } catch (error) {
            console.error(`[AdapterFactory v1.1.4] Falha ao instanciar adapter ${platformName}:`, error?.message || error);
            throw error;
        }
    }

    // --- Métodos "Abstratos" (Interface Esperada) ---

    async buildCheckoutUrl(offerData, trackingParams) {
        console.error(`[PlatformAdapterBase] Método buildCheckoutUrl não implementado para a plataforma ${this.__meta?.platform}`);
        throw new Error('Método abstrato não implementado: buildCheckoutUrl');
    }

    async verifyWebhook(requestPayload, requestHeaders) {
        console.error(`[PlatformAdapterBase] Método verifyWebhook não implementado para a plataforma ${this.__meta?.platform}`);
        throw new Error('Método abstrato não implementado: verifyWebhook');
    }

    // --- Helper de Logging ---

    /**
     * Helper APENAS para logging seguro (remove/mascara dados sensíveis ANTES de logar).
     * v1.1.4: Implementa sanitização recursiva (patch do duplo check).
     */
    safeLog(obj = {}, sensitiveKeys = ['email','customerEmail','receipt','orderId','transactionId','auth_key','password','key','secret']) {
      try {
        const mask = (s) => (typeof s === 'string' && s.length > 3 ? s.slice(0,3) + '***' + s.slice(-3) : '***');
        const SENSITIVE_KEYS_SET = new Set(sensitiveKeys.map(k => String(k).toLowerCase()));
        // headers sensíveis
        ['authorization','cookie','set-cookie'].forEach(k => SENSITIVE_KEYS_SET.add(k));

        // Função recursiva de sanitização (patch v1.1.4)
        const scrub = (value, kPath = []) => {
          // kPath é usado para rastrear a "profundidade" e a chave pai, se necessário
          // A chave atual (última em kPath) é a mais relevante
          const lastKey = kPath.length ? String(kPath[kPath.length - 1]).toLowerCase() : '';

          // 1. Tipos primitivos ou nulos
          if (value === null || value === undefined) return value;
          
          // 2. Tipos de objetos especiais (não iteráveis)
          if (Buffer.isBuffer(value)) return '<Buffer: hidden>';
          if (value instanceof Date) return value.toISOString();

          // 3. Se não for um objeto (string, number, boolean)
          if (typeof value !== 'object') {
            // Mascara se a *chave* (lastKey) for sensível
            return SENSITIVE_KEYS_SET.has(lastKey) ? mask(String(value)) : value;
          }

          // 4. Remover payloads/bodies (se a chave *contém* a palavra)
          if (lastKey.includes('payload') || lastKey.includes('body')) {
            return typeof value === 'string' ? mask(value) : '<removed>';
          }
          
          // 5. Se for Array, aplica recursivamente
          if (Array.isArray(value)) {
            return value.map((item, idx) => scrub(item, kPath.concat(idx)));
          }

          // 6. Se for um Objeto Simples, aplica recursivamente
          const sanitizedObject = {};
          for (const [k, v] of Object.entries(value)) {
            const keyLower = String(k).toLowerCase();
            if (SENSITIVE_KEYS_SET.has(keyLower)) {
                sanitizedObject[k] = mask(typeof v === 'string' ? v : '***');
            } else if (keyLower.includes('payload') || keyLower.includes('body')) {
                sanitizedObject[k] = typeof v === 'string' ? mask(v) : '<removed>';
            } else {
                sanitizedObject[k] = scrub(v, kPath.concat(k)); // Chamada recursiva
            }
          }
          return sanitizedObject;
        };

        // Clona profundamente para evitar mutar o original e aplica a sanitização
        const clonedObj = JSON.parse(JSON.stringify(obj));
        return scrub(clonedObj); // Inicia a recursão

      } catch (e) {
        console.error('[safeLog v1.1.4] Erro ao sanitizar log:', e);
        return { error: 'Falha ao sanitizar log', originalType: typeof obj };
      }
    }
}

module.exports = PlatformAdapterBase;