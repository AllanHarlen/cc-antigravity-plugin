# Changelog

Todas as mudancas notaveis deste plugin sao documentadas aqui.

## [Unreleased] - Correcoes da revisao cruzada workflow/plugins (2026-09-04)

Revisao que cruzou `WORKFLOW.md` com o codigo dos seis plugins encontrou uma serie de bugs de
runtime nesta bridge, alem do item ja identificado no backlog (catalogo de fallback desatualizado
para Gemini 3.8).

- `scripts/antigravity-bridge.js` (`FALLBACK_MODEL_CATALOG`): adicionada a familia
  `gemini-3.8-flash-{low,medium,high}`, ausente desde o lancamento desses modelos. Removido
  `CANONICAL_MODELS`, export morto sem nenhuma referencia no plugin.
- `scripts/antigravity-bridge.js` (`parseTimeoutMs`): passa a aceitar duracoes compostas
  (`5m30s`, `1h2m3s`), nao so unidade unica; antes caia silenciosamente para o timeout default de
  10 min em qualquer combinacao.
- `scripts/antigravity-bridge.js` (`spawnViaConPty`): adicionado guard `settled` — um chunk de PTY
  chegando apos o timeout/exit ja ter resolvido a promise reagmava um timer de 10 min, mantendo o
  event loop vivo sem necessidade para quem chama `main()` como biblioteca (os proprios testes).
- `scripts/antigravity-bridge.js`: `child.kill()`/`term.kill()` agora tentam `taskkill /pid <pid>
  /T /F` no Windows antes do kill direto — o SIGTERM default so alcancava o processo filho
  imediato, deixando netos orfaos (subprocessos de ferramenta do proprio `agy`) em timeout de run
  longa.
- `scripts/utils.js` (`logEvent`): `mkdirSync` memoizado por diretorio (era chamado a cada evento)
  e retencao de 14 dias nos logs JSONL, que antes cresciam sem limite.
- `tests/utils.test.js` (novo): primeira cobertura de `scripts/utils.js`, ate entao com cobertura
  zero nas duas bridges.
- `tests/antigravity-bridge.test.js`: o teste de drift `agy models` vs. `FALLBACK_MODEL_CATALOG`
  passa a exigir `AGY_LIVE=1` — antes rodava sempre, custando ~5s de chamada de rede real em todo
  `npm test` e ficando vermelho silenciosamente em qualquer maquina com `agy` mais novo que o
  catalogo.
