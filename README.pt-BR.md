<p align="center">
  <img src="banner.png" alt="cc-antigravity-plugin banner" />
</p>

# cc-antigravity-plugin

Plugin para Claude Code e Codex que integra o [Antigravity CLI (AGY)](https://antigravity.google) como assistente de codificação agêntico — cria, edita, pesquisa arquivos e executa comandos autonomamente sobre sua base de código.

📖 **Documentação em outras línguas:**
- [English](./README.md)

> **Fork:** Este plugin é um fork do [gemini-cli-plugin](https://github.com/google-gemini/gemini-cli), originalmente criado por [thepushkarp](https://www.linkedin.com/in/thepushkarp) para automação de processos com Gemini CLI.

## Visão Geral

O AGY é um terminal CLI do Google com janela de contexto longa (2M tokens). Este plugin conecta o AGY ao Claude Code e ao Codex por meio de um bridge Node.js compartilhado, expondo o AGY como um endpoint [tool_use](https://www.anthropic.com/research/tool-use) que Claude pode invocar.

**Quando usar em vez do Claude Code nativo:**
- Refatorações multi-arquivo que precisam de contexto amplo do repositório
- Geração de código que atravessa várias camadas do projeto
- Análise de arquitetura e impacto de mudanças com contexto completo
- Tarefas que se beneficiam dos modelos Gemini Pro de raciocínio profundo
- Tarefas com múltiplos entregáveis independentes que podem rodar em paralelo via subagentes Gemini nativos (`--parallel`)

### Claude invocando `agy` diretamente vs via plugin

O Claude pode chamar `agy` diretamente via Bash (`agy --print "task" --dangerously-skip-permissions --add-dir .`) sem nenhuma camada intermediária. O plugin, porém, entrega capacidades que o `agy` bruto não consegue:

| Capacidade | `agy` direto | Via plugin (bridge) |
|---|---|---|
| Seleção de modelo headless | Impossível — sem flag `--model` | Sim, via patch de `settings.json` |
| Comportamento de coding agent garantido | Não — AGY tende a responder texto | Sim — bloco `<constraints>` instrui uso de `write_to_file`, `grep_search`, etc. |
| Sinais estruturados de quota/auth | Não — texto livre, sem exit code | Exit codes 10/11 + JSON linha parseable |
| Ingestão automática de arquivos | Manual | `--dirs`, `--files` com detecção binária e truncamento |
| Parallelismo via subagentes Gemini | Manual | `--parallel` + `--subagent-model` |
| Fallback do limite de 28k chars (Windows) | Quebra silencioso | Drop automático de arquivos inline |
| Logging auditável | Não | JSONL em `%LOCALAPPDATA%\agy\cc-plugin-logs\` |
| Overhead de processo | Nenhum | Node.js + ConPTY + check de versão |
| Visibilidade das ações do AGY | Total — output direto | Caixa preta — Claude não valida antes de executar |
| Dependência de quota | Só Claude | Claude + AGY/Gemini |

**Resumo:** para workflows automatizados, skills e tarefas de codificação onde o comportamento agêntico consistente é necessário, o bridge é a escolha correta. Para invocações ad-hoc simples, o `agy` bruto é suficiente.

## Pré-requisitos

- **Node.js 18+**
- **Antigravity CLI** instalado e autenticado

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

> O hook `SessionStart` verifica automaticamente se o AGY está instalado e acessível a cada início de sessão do Claude Code.

## Instalação

### Claude Code (recomendado)

**Via CLI (terminal):**

```bash
# Adiciona o repositório GitHub como fonte de marketplace
claude plugin marketplace add AllanHarlen/cc-antigravity-plugin

# Instala o plugin
claude plugin install cc-antigravity-plugin@AllanHarlen/cc-antigravity-plugin
```

**Via slash command (dentro do Claude Code):**

```
/plugin marketplace add AllanHarlen/cc-antigravity-plugin
/plugin install cc-antigravity-plugin@AllanHarlen/cc-antigravity-plugin
```

**Para testar uma cópia local do repositório:**

```bash
cc --plugin-dir /path/to/cc-antigravity-plugin
```

### Codex

```bash
git clone https://github.com/AllanHarlen/cc-antigravity-plugin.git \
  ~/.agents/skills/cc-antigravity-plugin
```

Reinicie o Codex após clonar.

## Uso

```bash
# Tarefa agêntica — padrão, cria e edita arquivos no workspace
/cc-antigravity-plugin:antigravity "Refatore o módulo auth para async/await e atualize todos os callers"

# Com contexto inline de diretórios
/cc-antigravity-plugin:antigravity --dirs src,docs "Explique a arquitetura e cite os arquivos-chave"

# Somente análise, sem modificar arquivos
/cc-antigravity-plugin:antigravity --read-only --dirs src "Analise o impacto de remover o módulo de cache"

# Modelo específico
/cc-antigravity-plugin:antigravity --model gemini-3.1-pro-low "Projete o schema do banco para o módulo X"

# Modelo automático (selecionado pelo tamanho do contexto inline)
/cc-antigravity-plugin:antigravity --model auto --dirs src "Refatore os controllers"

# Subagentes paralelos — AGY divide a tarefa em subagentes Gemini nativos e concorrentes
/cc-antigravity-plugin:antigravity --parallel "Crie dois relatórios HTML em relatorio/: impostos em carros elétricos e em carros a combustão no Brasil"

# Subagentes paralelos em modelo mais barato, sob um planejador Pro
/cc-antigravity-plugin:antigravity --model gemini-3.1-pro-low --subagent-model gemini-3.5-flash-medium "Gere três componentes React independentes: Header, Sidebar e Footer"

# Continuar sessão anterior
/cc-antigravity-plugin:antigravity --continue "Continue a partir do passo 3 da refatoração anterior"

# Geração de imagem com Nano Banana
/cc-antigravity-plugin:antigravity --generate-image "um skyline futurista ao pôr do sol, estilo cyberpunk, tons de roxo e laranja"

# Com contexto de estilo e diretório de destino
/cc-antigravity-plugin:antigravity --generate-image --files "brand/style.json" --output-dir ./assets "logotipo seguindo o guia de identidade visual"
```

No Codex, use o agente via:

```text
@antigravity-agent <tarefa>
```

## Opções

| Opção | Descrição |
|---|---|
| `--dirs <path,...>` | Injeta diretórios recursivamente como contexto inline no prompt |
| `--files <glob,...>` | Injeta arquivos que correspondem a globs separados por vírgula |
| `--add-dir <path>` | Adiciona diretório ao workspace nativo do AGY via `--add-dir`; repetível |
| `--model <name>` | Modelo a usar; escrito em `settings.json` antes do spawn e restaurado após. Ver tabela abaixo. |
| `--parallel` | Permite que o AGY divida a tarefa entre múltiplos subagentes Gemini nativos (`DefineSubagent` / `invoke_subagent` / `ManageSubagents`). O próprio AGY decide quantos. Requer TTY ou injeção de prompt. |
| `--subagent-model <name>` | Modelo que os subagentes spawnados devem usar (transmitido via prompt — o AGY não tem flag de CLI por subagente). Ativa `--parallel` automaticamente. Padrão: o modelo da sessão principal. |
| `--read-only` | Desativa `--dangerously-skip-permissions` e o auto-add do cwd. Use para análise pura sem modificar arquivos. |
| `--continue`, `-c` | Continua a conversa mais recente do AGY |
| `--conversation <id>` | Retoma uma conversa específica do AGY por ID |
| `--timeout <duration>` | Repassa `--print-timeout` ao AGY (ex: `3m`, `300s`). O timer reseta a cada chunk de output. |
| `--interactive`, `--agent` | Usa `--prompt-interactive` para sessão interativa (requer TTY) |
| `--sandbox` | Ativa o modo sandbox do AGY |
| `--max-files <n>` | Número máximo de arquivos injetados no contexto inline. Padrão: `40` |
| `--max-file-bytes <n>` | Número máximo de bytes por arquivo. Padrão: `32768` |
| `--generate-image`, `--generate-imagem` | Gera uma imagem a partir da descrição no task usando o modelo Nano Banana. Define `--model nano-banana` automaticamente. |
| `--output-dir <path>` | Diretório onde as imagens geradas são salvas. Padrão: diretório atual. |
| `--print-command` | Imprime o comando `agy` resolvido sem executar |

**Padrões agênticos:** por padrão, `--dangerously-skip-permissions` é repassado e o cwd é adicionado ao workspace do AGY via `--add-dir`. Use `--read-only` para desativar.

## Modelos disponíveis

| Identificador | Indicado para |
|---|---|
| `gemini-3.5-flash-medium` | **Padrão** — maioria das tarefas |
| `gemini-3.5-flash-low` | Tarefas simples, resposta mais rápida |
| `gemini-3.5-flash-high` | Flash com mais esforço de raciocínio |
| `gemini-3.1-pro-low` | Raciocínio mais profundo |
| `gemini-3.1-pro-high` | Raciocínio máximo |
| `claude-4.6-sonnet-thinking` | Tarefas complexas com Claude |
| `claude-4.6-opus-thinking` | Máxima capacidade |
| `gpt-oss-120b-medium` | Alternativa GPT |
| `nano-banana` | Geração de imagem (usado por `--generate-image`) |
| `auto` | Seleciona automaticamente pelo tamanho do contexto inline |

**`--model auto` — limiares:**

| Contexto inline total | Modelo selecionado |
|---|---|
| < 32 KB | `gemini-3.5-flash-low` |
| 32 KB – 256 KB | `gemini-3.5-flash-medium` |
| ≥ 256 KB | `gemini-3.5-flash-high` |

O modelo é aplicado escrevendo `settings.json` do AGY antes do spawn e restaurado imediatamente após — sem efeito persistente no AGY.

## Subagentes paralelos (`--parallel`)

O AGY expõe ferramentas nativas de subagentes (`DefineSubagent`, `invoke_subagent` / `Agent`, `ManageSubagents`) que permitem fazer **fan-out de trabalho dentro de uma única sessão `agy`** — múltiplas tarefas independentes rodam concorrentemente sob um único contexto de modelo.

Com `--parallel`, o bridge anexa um bloco de instruções ao prompt autorizando o AGY a decompor a tarefa em subtarefas independentes e executá-las concorrentemente. O **próprio AGY decide quantos subagentes spawnear** (sujeito a limites de taxa).

```bash
# AGY decide a quantidade de subagentes
/cc-antigravity-plugin:antigravity --parallel "Crie dois relatórios HTML independentes em relatorio/"

# Planejador Pro coordenando subagentes Flash baratos
/cc-antigravity-plugin:antigravity --model gemini-3.1-pro-low --subagent-model gemini-3.5-flash-medium "Gere três componentes independentes"
```

**Detalhes:**
- `--subagent-model` ativa `--parallel` automaticamente e é transmitido pelo **texto do prompt** (o AGY não tem flag de CLI por subagente). Sem ele, os subagentes herdam o modelo da sessão principal.
- Funciona no modo headless padrão (`--print`) — não requer TTY.
- Ideal para **entregáveis independentes** (vários relatórios, componentes ou arquivos). Para passos sequenciais ou que compartilham estado, mantenha a execução no agente principal.
- Sem a flag, o prompt fica idêntico ao comportamento padrão — zero impacto nas chamadas existentes.
- `--parallel` é ignorado quando combinado com `--generate-image`.

## Códigos de saída

O bridge emite um JSON estruturado para orquestradores reagirem a falhas:

```json
{"status":"QUOTA_EXAUSTED","reason":"...","model":"gemini-3.5-flash-medium","retry":"--continue"}
```

O campo `retry` indica como retomar: passe `--continue` na próxima chamada para retomar a sessão interrompida.

| Código | Significado | Ação |
|---|---|---|
| `0` | Sucesso | — |
| `1` | Erro genérico | Verifique o log |
| `10` | `QUOTA_EXAUSTED` | Aguarde reset; use `--continue` para retomar |
| `11` | `AUTH_REQUIRED` | Execute `agy` uma vez interativamente |
| `12` | `TIMEOUT` | Aumente `--timeout` ou reduza o escopo |
| `13` | `AGY_MISSING` | Instale o AGY |

> **Heartbeat:** o timer de timeout reseta a cada chunk de output do AGY. Tarefas longas que produzem output contínuo não são canceladas — o timeout só dispara se o AGY ficar completamente silencioso pela duração especificada.

## Testes

```bash
npm test
```

```
ℹ pass 94
ℹ fail 0
```

Cobertura: parse de argumentos · coleta de contexto · geração de prompt · bloco de paralelismo (`--parallel` / `--subagent-model`) · spawn via ConPTY · heartbeat de timeout · detecção de encoding · seleção de modelo · exit codes.

Para exemplos práticos de uso em cenários reais, consulte [`CASOS_USO.md`](CASOS_USO.md) — 11 casos de uso cobrindo análise de arquitetura, refatoração multi-arquivo, geração de documentação e decomposição de tarefas paralelas.

## Desenvolvimento

### Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `CC_ANTIGRAVITY_LOG_PATH` | Caminho customizado para o arquivo de log JSONL |
| `CC_ANTIGRAVITY_LOG_OUTPUT` | Defina como `1` para incluir o output do AGY nos logs |

Log padrão: `%LOCALAPPDATA%\agy\cc-plugin-logs\plugin-YYYY-MM-DD.jsonl` (Windows) ou `~/.local/share/agy/cc-plugin-logs/` (Linux/macOS).

### Teste local com logs em tempo real (Windows)

```powershell
.\scripts\run-claude-plugin-dev.ps1
```

O script define `CC_ANTIGRAVITY_LOG_PATH` para a sessão e abre uma segunda janela com `Get-Content -Wait` no log.

## Solução de Problemas

| Problema | Solução |
|---|---|
| Erro de autenticação | Rode `agy` interativamente e faça login. |
| `agy` não encontrado | Rode o instalador do AGY e confirme que o binário está no PATH. |
| Modelo não muda | Verifique se `%LOCALAPPDATA%\agy\settings.json` (Win) ou `~/.config/agy/settings.json` (Linux) é lido pelo AGY. Confirme com T02 do `MANUAL_TESTS.md`. |
| Pressão de tokens | Reduza `--dirs`, restrinja `--files` ou diminua `--max-files`. |
| Timeout prematuro | Aumente `--timeout`. Com heartbeat ativo, o timer reseta a cada output — verifique se o AGY está produzindo output. |
| Plugin não carregado | Rode `/reload-plugins` ou reinicie o Claude Code. |
| Arquivo com encoding errado ignorado | Arquivos não-UTF-8 (ex: Windows-1252) são pulados com `encoding-error`. Re-salve em UTF-8. |

## Licença

[MIT](LICENSE)
