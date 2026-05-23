# Plano de Refatoracao — cc-antigravity-plugin v3.0

## 1. Diagnostico (Estado Atual)

### Estrutura atual do plugin

```
cc-antigravity-plugin/
├── .claude-plugin/
│   ├── plugin.json           # Manifesto basico (name, version, description, author, keywords)
│   └── marketplace.json      # Definicao do marketplace
├── agents/
│   ├── antigravity-agent.md  # Subagente para exploracao via AGY
│   └── openai.yaml           # Definicao Codex (formato YAML, nao-padrao Claude Code)
├── commands/
│   └── antigravity.md        # Slash command /cc-antigravity-plugin:antigravity
├── scripts/
│   └── antigravity-bridge.js # Bridge script — nucleo de execucao
├── tests/
│   ├── antigravity-bridge.test.js
│   └── antigravity-main.test.js
├── SKILL.md                  # Skill root-level (antigravity-integration)
├── package.json              # Node.js package
└── .gitignore
```

### O que funciona

- Parsing de argumentos CLI (`--dirs`, `--files`, `--task`, `--model`, `--format`)
- Coleta e ingestao de arquivos do workspace com filtros de binarios e ignorados
- Montagem de prompt XML estruturado com inventario e payloads
- Invocacao do `agy --print` via ConPTY (Windows) com fallback para `spawnSync`
- Suite de testes com cobertura de parsing, coleta, prompt e execucao
- Definicao de agente, comando e skill para Claude Code

### O que NAO funciona ou esta ausente

O plugin foi migrado do Gemini CLI para o AGY CLI como um "hard cut" sem adicao de features.
A migracao preservou o comportamento identico, mas deixou gaps criticos de negocio e execucao.

---

## 2. Gaps Identificados

### 2.1 Gaps Criticos de Execucao (Plugin quebra quando instalado)

| # | Gap | Impacto | Evidencia |
|---|-----|---------|-----------|
| E1 | **Paths relativos quebram apos instalacao via marketplace** | Plugin instalado nao funciona | O agente e o comando referenciam `node scripts/antigravity-bridge.js` — path relativo ao CWD do usuario, nao ao diretorio do plugin. Quando instalado via marketplace, os arquivos sao copiados para `~/.claude/plugins/cache/`. O path `scripts/antigravity-bridge.js` resolve para `<projeto-do-usuario>/scripts/antigravity-bridge.js` que nao existe. |
| E2 | **`resolveAgyExe()` e Windows-only** | Plugin nao executa ConPTY no macOS/Linux | Usa `where` (Windows) para localizar o binario. Fallback hardcoded em `LOCALAPPDATA`. No macOS/Linux, cai direto no `spawnSync` sem ConPTY. |
| E3 | **`loadNodePty()` com path hardcoded** | ConPTY falha se AGY mudar path de instalacao | Busca `node-pty` apenas em `LOCALAPPDATA/agy/node_modules/node-pty`. Fragil e acoplado ao layout interno do AGY. |
| E4 | **`globSync` importado de `node:fs`** | Incompatibilidade com Node < 22 | `import { globSync } from "node:fs"` so esta disponivel a partir do Node.js 22. Usuarios com Node 18/20 LTS terao `TypeError: globSync is not a function`. |
| E5 | **Timeout hardcoded (120s) ignora `--print-timeout` do AGY** | Tasks longas falham sem configuracao | AGY CLI aceita `--print-timeout` (default 5m), mas o bridge usa `CONPTY_TIMEOUT_MS = 120_000` fixo. |

### 2.2 Gaps de Negocio (Funcionalidades ausentes)

