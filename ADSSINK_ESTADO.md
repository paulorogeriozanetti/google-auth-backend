# AdsSink — estado desta branch

_Branch: `feat/adssink` · criada de `main@1a74f31` · 2026-07-26_

## Porque é que esta branch existe

Este código estava escrito e **duplamente aprovado (R1+R2)** mas existia apenas no workspace
efémero do agente. Esta branch é a **persistência** desse trabalho — não é um pedido de merge
e não representa nada que esteja em produção.

**Nada aqui está deployed.** O Railway faz deploy de `main`; esta branch não o toca.

## Artefactos

| Ficheiro | Versão | Estado de revisão |
|---|---|---|
| `AdsSink.js` | **2.1.0** | ✅ R1 + R2 aprovado |
| `ConvMapLoaderCsv.js` | **2.1.0** | ✅ R1 + R2 aprovado |
| `ConsentResolver.js` | **1.0.0** | ✅ R1 + R2 aprovado |
| `adssink_csv/pz_conversion_map.csv` | 14 col, sep `;` | desenhado, **não escrito em produção** |
| `adssink_csv/pz_conversion_map_PROPOSTA*.csv` | — | proposta + backup |

Os CSVs vivem aqui só para não se perderem. O CSV de produção é servido a partir do repo
`pza-frontend` — ver `CSV_GOVERNANCE.md` no knowledge base.

> **Correcção de versão — 2026-07-26.** Esta tabela declarava `2.2.0` para `AdsSink.js` e
> `ConvMapLoaderCsv.js`, e `—` para `ConsentResolver.js`. Os números reais, lidos dos cabeçalhos
> dos próprios ficheiros e confirmados em runtime (`[ConvMapLoaderCsv v2.1.0]`), são **2.1.0**,
> **2.1.0** e **1.0.0**. O `2.2.0` nunca existiu — foi propagado pelos docs (e pelo agente).
> Decisão do Paulo: **corrigir os docs, não fazer bump do ficheiro.** O código não mudou.

## Cobertura do bridge — divergência produção vs PROPOSTA

O CSV de produção e a PROPOSTA não cobrem as mesmas páginas. Por `conversion_action_id`:

| ctId | Produção | PROPOSTA |
|---|---|---|
| 7697484643 | purchase digistore24 | purchase digistore24 + clickbank + mediascalers |
| 7697484646 | page view **presell** | page view **presell** *e* **lander-white** (colapsados) |
| 7697484649 | page view **bridge** | — sem linha (**órfão**) |
| 7697484652 | page view **lander** (inactive) | — sem linha (**órfão**) |
| 7697484655 | checkout_click em **qualquer** page_type (`*`) | checkout_click só em **presell** e **lander-white** |

Três consequências, graduadas:

1. **Exclusão do bridge no `checkout_click` — deliberada e documentada.** A própria linha da
   PROPOSTA justifica: o checkout interno é mera passagem e dispara um segundo `checkout_click`;
   sem a restrição havia duplo registo por utilizador. **Não é defeito.**
2. **Remoção do page view do bridge — não documentada.** Órfã os ctIds `7697484649` e
   `7697484652`, que ficam sem qualquer linha que os alimente. **É lacuna real.**
3. **Colapso de `presell` + `lander-white` no mesmo ctId `7697484646`** — dispara duas vezes por
   jornada. Impacto contido ao *reporting*: só `pz_purchase` é Primary e os Gates lêem BigQuery,
   não o Ads. Ainda assim, **verificar a definição de contagem** (One vs Every) dessa acção.

**Decisão do Paulo, 2026-07-26 — opção (c) + separação das páginas.** Resolvida em
`adssink_csv/pz_conversion_map_v3.csv` (8 linhas, 14 colunas, `isValid()===true` verificado
por execução do `ConvMapLoaderCsv` real):

| ctId | v3 |
|---|---|
| 7697484643 | purchase digistore24 + clickbank + **mediascalers (nasce activa)** |
| 7697484646 | page view **presell** |
| 7697484649 | page view **bridge** — reintroduzida |
| 7697484652 | page view **lander-white** — separada da presell |
| 7697484655 | checkout_click em **lander-white** e **presell** (bridge excluída, deliberado) |

Zero ctIds órfãos. A separação lander/presell elimina o duplo disparo por jornada.
Justificação: hoje as duas páginas têm a mesma função no funil, mas podem divergir — manter
acções distintas custa nada e preserva a opção.

**Este ficheiro ainda NÃO está em produção.** Falta o upload — ver nota do `attachment_id` abaixo.

