# cc-antigravity-plugin

Leva para o Claude Code e para o Codex uma passagem de contexto longo pelo
Antigravity CLI (AGY), ideal para revisão de arquitetura, análise de impacto de
refatoração, síntese de documentação e análise de dados textuais mistos.

O Claude Code é excelente para edições locais e precisas. O AGY ajuda quando
uma fatia ampla do repositório precisa ser lida e sintetizada em uma única
passagem. Este plugin conecta os dois por meio de um bridge Node.js
compartilhado.

## Pré-requisitos

Instale e autentique o AGY antes de usar o plugin:

```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Windows PowerShell
irm https://antigravity.google/cli/install.ps1 | iex
```

Após instalar, rode `agy` uma vez para fazer login e confirme que está funcionando:

```bash
agy --print "what is 2+2"
```

## Instalação

### Via Marketplace do Claude Code (recomendado)

Dentro do Claude Code, execute os três comandos em sequência:

```
/plugin marketplace add AllanHarlen/cc-antigravity-plugin
/plugin install cc-antigravity-plugin@cc-antigravity-plugin
/reload-plugins
```

O primeiro comando registra o repositório GitHub como fonte de marketplace. O segundo instala o plugin a partir dessa fonte. O terceiro recarrega os plugins na sessão atual.

### Instalação Local (desenvolvimento)

Para testar uma cópia local do repositório clonado:

```
/plugin marketplace add ./
/plugin install cc-antigravity-plugin@cc-antigravity-plugin
/reload-plugins
```

### Codex

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/AllanHarlen/cc-antigravity-plugin.git \
  ~/.agents/skills/cc-antigravity-plugin
```

Reinicie o Codex após clonar.

## Uso

```bash
/cc-antigravity-plugin:antigravity <tarefa>
/cc-antigravity-plugin:antigravity --dirs src,docs <tarefa>
/cc-antigravity-plugin:antigravity --files "schemas/**/*.json,data/**/*.csv" <tarefa>
/cc-antigravity-plugin:antigravity --add-dir src <tarefa>
```

No Codex, use o agente via:

```text
@antigravity-agent <tarefa>
```

## Opções

| Opção | Descrição |
|-------|-----------|
| `--dirs <path,...>` | Injeta diretórios recursivamente no prompt do bridge |
| `--files <glob,...>` | Injeta arquivos que correspondem a globs separados por vírgula |
| `--add-dir <path>` | Repassa o `--add-dir` nativo do AGY; pode ser repetido |
| `--model <name>` | Seleciona o modelo do AGY via `agy -i "/model ..."` antes da execução |
| `--continue`, `-c` | Continua a conversa mais recente do AGY |
| `--conversation <id>` | Retoma uma conversa específica do AGY |
| `--timeout <duration>` | Repassa `--print-timeout` ao AGY, por exemplo `3m` |
| `--agent`, `--interactive` | Usa `--prompt-interactive` para abrir uma sessão AGY agente |
| `--sandbox` | Ativa o modo sandbox do AGY |
| `--skip-permissions` | Repassa `--dangerously-skip-permissions` ao AGY |
| `--max-files <n>` | Número máximo de arquivos injetados, padrão `40` |
| `--max-file-bytes <n>` | Número máximo de bytes por arquivo injetado, padrão `32768` |
| `--print-command` | Imprime o comando `agy` resolvido sem executar |

`--format json` não é suportado porque o modo headless `--print` do AGY retorna texto.

### Modelos recomendados

| Modelo | Uso |
|--------|-----|
| `gemini-3.5-flash-medium` | Padrão quando `--model` não é informado; maioria das atividades |
| `gemini-3.5-flash-high` | Flash com mais esforço para tarefas um pouco mais exigentes |
| `gemini-3.1-pro-low` | Atividades de maior raciocínio |
| `claude-4.6-sonnet-thinking` | Somente quando passado explicitamente com `--model` |
| `claude-4.6-opus-thinking` | Somente quando passado explicitamente com `--model` |

## Exemplos

```bash
# Revisão de arquitetura
/cc-antigravity-plugin:antigravity --dirs src,docs \
  "Explique a arquitetura. Cite arquivos-chave e fluxos de dados."