| # | Gap | Requisito do Usuario | Estado Atual |
|---|-----|---------------------|--------------|
| N1 | **Selecao de modelo nao funcional** | "possibilidade de definir o modelo de acordo com os comandos disponiveis" | `--model` e aceito mas explicitamente NAO e encaminhado ao AGY. O agente diz "Do NOT add `--model`". Nao ha nenhum mecanismo para selecionar o modelo. |
| N2 | **Sem continuidade de conversas** | AGY suporta `--continue` e `--conversation <ID>` | O bridge trata toda chamada como one-shot. Nao ha como manter um thread de conversa com o AGY. |
| N3 | **`--add-dir` do AGY nao utilizado** | AGY tem flag nativa para adicionar diretorios ao workspace | O bridge le manualmente todos os arquivos e injeta no prompt como texto. Isso duplica trabalho, nao escala para contextos grandes, e ignora a capacidade nativa do AGY. |
| N4 | **Sem modo interativo** | AGY suporta `--prompt-interactive` / `-i` | O bridge so usa `--print` (non-interactive). Nao ha opcao para iniciar uma sessao interativa guiada pelo Claude. |
| N5 | **Sem sandbox passthrough** | AGY suporta `--sandbox` | O bridge nao permite ativar o sandbox do AGY para execucao segura de comandos. |
| N6 | **Sem `--dangerously-skip-permissions`** | AGY suporta auto-approval | Para automacoes CI/CD, nao ha como desativar prompts de permissao do AGY. |
| N7 | **Sem streaming de output** | Feedback em tempo real para tasks longas | O bridge (via ConPTY) coleta todo output e so escreve no final. Para tasks de 1-2 minutos, o usuario fica sem feedback. |

### 2.3 Gaps de Conformidade com Padroes Claude Code Plugin

| # | Gap | Padrao Esperado | Estado Atual |
|---|-----|----------------|--------------|
| P1 | **`plugin.json` incompleto** | `displayName`, `license`, `homepage`, `repository`, component paths | Faltam `displayName`, `license`, `homepage`, `repository`. Nao declara paths de components (`skills`, `commands`, `agents`). |
| P2 | **`agents/openai.yaml` em formato incorreto** | Agentes Claude Code sao arquivos `.md` com frontmatter YAML | Arquivo YAML puro — formato de agente Codex/OpenAI, nao reconhecido pelo sistema de plugins Claude Code. |
| P3 | **Sem hooks** | Plugins podem declarar hooks para eventos do ciclo de vida | Nenhum hook definido. Um `SessionStart` hook poderia validar instalacao do AGY. |
| P4 | **Sem `bin/` directory** | Scripts podem ser expostos como executaveis via `bin/` | O bridge so e acessivel via `node scripts/antigravity-bridge.js`. |
| P5 | **Sem uso de `${CLAUDE_PLUGIN_ROOT}`** | Paths de scripts devem usar a variavel do plugin | Todos os paths sao relativos ao CWD. Quando instalado, o CWD e o projeto do usuario, nao o plugin. |
| P6 | **marketplace.json com `$schema` possivelmente invalido** | Schema URL deve ser valida | Usa `https://anthropic.com/claude-code/marketplace.schema.json` — URL nao confirmada. |
| P7 | **Sem `settings.json` do plugin** | Plugins podem shippar configuracoes default | Nao ha arquivo de configuracoes default. |
| P8 | **Sem `userConfig` para credenciais/preferencias** | `plugin.json` suporta `userConfig` para prompts de configuracao | O modelo AGY e outros parametros poderiam ser configurados via `userConfig` com prompt interativo. |

---

## 3. Plano de Acao

### Fase 1: Correcoes Criticas (E1-E5)

**Objetivo**: O plugin deve funcionar corretamente quando instalado via marketplace.

#### 1.1 Migrar paths para `${CLAUDE_PLUGIN_ROOT}` [E1, P5]

**Arquivos afetados**: `agents/antigravity-agent.md`, `commands/antigravity.md`, `SKILL.md`

Todas as referencias a `node scripts/antigravity-bridge.js` devem ser substituidas por:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js"
```

No agente (`agents/antigravity-agent.md`):
```markdown
## Command Patterns

Basic:
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" -- "<TASK>"

