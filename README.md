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

# Autenticar (necessário uma vez)
agy
```

## Instalação

### Claude Code

```bash
/plugin marketplace add AllanHarlen/cc-antigravity-plugin
/reload-plugins
```

### Codex

```bash
git clone https://github.com/AllanHarlen/cc-antigravity-plugin.git \
  ~/.agents/skills/cc-antigravity-plugin
```

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

# Modelo automático (selecionado pelo tamanho do contexto)
/cc-antigravity-plugin:antigravity --model auto --dirs src "Refatore os controllers"

# Continuar sessão anterior
/cc-antigravity-plugin:antigravity --continue "Continue a partir do passo 3 da refatoração anterior"
```

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
| `auto` | Seleciona flash tier pelo tamanho do contexto |

## Códigos de saída

O bridge emite um JSON estruturado para orquestradores reagirem a falhas:

```json
{"status":"QUOTA_EXAUSTED","reason":"...","model":"gemini-3.5-flash-medium","retry":"--continue"}
```

| Código | Significado | Ação |
|---|---|---|
| `0` | Sucesso | — |
| `1` | Erro genérico | Verifique o log |
| `10` | `QUOTA_EXAUSTED` | Aguarde reset; use `--continue` para retomar |
| `11` | `AUTH_REQUIRED` | Execute `agy` uma vez interativamente |
| `12` | `TIMEOUT` | Aumente `--timeout` ou reduza o escopo |
| `13` | `AGY_MISSING` | Instale o AGY |

## Testes

```bash
npm test
```

```
ℹ pass 81
ℹ fail 0
```

Cobertura: parse de argumentos · coleta de contexto · geração de prompt · spawn via ConPTY · heartbeat de timeout · detecção de QUOTA_EXAUSTED/AUTH_REQUIRED · model forwarding via settings.json · `--model auto` · encoding error handling.

## Licença

[MIT](LICENSE)