⚠️ `conversion_action_name` é **decorativo** — o loader indexa por `conversion_action_id`. As três
fontes discordam nos nomes do mesmo ctId (ex.: `7697484646` = `pz_view_offer` no PROJECTS.md,
`pz_presell_view` em produção, `pz_view_item` na PROPOSTA). Inofensivo, mas enganador.

## O que falta antes de isto poder ir para `main`

1. **`google-ads-api` não está no `package.json`.** Confirmado por leitura directa de
   `package.json@main` (sha `fcfa254c…`) em 2026-07-26. Tem de entrar no commit de merge.
   *Alternativa de emergência:* `axios` + `google-auth-library` já estão instaladas e permitem
   chamar a REST `customers/{id}:uploadClickConversions` sem a dependência gRPC — mas isso é
   um delta de código e implica nova revisão.
2. **`PZ_ADSSINK_ENABLED=false`** deve estar definido no Railway *antes* do merge, para o código
   entrar passivo.
3. **PEND-03 — filtro de rebill.** O nome real do campo do postback (`pay_sequence_no <= 1`?)
   ainda não foi confirmado contra um postback real. **Inventar o nome do campo é proibido.**
4. **Duplicidade de conversion actions** — `purchase` vs `pz_purchase`,
   `checkout_click` vs `pz_begin_checkout`. Decisão adiada para o momento do deploy.
5. **Validação ponta-a-ponta** exige a primeira venda real (`n_s2s_purchase = 0` à data).

## Acesso à Google Ads API — verificado 2026-07-26

Developer token no API Center da MCC `440-410-8297`: **Explorer Access**.
Explorer opera contra contas de **produção**, com **2.880 operações/dia**.
O volume previsto é <100/dia. `ConversionUploadService` não consta da lista de serviços
restritos em Explorer (a doc restringe criação de contas, gestão de utilizadores, serviços de
planeamento e faturação).

⚠️ Isto é inferência por exclusão — a doc não afirma explicitamente que o serviço é permitido.
A primeira chamada real confirma ou devolve `AuthorizationError`, sem efeito colateral.

O pedido de **Basic Access** (caso `1-4203000040869`) foi rejeitado e continua em aberto,
mas **não bloqueia** — só passa a ser necessário acima de 2.880 ops/dia.

## Consent Mode

Todas as linhas nascem `consent_passthrough=disabled`. **O transporte não existe**:
`ad_user_data` / `ad_personalization` nunca chegam ao backend. Activar uma linha sem transporte
seria declarar ao Google um consentimento que não foi verificado.

## Gate de produção do `pz_conversion_map.csv` (2026-07-26)

O CSV de produção é servido de `pzadvisors.com/wp-content/uploads/2026/07/pz_conversion_map.csv`.
Ao contrário dos 7 CSVs do CSV_GOVERNANCE, **este ficheiro não tem `attachment_id`**: nunca foi
substituído via Enable Media Replace. Um primeiro upload cria um item de Media novo e o
WordPress pode renomear (`pz_conversion_map-1.csv`) ou colocar noutra pasta de mês. Se o URL
não bater certo, o loader recebe 404, marca o mapa inválido e o AdsSink fica no-op — **falha
silenciosa mas segura**. Verificar o URL final depois do upload, antes de ligar seja o que for.

## Auditoria Fase 5 — CSV_GOVERNANCE (2026-07-26)

Comparação por sha256 das 3 fontes dos 7 CSVs governados: **GitHub ≡ WordPress em 7/7**
(as 2 divergências de 1 byte são só o `\n` final). A cópia local Windows estava desactualizada
em 4 ficheiros — `pz_api_config`, `pz_pages_config`, `pz_solution_map`, `pz_offer_map` — todos
parados antes do rollout Jetterix/MediaScalers.

Double-check por data confirmou a causa: o commit `81153b6` (2026-07-24, *"backup byte-exacto
da producao"*) mostra que o GitHub é espelho da produção, e os `last-modified` do WordPress
mostram que exactamente esses 4 ficheiros foram alterados no lote de 19-07-2026 16:12–16:25 GMT.
Os 3 que batiam localmente foram alterados antes (18-07, 26-06, 02-06). Reconciliados a partir
da produção em 2026-07-26, com backups `_bak_2026-07-26` na pasta local.

⚠️ **`CSV_GOVERNANCE.md` v4.0 está desactualizado:** documenta `pz_pages_config` com 9 colunas
quando o ficheiro real tem 14 (`flow_mode` incluída) e omite `/dg/circo2-vsl`, `/norev-method`
e `/jetterix-us`. Foi precisamente uma referência documental desactualizada que partiu o
`/bridge` em 2026-05-12.