With directories:
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" --dirs src,docs -- "<TASK>"
```

No comando (`commands/antigravity.md`):
```markdown
## Execution Instructions
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" [--dirs <DIRS>] [--files <FILES>] -- "<TASK>"
```

No skill (`SKILL.md`):
```markdown
## Shared Runtime Contract
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" [options] <task>
```

#### 1.2 Cross-platform `resolveAgyExe()` [E2]

**Arquivo afetado**: `scripts/antigravity-bridge.js`

```javascript
function resolveAgyExe() {
  const isWin = process.platform === "win32";
  const whichCmd = isWin ? "where" : "which";
  const result = spawnSync(whichCmd, ["agy"], { encoding: "utf8", shell: false });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim().split(/\r?\n/)[0];
  }
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA ??
      path.join(process.env.USERPROFILE ?? "", "AppData", "Local");
    return path.join(localAppData, "agy", "bin", "agy.exe");
  }
  // macOS/Linux: check common install locations
  const home = process.env.HOME ?? "";
  for (const candidate of [
    path.join(home, ".local", "bin", "agy"),
    "/usr/local/bin/agy",
  ]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* try next */ }
  }
  return "agy"; // fallback to bare command
}
```

#### 1.3 Resolver `loadNodePty()` de forma robusta [E3]

**Arquivo afetado**: `scripts/antigravity-bridge.js`

Tornar a busca do `node-pty` mais resiliente, tentando multiplos paths e incluindo tratamento para macOS/Linux:

```javascript
function loadNodePty() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ??
      path.join(process.env.USERPROFILE ?? "", "AppData", "Local");
    candidates.push(path.join(localAppData, "agy", "node_modules", "node-pty"));
  }
  // Tentar node-pty do proprio ambiente
  candidates.push("node-pty");
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch { /* try next */ }
  }
  return null;
}
```

#### 1.4 Substituir `globSync` de `node:fs` [E4]

**Arquivo afetado**: `scripts/antigravity-bridge.js`

Opcao A (recomendada) — usar `node:path` + `node:fs` com walk recursivo manual:

```javascript
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function walkDirSync(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDirSync(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}
```

Opcao B — usar glob via `import { glob } from "node:fs/promises"` com check de versao e fallback.

Opcao C — adicionar dependencia `fast-glob` no `package.json`.

**Recomendacao**: Opcao A (zero dependencias, funciona em Node 18+). Para pattern matching de `--files`, implementar minimatch inline ou usar `path.matchesGlob()` (Node 22+) com fallback.

#### 1.5 Tornar timeout configuravel via `--print-timeout` [E5]

**Arquivo afetado**: `scripts/antigravity-bridge.js`

Adicionar flag `--timeout` ao bridge que e repassado ao AGY como `--print-timeout`:

```javascript
// Em parseCliArgs:
case "--timeout":
  parsed.timeout = takeOptionValue(argv, index, token);
  index += 1;
  break;

// Em buildAntigravityArgs:
export function buildAntigravityArgs({ prompt, timeout }) {
  const args = ["--print", prompt];
  if (timeout) {
    args.push("--print-timeout", timeout);
  }
  return args;
}
```

---

### Fase 2: Gaps de Negocio (N1-N7)

**Objetivo**: O plugin deve permitir selecao de modelo, continuidade de conversas e uso das features nativas do AGY.

#### 2.1 Implementar selecao de modelo [N1]

**Estrategia**: O AGY CLI nao expoe `--model` em headless mode. A selecao de modelo e feita via `~/.gemini/antigravity-cli/settings.json`. O bridge deve:

1. Aceitar `--model <name>` como argumento
2. Antes de invocar o AGY, ler o `settings.json` do AGY
3. Salvar o modelo atual, substituir pelo modelo solicitado
4. Apos execucao, restaurar o modelo original
5. Se falhar, documentar que o modelo deve ser configurado via `/model` no AGY

**Arquivos afetados**: `scripts/antigravity-bridge.js`

```javascript
const AGY_SETTINGS_PATH = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "",
  ".gemini", "antigravity-cli", "settings.json"
);

