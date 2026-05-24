# cc-antigravity-plugin

Leve para o Claude Code e para o Codex uma passagem de contexto longo pelo
Antigravity CLI (AGY), ideal para revisao de arquitetura, analise de impacto de
refatoracao, sintese de documentacao e analise de dados textuais mistos.

O Claude Code e excelente para edicoes locais e precisas. O AGY ajuda quando
uma fatia ampla do repositorio precisa ser lida e sintetizada em uma unica
passagem. Este plugin conecta os dois por meio de um bridge Node.js
compartilhado.

## Pre-requisitos

Instale e autentique o AGY:

```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Windows PowerShell
irm https://antigravity.google/cli/install.ps1 | iex

agy
agy --print "what is 2+2"
```

## Instalacao

### Claude Code

```bash
/plugin marketplace add AllanHarlen/cc-antigravity-plugin
/plugin install cc-antigravity-plugin@cc-antigravity-plugin
/reload-plugins
```

### Codex

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/AllanHarlen/cc-antigravity-plugin.git \
  ~/.agents/skills/cc-antigravity-plugin
```

Reinicie o Codex depois de clonar.

## Uso

```bash
/cc-antigravity-plugin:antigravity <tarefa>
/cc-antigravity-plugin:antigravity --dirs src,docs <tarefa>
/cc-antigravity-plugin:antigravity --files "schemas/**/*.json,data/**/*.csv" <tarefa>
/cc-antigravity-plugin:antigravity --add-dir src <tarefa>
```

No Codex, use a skill raiz com:

```text
$antigravity-integration
```

## Opcoes

| Opcao | Descricao |
|-------|-----------|
| `--dirs <path,...>` | Injeta diretorios recursivamente no prompt do bridge |
| `--files <glob,...>` | Injeta arquivos que correspondem a globs separados por virgula |
| `--add-dir <path>` | Repassa o `--add-dir` nativo do AGY; pode ser repetido |
| `--model <name>` | Seleciona o modelo do AGY via `agy -i "/model ..."` antes da execucao |
| `--continue`, `-c` | Continua a conversa mais recente do AGY |
| `--conversation <id>` | Retoma uma conversa especifica do AGY |
| `--timeout <duration>` | Repassa `--print-timeout` ao AGY, por exemplo `3m` |
| `--agent`, `--interactive` | Usa `--prompt-interactive` para abrir uma sessao AGY agente |
| `--sandbox` | Ativa o modo sandbox do AGY |
| `--skip-permissions` | Repassa `--dangerously-skip-permissions` ao AGY |
| `--max-files <n>` | Numero maximo de arquivos injetados, padrao `40` |
| `--max-file-bytes <n>` | Numero maximo de bytes por arquivo injetado, padrao `32768` |
| `--print-command` | Imprime o comando `agy` resolvido sem executar |

`--format json` nao e suportado porque o modo headless `--print` do AGY retorna
texto.

Modelos recomendados:

| Modelo | Uso |
|--------|-----|
| `gemini-3.5-flash-medium` | Padrao quando `--model` nao e informado; maioria das atividades |
| `gemini-3.5-flash-high` | Flash com mais esforco para tarefas um pouco mais exigentes |
| `gemini-3.1-pro-low` | Atividades de maior raciocinio |
| `claude-4.6-sonnet-thinking` | Somente quando passado explicitamente com `--model` |
| `claude-4.6-opus-thinking` | Somente quando passado explicitamente com `--model` |

## Exemplos

```bash
/cc-antigravity-plugin:antigravity --dirs src,docs \
  "Explique a arquitetura. Cite arquivos-chave e fluxos de dados."
```

```bash
/cc-antigravity-plugin:antigravity --add-dir src --model gemini-3.1-pro-low \
  "Analise o impacto de refatorar o modulo de auth."
```

```bash
/cc-antigravity-plugin:antigravity --continue --timeout 5m \
  "Resuma o plano de migracao da resposta anterior."
```

```bash
/cc-antigravity-plugin:antigravity --agent --add-dir . --skip-permissions \
  "Atue como agente no workspace e crie relatorio-impostos.html com um relatorio HTML sobre impostos no Brasil."
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" --dirs src --print-command -- "analisar auth"
```

## Como Funciona

O bridge compartilhado em `scripts/antigravity-bridge.js`:

1. Faz o parse das flags do bridge.
2. Resolve `--dirs` e `--files` sem depender de APIs de glob exclusivas do Node 22.
3. Filtra caminhos ignorados e arquivos binarios.
4. Monta um prompt estruturado com inventario, payloads inline, tarefa e restricoes.
5. Mapeia flags nativas do AGY como `--add-dir`, `--continue`, `--conversation`,
   `--prompt-interactive`, `--sandbox`, `--dangerously-skip-permissions` e
   `--print-timeout`.
6. Seleciona o modelo com `agy -i "/model <modelo>"`; se nada for informado, usa `gemini-3.5-flash-medium`.
7. Executa o AGY via `node-pty` quando disponivel e faz streaming do output conforme
   ele chega, com fallback para `spawnSync`.

## Estrutura do Repositorio

```text
cc-antigravity-plugin/
|-- .claude-plugin/
|   |-- marketplace.json
|   `-- plugin.json
|-- agents/
|   `-- antigravity-agent.md
|-- bin/
|   `-- antigravity-bridge
|-- commands/
|   `-- antigravity.md
|-- hooks/
|   `-- hooks.json
|-- scripts/
|   |-- antigravity-bridge.js
|   `-- check-agy.js
|-- tests/
|   |-- antigravity-bridge.test.js
|   `-- antigravity-main.test.js
|-- SKILL.md
|-- LICENSE
`-- package.json
```

## Desenvolvimento

```bash
npm test
```

### Teste controlado com logs

Para abrir o Claude Code com o plugin instrumentado e acompanhar o log do bridge
em tempo real:

```powershell
.\scripts\run-claude-plugin-dev.ps1
```

O script cria um arquivo em `.antigravitycli/logs/*.jsonl`, define
`CC_ANTIGRAVITY_LOG_PATH` para a sessao e abre uma segunda janela fazendo
`Get-Content -Wait` nesse log.

Dentro do Claude Code, rode um ciclo pequeno:

```text
/plugin marketplace add ./
/plugin install cc-antigravity-plugin@cc-antigravity-plugin
/reload-plugins
/cc-antigravity-plugin:antigravity --files package.json --timeout 2m responda apenas plugin-log-ok
```

O log registra eventos como parse de argumentos, arquivos coletados, flags
repassadas ao AGY, selecao de modelo, inicio/fim da execucao e
erros. O prompt completo nao e gravado; o log mostra apenas o tamanho dele.

## Solucao de Problemas

| Problema | Solucao |
|----------|---------|
| Erro de autenticacao | Rode `agy` interativamente e faca login. |
| `agy` nao encontrado | Rode o instalador do AGY novamente e confirme que o binario esta no PATH. |
| Selecao de modelo falhou | Rode `agy` interativamente e confirme que `/model <nome>` aceita o modelo solicitado. |
| Pressao de tokens | Reduza `--dirs`, restrinja `--files` ou diminua `--max-files`. |
| Timeout | Aumente `--timeout`, reduza o contexto ou deixe a tarefa mais direta. |

## Licenca

MIT
