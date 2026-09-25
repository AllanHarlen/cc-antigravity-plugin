# Changelog

Todas as mudancas notaveis deste plugin sao documentadas aqui.

## [4.5.0] - 2026-09-25 - `components.css` no `--design-system` e review read-only sem `run_command`

- `--design-system`: `components.css` entra em `DESIGN_SYSTEM_CORE_FILES` (logo depois de `tokens.css`) e vai inteiro no prompt, fora de `--max-files`/`--max-file-bytes`. O bloco `<design_system>` instrui a importar essa folha depois de `tokens.css` e a nunca copiar o CSS do preview nem as classes de andaime de `components.html`. Motivo: numa run real (OficinaAI, 2026-09-22) Button/Card/Input/Dialog chegaram ao build final sem estilo porque as regras de componente so existiam no preview; o cc-pensador 2.38.0 passa a gerar `components.css`.
- `--read-only`: o prompt deixa de oferecer `run_command` "somente leitura". Em execucao headless o AGY nega automaticamente a permissao `command`, e a chamada abortava a analise sem saida (review de front-end da mesma run). A inspecao fica restrita a `grep_search`, `view_file` e `list_dir`.
- Testes: fixture de pacote de design com `components.css` na ordem dos arquivos centrais; prompt read-only sem `run_command`.

## [4.4.2] - 2026-09-24 - `--read-only` headless: flag honrada e resposta vazia nunca e sucesso

Motivacao: numa run real do Orquestrador (OficinaAI, 2026-09-22), tres tentativas de review de
front-end em `--read-only` falharam de formas diferentes e o bloqueio so foi diagnosticado
lendo o log de eventos do bridge linha a linha.

- `--read-only` combinado com `--disable-slash-commands` explicito descartava a flag em silencio
  (o bloco de enforcamento de `--read-only` sempre forcava `disableSlashCommands = false`). O AGY
  entao expandiu `--mode plan` como se o usuario tivesse digitado o slash command `/plan` sem
  argumento, e a task de review nunca rodou de fato. A flag explicita agora sobrevive; o default
  (sem flag) continua sendo `false`, preservando a mitigacao documentada do bug do AGY 1.1.16.
- A deteccao de `EMPTY_RESPONSE` (resposta vazia + exit 0 do agy nunca e sucesso silencioso) so
  rodava com `--output-file`. Chamando o bridge com redirecionamento de stdout simples (`> arquivo`,
  o padrao documentado em `subagent-prompts.md` e o que a run real usou) uma negacao de ferramenta
  do AGY em headless read-only (`jetski: no output produced ... auto-denied`) resultava em stdout
  vazio e exit 0 sem nenhum diagnostico — um falso "review passou". A checagem agora vale para
  qualquer destino de saida.
- 5 testes novos cobrindo os dois casos, incluindo o texto de erro real do AGY. Suite completa:
  173/173.

## [4.4.0] - 2026-09-13 - Contexto sem descarte: stdin em qualquer plataforma e `--design-system`

Motivacao: numa run real do Orquestrador (12/09) o bridge 4.2.1 descartou os 40 arquivos do
pacote de design (`max-files-exceeded` + `prompt-overflow-windows`, `included: []`) e o AGY so
leu `tokens.css`/`components.html`/`DESIGN.md` quando decidiu por conta propria, e de forma
irregular. A 4.3.0 ja fazia stream via stdin, mas nunca chegou a ser instalada: `plugin.json` e
`marketplace.json` ficaram em 4.2.x.

- Stdin validado ponta a ponta no AGY 1.2.2: prompt de 97.315 chars enviado sem `--print`, lido
  ate a ultima linha (`input_tokens` 48.556), sem uso de ferramentas.
- `resolvePromptTransport()`: todo prompt headless acima do tamanho seguro de argv vai por stdin —
  8.191 chars no Windows, 100.000 nos demais (abaixo do `MAX_ARG_STRLEN` de 131.072 bytes do
  Linux). `--print-command`/`--dump-prompt` passam a refletir o transporte real. So
  `--interactive` continua em argv.
- `fitContextToPromptBudget()`: no `--interactive` que estoura o limite do Windows, descarta os
  arquivos de menor prioridade um por vez (antes descartava todos de uma vez).
- `--design-system <dir,...>`: inclui na integra, antes e fora de `--max-files`/`--max-file-bytes`,
  os arquivos centrais do pacote Open Design (`design-contract.json`, `DESIGN.md`, `tokens.css`,
  `components.html`, `USAGE.md`, `components.manifest.json`, `assets/manifest.json`), usando
  `<dir>/resolved` quando existe. Os demais arquivos do pacote entram no inventario como
  `design-system-on-demand`; duplicatas vindas de `--dirs` sao removidas. Diretorio que nao e
  pacote Open Design falha com erro explicito.
- Bloco `<design_system>` no prompt: pacote autoritativo, sem inventar tokens, e o nome do pacote
  tratado como proveniencia, nunca como marca do produto (na run, o nome do system foi parar no
  header da aplicacao). Sem `--design-system`, o prompt fica byte a byte igual.
- Sidecar do `--dump-prompt`: novos campos `transport` e `designSystems`; `included` passa a listar
  o que realmente foi enviado mesmo quando ha descarte.
- `spawnHeadless`: erro de escrita no stdin (agy encerrando cedo) vai para o log em vez de derrubar
  o bridge antes da classificacao de saida.
- Versao 4.4.0 alinhada em `package.json`, `.claude-plugin/plugin.json` e
  `.claude-plugin/marketplace.json`.

## [4.3.0] - 2026-09-12 - Suporte a streaming de prompts via stdin e mitigação de overflow no Windows

- `scripts/antigravity-bridge.js`: adicionadas as opções `--prompt-file` e `--use-stdin` / `--stdin`.
- `scripts/antigravity-bridge.js` (`spawnHeadless`): quando `useStdin` ou prompt no Windows > 8.191 chars é detectado, omite o argumento `--print <prompt>` da linha de comando e faz o stream direto dos chunks do prompt via `child.stdin`.
- Elimina completamente o descarte de arquivos e degradação de contexto (`prompt-overflow-windows`) no Windows, contornando com segurança o limite de argv do `CreateProcess`.
- `tests/antigravity-bridge.test.js`: testes unitários adicionados para `--prompt-file`, `--use-stdin` e omissão de `--print`.

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