async function withModelOverride(model, fn) {
  if (!model) return fn();

  let originalSettings;
  try {
    originalSettings = await fs.readFile(AGY_SETTINGS_PATH, "utf8");
  } catch { originalSettings = null; }

  const settings = originalSettings ? JSON.parse(originalSettings) : {};
  const previousModel = settings.model;
  settings.model = model;

  await fs.writeFile(AGY_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  try {
    return await fn();
  } finally {
    if (originalSettings) {
      await fs.writeFile(AGY_SETTINGS_PATH, originalSettings);
    } else if (previousModel === undefined) {
      delete settings.model;
      await fs.writeFile(AGY_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    }
  }
}
```

**Nota**: Este approach tem race condition se multiplas instancias do bridge rodam simultaneamente. Para mitigar, usar file lock ou aceitar a limitacao documentada.

**Alternativa mais simples**: Verificar se o AGY aceita variavel de ambiente para model override (ex: `ANTIGRAVITY_MODEL`). Se sim, usar `env` no spawn em vez de modificar o settings.json.

**Modelos conhecidos disponveis no AGY**:
- `gemini-2.5-pro` (default)
- `gemini-2.5-flash`
- `gemini-2.0-flash`
- Outros modelos via Google AI Studio / Vertex AI

Atualizar o agente e o comando para remover "Do NOT add `--model`" e documentar o uso:

```markdown
## Model Selection

| Flag | Behavior |
|------|----------|
| `--model gemini-2.5-flash` | Temporarily sets AGY to use Gemini 2.5 Flash for this call |
| `--model gemini-2.5-pro` | Uses Gemini 2.5 Pro (typically the default) |
| (no flag) | Uses whatever model is configured in AGY settings |
```

#### 2.2 Implementar continuidade de conversas [N2]

**Arquivos afetados**: `scripts/antigravity-bridge.js`, `commands/antigravity.md`, `agents/antigravity-agent.md`

Adicionar flags `--continue` e `--conversation <ID>`:

```javascript
// Em parseCliArgs:
case "--continue":
case "-c":
  parsed.continueConversation = true;
  break;
case "--conversation":
  parsed.conversationId = takeOptionValue(argv, index, token);
  index += 1;
  break;

// Em buildAntigravityArgs:
export function buildAntigravityArgs({ prompt, timeout, continueConversation, conversationId }) {
  const args = [];
  if (continueConversation) args.push("--continue");
  if (conversationId) args.push("--conversation", conversationId);
  args.push("--print", prompt);
  if (timeout) args.push("--print-timeout", timeout);
  return args;
}
```

Atualizar o comando para documentar:

```markdown
| `--continue` | Continue the most recent AGY conversation |
| `--conversation <ID>` | Resume a specific AGY conversation by ID |
```

#### 2.3 Integrar `--add-dir` nativo do AGY [N3]

**Estrategia dual**: Manter a ingestao manual de arquivos (para construir prompt contextualizado) E passar `--add-dir` ao AGY para que ele tenha acesso nativo aos diretorios.

```javascript
// Em buildAntigravityArgs:
export function buildAntigravityArgs({ prompt, timeout, dirs, addDirs }) {
  const args = [];
  // Passar --add-dir para cada diretorio (AGY workspace nativo)
  for (const dir of addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  args.push("--print", prompt);
  if (timeout) args.push("--print-timeout", timeout);
  return args;
}
```

Adicionar flag `--add-dir` ao bridge que e repassada diretamente ao AGY, separada de `--dirs` (que controla a ingestao manual):

```markdown
| `--dirs <paths>` | Inline files into the bridge prompt (manual ingestion) |
| `--add-dir <path>` | Add directory to AGY workspace (native, repeatable) |
```

#### 2.4 Adicionar flags `--sandbox` e `--skip-permissions` [N5, N6]

**Arquivo afetado**: `scripts/antigravity-bridge.js`

```javascript
// Em parseCliArgs:
case "--sandbox":
  parsed.sandbox = true;
  break;
case "--skip-permissions":
  parsed.skipPermissions = true;
  break;

// Em buildAntigravityArgs:
if (sandbox) args.push("--sandbox");
if (skipPermissions) args.push("--dangerously-skip-permissions");
```

#### 2.5 Streaming de output [N7]

**Arquivo afetado**: `scripts/antigravity-bridge.js`

Na funcao `spawnViaConPty`, escrever chunks conforme recebidos em vez de acumular:

```javascript
async function spawnViaConPty(agyExe, agyArgs, pty, timeoutMs, _stdout) {
  return new Promise((resolve, reject) => {
    const term = pty.spawn(agyExe, agyArgs, { /* ... */ });

    const timer = setTimeout(() => {
      try { term.kill(); } catch {}
      reject(new Error(`agy did not respond within ${timeoutMs / 1000}s.`));
    }, timeoutMs);

    term.onData((data) => {
      const clean = stripAnsi(data);
      _stdout.write(clean); // streaming em vez de acumular
    });

    term.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve(exitCode ?? 1);
    });
  });
}
```

---

### Fase 3: Conformidade com Padroes Claude Code Plugin (P1-P8)

**Objetivo**: O plugin deve seguir todos os padroes documentados do sistema de plugins Claude Code.

#### 3.1 Completar `plugin.json` [P1]

**Arquivo**: `.claude-plugin/plugin.json`

```json
{
    "name": "cc-antigravity-plugin",
    "displayName": "Antigravity CLI Integration",
    "version": "3.0.0",
    "description": "Integrate Antigravity CLI (AGY) for long-context code exploration with model selection and conversation continuity",
    "author": {
        "name": "Allan Harlen",
        "email": "allanharlen@gmail.com"
    },
    "homepage": "https://github.com/AllanHarlen/cc-antigravity-plugin",
    "repository": "https://github.com/AllanHarlen/cc-antigravity-plugin",
    "license": "MIT",
    "keywords": [
        "antigravity", "agy", "google", "gemini",
        "code-exploration", "analysis", "long-context",
        "documentation", "codex", "claude-code"
    ],
    "skills": "./",
    "commands": ["./commands/antigravity.md"],
    "agents": ["./agents/antigravity-agent.md"],
    "hooks": "./hooks/hooks.json"
}
```

#### 3.2 Converter ou remover `agents/openai.yaml` [P2]

**Opcao A (recomendada)**: Remover o arquivo. O Codex le o `SKILL.md` diretamente quando o repositorio e instalado como skill.

**Opcao B**: Converter para `.md` com frontmatter se houver necessidade de manter um agente separado para Codex:

```markdown
---
name: antigravity-codex-agent
description: Use Antigravity CLI for large cross-file analysis (Codex variant)
---

(conteudo do skill adaptado para Codex)
```

**Recomendacao**: Opcao A. O `agents/openai.yaml` e um artefato do Codex que nao tem funcao no sistema de plugins Claude Code.

#### 3.3 Adicionar hooks [P3]

**Arquivo**: `hooks/hooks.json`

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/scripts/check-agy.sh\""
          }
        ]
      }
    ]
  }
}
```

**Arquivo**: `scripts/check-agy.sh` (e `scripts/check-agy.ps1` para Windows)

Script que verifica se o AGY CLI esta instalado e autenticado. Retorna silenciosamente se ok, ou emite um warning se nao encontrado.

**Nota**: Como o plugin roda em Windows (ambiente do usuario), considerar um hook multiplataforma usando Node:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/check-agy.js\""
          }
        ]
      }
    ]
  }
}
```

#### 3.4 Adicionar `bin/` directory [P4]

**Estrutura**:
```
bin/
  antigravity-bridge     # symlink ou wrapper para scripts/antigravity-bridge.js
