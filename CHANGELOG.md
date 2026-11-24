# Changelog

Todas as mudancas notaveis deste plugin sao documentadas aqui.

## [4.7.0] - 2026-11-24 - Compatibilidade com AGY CLI 1.5.16

- Revisadas as releases oficiais de 1.4.1 a 1.5.16. Base mantida em AGY 1.1.8+, com
  1.5.16 recomendado. Abaixo de 1.5.0 o bridge mantém os padrões legados (teto de 10 min,
  bypass) e avisa uma vez. O hook SessionStart passa a alertar CLIs anteriores a 1.5.0.
- A versão do AGY é lida antes de montar o argv (`resolveRuntimeCapabilities`). Assim,
  modo de permissão e timeout dependem da CLI instalada. `--print-command` sem `agy`
  assume os padrões da 1.5.16 e avisa.
- **Permissões.** Sem `--mode`/`--skip-permissions`/`--read-only`, o padrão é Auto mode
  (`--mode auto`, sem bypass) onde o AGY oferece: AGY 1.3.5+ em Linux/macOS, AGY 1.4.4+ no
  Windows 11 24H2+ (build 26100). O bloqueio fixo de Auto no Windows foi removido, e
  `--mode auto` explícito é validado contra versão e build.
  - Verificado no AGY 1.5.16 real: com Auto indisponível para a conta, o AGY não falha.
    Ele emite `warning: --mode auto is not available for this account; continuing in the
    default mode.` (~0,5 s, antes de qualquer evento) e segue no modo padrão, que nega
    toda permissão em headless.
  - O bridge interrompe essa execução no aviso, sem nenhum passo executado. Em seguida
    refaz uma única vez com `--dangerously-skip-permissions`, registra
    `bridge.permission.fallback` e grava a recusa por 24 h por versão em
    `~/.gemini/antigravity-cli/cache/cc-antigravity-capabilities.json`.
  - Nunca há retry com `--mode auto` explícito nem depois de um passo. Imagem e
    `--interactive` mantêm o bypass.
- **Timeout ilimitado por padrão (AGY 1.5.0+).** Sem `--timeout`, o bridge não envia
  `--print-timeout`. O AGY espera o turno e as tarefas em background e subagents
  não-daemon.
  - Novo watchdog `--stall-timeout` (padrão `15m`, `0` desliga; também
    `userConfig.stall_timeout`). O bridge pede `stream-json` internamente e remonta
    `json`/`text` sem mudança na saída; o progresso vai só para o log.
  - Verificado que o AGY 1.5.16 honra `--json-schema` em `stream-json`
    (`structured_output` no resultado), então o watchdog também cobre schemas.
  - `--timeout` explícito continua como teto, e o timer do bridge espera 30 s a mais para
    o AGY reportar o turno parcial. `--timeout 0` equivale a nenhum teto.
  - O `userConfig.timeout` passou de `5m0s` para vazio.
  - `EMPTY_RESPONSE` sem teto finito sai sempre com 1.
- **Término antecipado.** `finished_reason` (AGY 1.4.11+) é lido de json e stream-json.
  `print_timeout` vira exit 12; o mesmo vale para a linha `[agy] print timeout after` ou
  um `AGY_ERROR` com `"reason":"print_timeout"`. O sinal preserva `response` parcial,
  `conversation_id`, `finished_reason` e `agy_error`. `interrupted` vira `INTERRUPTED`
  (exit 1). Exit 3 sozinho não vira timeout. `short_error` do AGY_ERROR real passa a
  compor o motivo. Fixtures reais capturadas do AGY 1.5.16.
- **Cota.** Corrigido `ReferenceError`: `EXIT_QUOTA_EXHAUSTED` não existia e derrubava um
  AGY_ERROR com status não mapeado e mensagem de cota para exit 1. Adicionados os padrões
  de spend cap, saldo pré-pago e cota semanal (AGY 1.5.10). O sinal `QUOTA_EXHAUSTED`
  também traz `retry`.
- **`-r` / `--resume <id>`** (AGY 1.5.16) aceitos como aliases de `--conversation`. O
  bridge continua enviando `--conversation`.
- **Modelos Gemini 4.**
  - `modelVersion` reconhece gerações só com major (`gemini-4-neon-high` → 4.0; `120b`
    não conta como versão).
  - `hydrogen`, `neon`, `argon`, `carbon` e `orchestrator` resolvem como famílias,
    conferidas contra o catálogo real do 1.5.16.
  - Fallback de emergência, `pro` e `--model auto` (Flash mais novo) inalterados.
- **Prompts.** O init do AGY 1.5.16 lista `grep_search`, `find_by_name`, `list_dir` e
  `view_file` (sem `code_search`). Os prompts agêntico e read-only deixam de declarar
  essas ferramentas como legadas.
- `spawnHeadless` resolve timeout e abort antes de matar o processo, para que o `close`
  do filho não transforme um timeout em erro genérico. Journal e `bridge.exit` registram
  a estratégia de permissão.