```

```bash
# Análise de impacto de refatoração
/cc-antigravity-plugin:antigravity --add-dir src --model gemini-3.1-pro-low \
  "Analise o impacto de refatorar o módulo de auth."
```

```bash
# Continuação de conversa
/cc-antigravity-plugin:antigravity --continue --timeout 5m \
  "Resuma o plano de migração da resposta anterior."
```

```bash
# Sessão de agente no workspace
/cc-antigravity-plugin:antigravity --agent --add-dir . --skip-permissions \
  "Atue como agente no workspace e crie relatorio-impostos.html com um relatório HTML sobre impostos no Brasil."
```

```bash
# Inspecionar o comando sem executar
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" --dirs src --print-command -- "analisar auth"
```

## Como Funciona

O bridge compartilhado em `scripts/antigravity-bridge.js`:

1. Faz o parse das flags do bridge.
2. Resolve `--dirs` e `--files` sem depender de APIs de glob exclusivas do Node 22.
3. Filtra caminhos ignorados e arquivos binários.
4. Monta um prompt estruturado com inventário, payloads inline, tarefa e restrições.
5. Mapeia flags nativas do AGY como `--add-dir`, `--continue`, `--conversation`,
   `--prompt-interactive`, `--sandbox`, `--dangerously-skip-permissions` e
   `--print-timeout`.
6. Seleciona o modelo com `agy -i "/model <modelo>"`; se nada for informado, usa `gemini-3.5-flash-medium`.
7. Executa o AGY via `node-pty` quando disponível e faz streaming do output conforme
   ele chega, com fallback para `spawnSync`.

O hook `SessionStart` verifica automaticamente se o AGY está instalado e respondendo a cada início de sessão.

## Estrutura do Repositório

```text
cc-antigravity-plugin/
├── .claude-plugin/
│   ├── marketplace.json
│   └── plugin.json
├── agents/
│   └── antigravity-agent.md
├── bin/
│   └── antigravity-bridge
├── commands/
│   └── antigravity.md
├── hooks/
│   └── hooks.json
├── scripts/
│   ├── antigravity-bridge.js
│   └── check-agy.js
├── tests/
│   ├── antigravity-bridge.test.js
│   └── antigravity-main.test.js
├── SKILL.md
├── LICENSE
└── package.json
```

## Desenvolvimento

```bash
npm test
```

### Teste controlado com logs

Para testar localmente o plugin dentro do Claude Code com logs em tempo real:

```
/plugin marketplace add ./
/plugin install cc-antigravity-plugin@cc-antigravity-plugin
/reload-plugins
```

Em seguida, rode um ciclo de teste:

```
/cc-antigravity-plugin:antigravity --files package.json --timeout 2m responda apenas plugin-log-ok
```

Para acompanhar o log do bridge em tempo real (PowerShell):

```powershell
.\scripts\run-claude-plugin-dev.ps1
```

O script cria um arquivo em `.antigravitycli/logs/*.jsonl`, define
`CC_ANTIGRAVITY_LOG_PATH` para a sessão e abre uma segunda janela fazendo
`Get-Content -Wait` nesse log.

O log registra eventos como parse de argumentos, arquivos coletados, flags
repassadas ao AGY, seleção de modelo, início/fim da execução e erros.

### Variáveis de Ambiente

| Variável | Descrição |
|----------|-----------|
| `CC_ANTIGRAVITY_LOG_PATH` | Caminho customizado para o arquivo de log JSONL |
| `CC_ANTIGRAVITY_LOG_OUTPUT` | Defina como `1` para incluir o output do AGY nos logs |

## Solução de Problemas

| Problema | Solução |
|----------|---------|
| Erro de autenticação | Rode `agy` interativamente e faça login. |
| `agy` não encontrado | Rode o instalador do AGY novamente e confirme que o binário está no PATH. |
| Seleção de modelo falhou | Rode `agy` interativamente e confirme que `/model <nome>` aceita o modelo solicitado. |
| Pressão de tokens | Reduza `--dirs`, restrinja `--files` ou diminua `--max-files`. |
| Timeout | Aumente `--timeout`, reduza o contexto ou deixe a tarefa mais direta. |
| Plugin não encontrado após instalar | Rode `/reload-plugins` ou reinicie o Claude Code. |

## Licença

MIT
