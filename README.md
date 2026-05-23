# cc-antigravity-plugin

Dá ao Claude Code e ao Codex uma **visão de satélite de contexto longo** sobre qualquer base de código, roteando tarefas de análise pelo [Antigravity CLI (AGY)](https://antigravity.google).

O Claude Code é excelente para edições precisas arquivo por arquivo. O Antigravity é excelente para ler uma base de código inteira — ou uma fatia grande dela — em uma única passagem e sintetizar descobertas em dezenas de arquivos ao mesmo tempo. Este plugin conecta os dois para que você possa continuar no Claude Code e delegar qualquer tarefa de análise ampla ao Antigravity com um único comando.

---

## Quando usar

| Situação | Por que o Antigravity resolve |
|----------|-------------------------------|
| "Qual é a arquitetura deste projeto?" | Precisa de um mapa cross-file, não de leitura linha por linha |
| "O que quebra se eu refatorar o módulo de auth?" | Rastreia chamadores e dependências entre módulos |
| "Faça uma auditoria de segurança do fluxo de pagamento" | Segue dados entre múltiplos arquivos e serviços |
| "Gere documentação para este serviço" | Sintetiza comportamento a partir de muitos arquivos-fonte |
| "Resuma as breaking changes nesses schemas JSON" | Lê dados estruturados lado a lado em uma única passagem |
| "Acabei de clonar este repo — me oriente" | Produz um mapa de alto nível mais rápido do que arquivo por arquivo |

**Não é a ferramenta certa para:** edições em arquivo único, loops de debug, ou qualquer tarefa sem componente cross-file relevante — o roundtrip ao AGY adiciona latência desnecessária nesses casos.

---

## Pré-requisitos

**1. Instalar o Antigravity CLI**

```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Windows (PowerShell)
irm https://antigravity.google/cli/install.ps1 | iex
```

**2. Autenticar**

Execute `agy` uma vez de forma interativa para concluir o login com Google:

```bash
agy
```

**3. Verificar que funciona**

```bash
agy --print "what is 2+2"
```

---

## Instalação

### Claude Code

```bash
/plugin marketplace add AllanHarlen/cc-antigravity-plugin
/plugin install cc-antigravity-plugin@cc-antigravity-plugin
/reload-plugins
```

Para atualizar:

```bash
/plugin marketplace update cc-antigravity-plugin
/reload-plugins
```

### Codex

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/AllanHarlen/cc-antigravity-plugin.git \
  ~/.agents/skills/cc-antigravity-plugin
```

Reinicie o Codex após clonar. Para atualizar:

```bash
git -C ~/.agents/skills/cc-antigravity-plugin pull
```

---

## Como usar

### Claude Code — slash command

```bash
/cc-antigravity-plugin:antigravity <tarefa>
/cc-antigravity-plugin:antigravity --dirs <caminhos> <tarefa>
/cc-antigravity-plugin:antigravity --files <globs> <tarefa>
```

### Claude Code — subagente

O Claude Code também pode acionar o `antigravity-agent` automaticamente quando uma tarefa se beneficia claramente de uma passagem de contexto longo (revisão de arquitetura, impacto de refatoração, auditoria de segurança). O agente seleciona o escopo correto e executa o bridge por conta própria.

### Codex — skill

```text
$antigravity-integration
```

Ou peça ao Codex para usar a integração Antigravity em uma tarefa de análise ampla.

---

## Opções

| Opção | Descrição |
|-------|-----------|
| `--dirs <caminho,...>` | Injeta recursivamente um ou mais diretórios. Separe múltiplos caminhos com vírgula: `--dirs src,docs,lib` |
| `--files <glob,...>` | Injeta arquivos que correspondem a padrões glob. Suporta múltiplos globs: `--files "**/*.json,data/**/*.csv"` |
| `--max-files <n>` | Número máximo de arquivos injetados (padrão: 40). Aumente para varreduras mais amplas, reduza para ficar dentro dos limites do AGY. |
| `--max-file-bytes <n>` | Tamanho máximo por arquivo em bytes (padrão: 32768). Arquivos maiores são truncados e sinalizados no inventário. |
| `--print-command` | Imprime o comando `agy` resolvido sem executá-lo. Útil para depurar o escopo antes de rodar. |
| `--model <nome>` | Aceito por compatibilidade de API, mas não repassado ao AGY. Configure o modelo pelas configurações do AGY. |

**Guia de escopo:**
- `--dirs` — áreas amplas de módulo ou serviço onde você quer contexto completo
- `--files` — globs precisos ou fontes de dados mistas (JSON + CSV + Markdown juntos)
- Use os dois quando precisar de contexto amplo de código junto com arquivos de dados específicos

---

## Exemplos

### Revisão de arquitetura

```bash
/cc-antigravity-plugin:antigravity --dirs src,docs \
  "Explique a arquitetura. Identifique os módulos principais, suas responsabilidades e o fluxo de dados entre eles."
```

### Análise de impacto de refatoração

```bash
/cc-antigravity-plugin:antigravity --dirs src \
  "Analise o impacto de refatorar o módulo de auth. Liste os arquivos afetados, call sites quebrados e os passos de migração."
```

### Auditoria de segurança

```bash
/cc-antigravity-plugin:antigravity --dirs src \
  "Audite o fluxo de pagamento em busca de problemas de segurança. Foco em validação de entrada, verificações de autenticação e exposição de dados."
```

### Revisão de mudanças em schemas

```bash
/cc-antigravity-plugin:antigravity --files "schemas/**/*.json,migrations/**/*.sql" \
  "Resuma as breaking changes entre esses schemas e migrations. Sinalize campos removidos ou mudanças de tipo."
```

### Orientação em codebase novo

```bash
/cc-antigravity-plugin:antigravity --dirs . \
  "Acabei de entrar neste projeto. Me dê uma orientação de 10 minutos: estrutura, arquivos-chave, fluxos principais e pontos de atenção."
```

### Depurar escopo antes de executar

```bash
node scripts/antigravity-bridge.js --dirs src --print-command "analisar auth"
# imprime o comando agy resolvido sem executá-lo
```

---

## Como funciona

Tanto o Claude Code quanto o Codex roteiam pelo bridge compartilhado em
`scripts/antigravity-bridge.js`:

```
/cc-antigravity-plugin:antigravity --dirs src "analisar auth"
        │
        ▼
scripts/antigravity-bridge.js
  1. Resolve --dirs e --files em uma lista de arquivos ordenada e deduplicada
  2. Filtra binários e caminhos ignorados (node_modules, dist, .git, …)
  3. Trunca arquivos maiores que --max-file-bytes e os sinaliza no inventário
  4. Monta um prompt estruturado:
       <context_inventory>  ← lista de arquivos com tamanhos e flags de truncamento
       <context_files>      ← conteúdo inline dos arquivos (closing tags escapadas)
       <task>               ← sua pergunta
       <constraints>        ← regras de citação e honestidade para o AGY
  5. Executa: agy --print <prompt>
        │
        ▼
  6. No Windows: captura output via ConPTY (node-pty) com timeout de 120s
     Em outras plataformas: fallback via spawnSync
  7. Remove sequências ANSI, escreve output UTF-8 limpo no stdout
        │
        ▼
Claude Code recebe a análise e apresenta para você
```

---

## Estrutura do repositório

```text
cc-antigravity-plugin/
├── .claude-plugin/
│   ├── marketplace.json            ← metadados do registro de plugins
│   └── plugin.json                 ← manifesto do plugin
├── agents/
│   ├── antigravity-agent.md        ← definição do subagente do Claude Code
│   └── openai.yaml                 ← metadados da skill para o Codex
├── commands/
│   └── antigravity.md              ← comando /cc-antigravity-plugin:antigravity
├── scripts/
│   └── antigravity-bridge.js       ← runtime compartilhado (Node.js, ESM)
├── tests/
│   ├── antigravity-bridge.test.js  ← testes unitários: parser, coletor, prompt builder
│   └── antigravity-main.test.js    ← testes de integração: main() via injeção de dependência
├── SKILL.md                        ← definição da skill para o Codex
└── package.json
```

---

## Desenvolvimento

```bash
npm test          # executa os 42 testes
```

Os testes cobrem `parseCliArgs`, `collectContextFiles`, `buildAntigravityPrompt`,
`buildAntigravityArgs`, `stripAnsi` e `main()` (via injeção de dependência —
nenhum processo AGY real é iniciado durante os testes).

---

## Solução de problemas

| Problema | Solução |
|----------|---------|
| Erro de autenticação | Execute `agy` uma vez interativamente para concluir o login com Google. Use `/logout` dentro da TUI do AGY para limpar credenciais antigas. |
| `agy` não encontrado no PATH | Execute novamente o instalador: macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh \| bash` · Windows: `irm https://antigravity.google/cli/install.ps1 \| iex` |
| Override de modelo ignorado | `--model` é aceito mas não repassado. Configure o modelo via `~/.gemini/antigravity-cli/settings.json`. |
| Resposta truncada ou vazia | Reduza o escopo: menos `--dirs`, globs mais específicos em `--files`, ou diminua `--max-files`. |
| Bridge trava | O AGY tem timeout de 120s. Se disparar, verifique autenticação e rede. Execute `agy --print "test"` diretamente para isolar o problema. |
| Permissão negada ao iniciar `agy` | Verifique que o binário é executável: `chmod +x $(which agy)`. |

---

## Licença

MIT
