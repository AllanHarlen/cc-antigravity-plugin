# cc-antigravity-plugin

Plugin para Claude Code e Codex que integra o [Antigravity CLI (AGY)](https://antigravity.google) como assistente de codificação agêntico — cria, edita, pesquisa arquivos e executa comandos autonomamente usando os modelos Gemini, Claude e GPT do AGY diretamente no seu workspace.

## Visão Geral

O AGY é um terminal CLI do Google com janela de contexto longa (2M tokens). Este plugin conecta o AGY ao Claude Code e ao Codex por meio de um bridge Node.js compartilhado, expondo o AGY como um subagente que **completa tarefas de codificação de ponta a ponta**.

**Quando usar em vez do Claude Code nativo:**
- Refatorações multi-arquivo que precisam de contexto amplo do repositório
- Geração de código que atravessa várias camadas do projeto
- Análise de arquitetura e impacto de mudanças com contexto completo
- Tarefas que se beneficiam dos modelos Gemini Pro de raciocínio profundo

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

```bash
/plugin marketplace add AllanHarlen/cc-antigravity-plugin
/reload-plugins
```

Para testar uma cópia local do repositório:

```bash
/plugin install ./
/reload-plugins
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

# Continuar sessão anterior
/cc-antigravity-plugin:antigravity --continue "Continue a partir do passo 3 da refatoração anterior"
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
| `--read-only` | Desativa `--dangerously-skip-permissions` e o auto-add do cwd. Use para análise pura sem modificar arquivos. |
| `--continue`, `-c` | Continua a conversa mais recente do AGY |
| `--conversation <id>` | Retoma uma conversa específica do AGY por ID |
| `--timeout <duration>` | Repassa `--print-timeout` ao AGY (ex: `3m`, `300s`). O timer reseta a cada chunk de output. |
| `--interactive`, `--agent` | Usa `--prompt-interactive` para sessão interativa (requer TTY) |
| `--sandbox` | Ativa o modo sandbox do AGY |
| `--max-files <n>` | Número máximo de arquivos injetados no contexto inline. Padrão: `40` |
| `--max-file-bytes <n>` | Número máximo de bytes por arquivo. Padrão: `32768` |
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
| `auto` | Seleciona automaticamente pelo tamanho do contexto inline |

**`--model auto` — limiares:**

| Contexto inline total | Modelo selecionado |
|---|---|
| < 32 KB | `gemini-3.5-flash-low` |
| 32 KB – 256 KB | `gemini-3.5-flash-medium` |
| ≥ 256 KB | `gemini-3.5-flash-high` |

O modelo é aplicado escrevendo `settings.json` do AGY antes do spawn e restaurado imediatamente após — sem efeito persistente no AGY.

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

> **Heartbeat:** o timer de timeout reseta a cada chunk de output do AGY. Tarefas longas que produzem output contínuo não são canceladas — o timeout só dispara se o AGY ficar completamente silencioso por `timeoutMs`.

## Testes

```bash
npm test
```

```
ℹ pass 81
ℹ fail 0
```

Cobertura: parse de argumentos · coleta de contexto · geração de prompt · spawn via ConPTY · heartbeat de timeout · detecção de QUOTA_EXAUSTED/AUTH_REQUIRED · model forwarding via settings.json · `--model auto` · encoding error handling.

Para exemplos práticos de uso em cenários reais, consulte [`CASOS_USO.md`](CASOS_USO.md) — 11 casos de uso cobrindo análise de arquitetura, refatoração multi-arquivo, geração de documentação, análise de impacto, `--model auto`, heartbeat, sessões contínuas e recuperação de QUOTA_EXAUSTED.

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