```

Isso permite que o bridge seja invocado como `antigravity-bridge` diretamente no Bash tool quando o plugin esta ativo.

#### 3.5 Adicionar `userConfig` para preferencias [P8]

**Arquivo**: `.claude-plugin/plugin.json` (adicionar seçao `userConfig`)

```json
{
    "userConfig": {
        "default_model": {
            "type": "string",
            "title": "Default AGY Model",
            "description": "Model to use when --model is not specified (e.g., gemini-2.5-pro, gemini-2.5-flash)",
            "default": "gemini-2.5-pro"
        },
        "timeout": {
            "type": "string",
            "title": "Default Timeout",
            "description": "Default timeout for AGY print mode (e.g., 2m, 5m)",
            "default": "5m0s"
        }
    }
}
```

Os valores ficam disponiveis como `${user_config.default_model}` nos skills e como `CLAUDE_PLUGIN_OPTION_DEFAULT_MODEL` env var nos scripts.

---

### Fase 4: Qualidade e Distribuicao

#### 4.1 Atualizar testes

**Arquivos afetados**: `tests/antigravity-bridge.test.js`, `tests/antigravity-main.test.js`

Novos testes necessarios:
- `parseCliArgs` com `--continue`, `--conversation`, `--timeout`, `--sandbox`, `--skip-permissions`, `--add-dir`
- `buildAntigravityArgs` emitindo `--continue`, `--conversation <ID>`, `--print-timeout`, `--add-dir`, `--sandbox`, `--dangerously-skip-permissions`
- `buildAntigravityArgs` com `--model` (verificar que o modelo NAO aparece nos args do AGY — e tratado via settings)
- `withModelOverride` (mock do filesystem para settings.json)
- Streaming no ConPTY (verificar que chunks sao escritos incrementalmente)
- `resolveAgyExe` cross-platform (mock de `which`/`where`)
- Compatibilidade do walk recursivo (substituicao do `globSync`)

#### 4.2 Atualizar marketplace.json

**Arquivo**: `.claude-plugin/marketplace.json`

```json
{
    "name": "cc-antigravity-plugin",
    "description": "Antigravity CLI (AGY) integration for Claude Code with model selection, conversation continuity, and shared runtime support",
    "owner": {
        "name": "Allan Harlen",
        "email": "allanharlen@gmail.com"
    },
    "plugins": [
        {
            "name": "cc-antigravity-plugin",
            "displayName": "Antigravity CLI Integration",
            "description": "Invoke Antigravity CLI (AGY) for long-context code exploration, architecture review, and codebase analysis with model selection and conversation continuity",
            "version": "3.0.0",
            "author": {
                "name": "Allan Harlen",
                "email": "allanharlen@gmail.com"
            },
            "source": "./",
            "category": "integrations",
            "tags": ["antigravity", "agy", "google", "gemini", "long-context", "code-exploration"],
            "keywords": ["antigravity", "agy", "google", "code-exploration", "analysis"],
            "homepage": "https://github.com/AllanHarlen/cc-antigravity-plugin",
            "repository": "https://github.com/AllanHarlen/cc-antigravity-plugin",
            "license": "MIT"
        }
    ]
}
```

#### 4.3 Atualizar documentacao dos components

Atualizar todos os `.md` de agente, comando e skill para:
- Remover "Do NOT add `--model`" e documentar o suporte a model selection
- Adicionar documentacao de `--continue`, `--conversation`, `--timeout`, `--add-dir`
- Adicionar documentacao de `--sandbox` e `--skip-permissions`
- Usar `${CLAUDE_PLUGIN_ROOT}` em todos os paths de exemplo

#### 4.4 Adicionar `LICENSE` (MIT)

Criar arquivo `LICENSE` na raiz do projeto.

---

## 4. Estrutura Final Proposta

```
cc-antigravity-plugin/
├── .claude-plugin/
│   ├── plugin.json              # Manifesto completo com userConfig
│   └── marketplace.json         # Marketplace atualizado
├── agents/
│   └── antigravity-agent.md     # Agente atualizado com model/continue support
├── commands/
│   └── antigravity.md           # Comando atualizado com novas flags
├── hooks/
│   └── hooks.json               # SessionStart para validar AGY
├── bin/
│   └── antigravity-bridge       # Wrapper executavel
├── scripts/
│   ├── antigravity-bridge.js    # Bridge refatorado (cross-platform, model, continue, streaming)
│   └── check-agy.js             # Script de validacao do AGY
├── tests/
│   ├── antigravity-bridge.test.js  # Testes atualizados
│   └── antigravity-main.test.js    # Testes de main() atualizados
├── SKILL.md                     # Skill root-level atualizado
├── package.json                 # Atualizado para v3.0.0
├── LICENSE                      # MIT
└── .gitignore
```

---

## 5. Ordem de Execucao

```
Fase 1 (Critica — plugin nao funciona sem isso)
  ├── 1.4  Substituir globSync          ~30min
  ├── 1.1  Migrar paths para PLUGIN_ROOT ~20min
  ├── 1.2  Cross-platform resolveAgyExe  ~20min
  ├── 1.3  loadNodePty robusto           ~15min
  └── 1.5  Timeout configuravel          ~15min