- Docs (README, README.pt-BR, comando, skill, agents, CASOS_USO, política SessionStart):
  - Auto mode e o fallback;
  - timeout ilimitado com `run_in_background` no Claude Code;
  - `--stall-timeout`, `-r`/`--resume` e os aliases Gemini 4;
  - denylist da 1.5.2 e `~/.agents/skills`;
  - nota de que o plugin não deve rodar importado no AGY (`agy plugin import`).
  - Corrigidos `gemini-3.7-flash-low` e `--print-timeout 5m` em CASOS_USO.
- Versões 4.7.0 sincronizadas em package, lockfile e manifests, com contract test.
- Validação: 266 testes aprovados, 1 teste live ignorado. Smoke com AGY 1.5.16 real no
  Windows 11 build 26300: fallback Auto → bypass e cache, segunda execução direto em
  bypass, `--timeout 2s` → exit 12 com `finished_reason`, `--json-schema` → `{"ok":true}`,
  `--read-only` e `--format text`. `AGY_LIVE=1` falha por decisão: o fallback não
  inclui os modelos Gemini 4.

## [4.6.0] - 2026-10-16 - Compatibilidade com AGY CLI 1.4.0

- Revisadas as releases oficiais até 1.4.0. Base mantida em AGY 1.1.8+, com
  1.4.0 recomendado; cada recurso novo depende da versão indicada abaixo.
- `--mode auto` (AGY 1.3.5+, Linux/macOS) desativa o bypass padrão do bridge,
  rejeita `--skip-permissions` em qualquer ordem e falha antes de iniciar tarefas
  com CLI antiga ou Windows. `--read-only` continua prevalecendo como modo plan.
- `--effort` aceita `xhigh` e `max`, inclusive na configuração do plugin; o AGY
  continua validando quais níveis o modelo selecionado oferece. Aliases distinguem
  high/xhigh/max e ordenam os novos níveis corretamente.
- Slugs base exatos presentes nas variantes do catálogo, como
  `gemini-3.8-flash`, são preservados para o esforço padrão nativo do AGY 1.3.4+.
  Nomes em linguagem natural mantêm a resolução por família e esforço. Aliases Opus/Sonnet nas
  instruções passam a acompanhar o catálogo autenticado, sem fixar Claude 4.6.
  Uma geração explicitamente solicitada e ausente força uma atualização do cache
  uma vez; nunca é substituída silenciosamente por uma geração anterior.
- `--json-schema` valida JSON inline ou arquivo existente e exige raiz
  `"type": "object"` antes de consultar modelos ou iniciar processos. Arquivos
  permanecem como paths absolutos para não aumentar argv com schemas grandes.
- `AGY_ERROR: {...}` no stderr (AGY 1.2.6+) é interpretado mesmo com resposta
  parcial e envelope JSON/stream-json. Cota, autenticação e deadline mapeiam para
  10/11/12; demais erros estruturados mapeiam para 1. `agy_error` preserva
  metadados originais e `response` preserva a resposta parcial estruturada.
- Reconhecida a mensagem nova de autenticação expirada. Respostas de sucesso que
  discutem erros continuam protegidas contra classificação indevida.
- Prompts deixam de exigir ferramentas legadas removidas do conjunto padrão no
  AGY 1.2.7; orientam buscas com ferramentas disponíveis, como `code_search`.
  Read-only continua proibindo `run_command` e escrita.
- Mantido o timeout explícito do bridge; documentados o timeout ilimitado nativo,
  a revisão de artefatos desde 1.3.2 e o limite entre plugins Claude Code e AGY.
- Versões sincronizadas em package, lockfile e manifests; pré-requisito Node.js
  corrigido para 22+, conforme engines e CI.
- Validação: 207 testes aprovados, 1 teste autenticado ignorado; instalação npm e
  PTY nativa verificadas. Conferência de flags e rejeição de schemas no
  binário oficial Linux x64 1.4.0. Execução real de modelos requer autenticação.

## [4.4.3] - 2026-09-25 - `--read-only` headless sem `run_command`

- `--read-only`: o prompt deixa de oferecer `run_command` "somente leitura". Em execucao headless o AGY nega automaticamente a permissao `command`, e a chamada abortava a analise sem saida (observado num review de front-end em `--read-only`, 2026-09-22). A inspecao fica restrita a `grep_search`, `view_file` e `list_dir`.
- Fronteira de responsabilidade (decisao de revisao do PR): o bridge e transporte — monta o prompt com os arquivos que recebe, chama a CLI e traduz os codigos de saida. Uma versao anterior deste PR incluia `components.css` nos arquivos centrais do `--design-system` e uma regra no bloco `<design_system>` ("importe `components.css` depois de `tokens.css`, nunca copie o andaime do preview"); isso e politica do fluxo Pensador -> Orquestrador e foi retirado. A regra vive nos prompts de subagente do `cc-orchestrador-subagents` (4.25.0) e do `cc-executor-subagents` (2.11.0); o `components.css` chega ao AGY como arquivo sob demanda do pacote, e o prompt enviado ao AGY nao cita nenhum projeto consumidor.
- Testes: prompt read-only sem `run_command` e sem nome de projeto; o bloco `<design_system>` nao carrega regra de fluxo de um produtor especifico e `DESIGN_SYSTEM_CORE_FILES` fica fixado.

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