Fase 2 (Negocio — features solicitadas)
  ├── 2.1  Model selection               ~1h
  ├── 2.2  Continuidade de conversas     ~30min
  ├── 2.3  Integrar --add-dir            ~30min
  ├── 2.4  --sandbox e --skip-permissions ~15min
  └── 2.5  Streaming de output           ~30min

Fase 3 (Conformidade — padroes do ecossistema)
  ├── 3.1  Completar plugin.json         ~15min
  ├── 3.2  Remover openai.yaml           ~5min
  ├── 3.3  Adicionar hooks               ~30min
  ├── 3.4  Adicionar bin/                ~10min
  └── 3.5  userConfig                    ~20min

Fase 4 (Qualidade)
  ├── 4.1  Atualizar testes              ~1h
  ├── 4.2  Atualizar marketplace.json    ~15min
  ├── 4.3  Atualizar docs dos components ~30min
  └── 4.4  Adicionar LICENSE             ~5min
```

**Estimativa total**: ~7-8 horas de trabalho

---

## 6. Riscos e Mitigacoes

| Risco | Probabilidade | Impacto | Mitigacao |
|-------|--------------|---------|-----------|
| Model override via settings.json tem race condition com execucoes paralelas | Media | Medio | Documentar limitacao. Investigar env var alternativa. |
| AGY muda formato do settings.json em futuras versoes | Baixa | Alto | Ler/escrever apenas o campo `model`, preservar campos desconhecidos. |
| `--add-dir` nao funciona com `--print` mode | Media | Medio | Testar antes de implementar. Se nao funcionar, manter apenas ingestao manual. |
| `node-pty` nao disponivel em nenhum path | Baixa | Baixo | Fallback para `spawnSync` ja existe e funciona. |
| `--continue` perde contexto entre sessoes Claude Code | Alta | Baixo | O AGY gerencia suas proprias conversas; o bridge so repassa o ID. |
| Node < 22 nao suporta `path.matchesGlob()` | Alta | Medio | Implementar minimatch manual ou usar regex simples para globs basicos. |

---

## 7. Criterios de Aceitacao

- [ ] Plugin instala e funciona via `/plugin marketplace add ./` e `/plugin install`
- [ ] `--model gemini-2.5-flash` altera temporariamente o modelo do AGY
- [ ] `--continue` retoma a conversa mais recente do AGY
- [ ] `--conversation <ID>` retoma uma conversa especifica
- [ ] `--timeout 3m` e repassado como `--print-timeout 3m`
- [ ] `--add-dir src` e repassado nativamente ao AGY
- [ ] `--sandbox` ativa sandbox do AGY
- [ ] Output e exibido em streaming durante execucao
- [ ] `npm test` passa em Node 18, 20 e 22
- [ ] Plugin funciona em Windows, macOS e Linux
- [ ] `SessionStart` hook valida instalacao do AGY silenciosamente
- [ ] `antigravity-bridge` disponivel como comando via `bin/`
- [ ] Todos os paths nos .md usam `${CLAUDE_PLUGIN_ROOT}`
