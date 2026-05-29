# Casos de Uso — cc-antigravity-plugin

Exemplos práticos de uso do plugin em cenários reais de desenvolvimento. Cada caso de uso inclui o comando, o que esperar e como verificar o resultado.

---

## UC01 — Smoke test / conectividade

Confirmar que o plugin está instalado e o AGY está acessível antes de qualquer tarefa real.

```
/cc-antigravity-plugin:antigravity --read-only "Responda apenas: plugin-ok"
```

**Saída esperada:** `plugin-ok`

---

## UC02 — Análise de arquitetura (read-only)

Entender a estrutura de um projeto sem modificar nada.

```
/cc-antigravity-plugin:antigravity --read-only --dirs src,docs \
  "Explique a arquitetura deste projeto. Cite os arquivos-chave e os principais fluxos de dados."
```

**Quando usar:** revisão de código antes de uma refatoração, onboarding em projeto desconhecido, documentação de decisões arquiteturais.

---

## UC03 — Refatoração multi-arquivo

Refatorar código que atravessa múltiplos arquivos em uma única chamada.

```
/cc-antigravity-plugin:antigravity \
  "Refatore o módulo auth para usar async/await em vez de callbacks. Atualize todos os callers. Reporte os arquivos alterados."
```

**Quando usar:** migrações de padrão (callbacks → promises → async/await), renomeação de interfaces, mudança de assinaturas de funções.

---

## UC04 — Geração de arquivo

Criar um novo arquivo a partir de dados ou especificação existente no projeto.

```
/cc-antigravity-plugin:antigravity \
  "Leia os arquivos em src/routes/ e gere docs/api.md com a documentação de todas as rotas: método, path, parâmetros e descrição."
```

**Verificar:** `! cat docs/api.md`

---

## UC05 — Análise de impacto antes de uma mudança

Entender o que vai quebrar antes de fazer uma alteração crítica.

```
/cc-antigravity-plugin:antigravity --read-only --model gemini-3.1-pro-low \
  "Se eu remover a função `getUserById` de src/services/user.js, quais arquivos seriam afetados? Liste com o motivo de cada um."
```

**Quando usar:** antes de deletar código, remover dependências, mudar APIs internas.

---

## UC06 — Modelo específico para raciocínio profundo

Usar Pro para tarefas que exigem mais raciocínio (design de schema, algoritmos, análise de segurança).

```
/cc-antigravity-plugin:antigravity --model gemini-3.1-pro-low \
  "Projete o schema do banco de dados para um sistema de e-commerce com produtos, pedidos, usuários e pagamentos. Inclua índices e justifique as decisões."
```

**Modelos disponíveis para raciocínio:** `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `claude-4.6-sonnet-thinking`, `claude-4.6-opus-thinking`

**Modelo para geração de imagem:** `nano-banana` (via `--generate-imagem`)

---

## UC07 — Seleção automática de modelo (`--model auto`)

Deixar o bridge escolher o modelo baseado no tamanho do contexto inline.

```
/cc-antigravity-plugin:antigravity --model auto --dirs src \
  "Identifique os 3 maiores riscos de segurança neste código e sugira correções."
```

**Lógica de seleção:**

| Contexto inline total | Modelo selecionado |
|---|---|
| < 32 KB | `gemini-3.5-flash-low` |
| 32 KB – 256 KB | `gemini-3.5-flash-medium` |
| ≥ 256 KB | `gemini-3.5-flash-high` |

**Verificado em runtime:** `source:"auto"`, `model:"gemini-3.5-flash-low"`, `contextBytes:0` ✅

---

## UC08 — Tarefa longa com heartbeat

Análises exaustivas que levam mais tempo que o timeout padrão por linha de output.

```
/cc-antigravity-plugin:antigravity --timeout 15m \
  "Analise todos os arquivos em scripts/ e tests/. Para cada função exportada, descreva o que ela faz, seus parâmetros e valor de retorno."
```

**Comportamento:** o timer de 15 min reseta a cada chunk de output — a tarefa só expira se o AGY ficar completamente silencioso por 15 minutos consecutivos.

---

## UC09 — Sessão contínua (`--continue`)

Retomar o contexto de uma conversa anterior para tarefas em múltiplos passos.

**Passo 1 — Leitura inicial:**
```
/cc-antigravity-plugin:antigravity --read-only \
  "Leia src/auth/ e liste todas as funções exportadas com uma linha de descrição cada."
```

**Passo 2 — Continuação sem re-ler:**
```
/cc-antigravity-plugin:antigravity --continue \
  "Com base na leitura anterior, implemente testes unitários para as 3 funções mais críticas."
```

**Quando usar:** tarefas divididas em etapas (leitura → análise → implementação), continuação após QUOTA_EXAUSTED.

---

## UC10 — Inspecionar comando sem executar (`--print-command`)

Ver o comando `agy` que seria executado, sem gastar cota.

```
/cc-antigravity-plugin:antigravity --print-command --model gemini-3.1-pro-low \
  --dirs scripts --timeout 5m "analisar auth"
```

**Útil para:** depuração, verificar quais arquivos serão injetados no contexto, confirmar flags antes de uma tarefa longa.

**O que aparece no output:** `--add-dir <cwd>`, `--dangerously-skip-permissions`, `--print`, `--print-timeout 5m` e o prompt completo com os arquivos de `scripts/` inline.

> `--model` não aparece nos args do `agy` — é aplicado via `settings.json` antes do spawn.

---

## UC11 — Recuperação de QUOTA_EXAUSTED

Quando o AGY atinge o limite de cota, o bridge emite um sinal estruturado e indica como retomar.

**Sinal emitido (stdout):**
```json
{
  "status": "QUOTA_EXAUSTED",
  "reason": "quota or rate limit reached",
  "model": "gemini-3.5-flash-medium",
  "retry": "--continue"
}
```

**Exit code:** `10`

**Para retomar após reset de cota:**
```
/cc-antigravity-plugin:antigravity --continue "Continue a partir de onde parou."
```

---

## UC12 — Geração de imagem com Nano Banana (`--generate-imagem`)

Gerar uma imagem a partir de uma descrição textual usando o modelo Nano Banana do AGY.

```
/cc-antigravity-plugin:antigravity --generate-imagem \
  "um skyline futurista ao pôr do sol, estilo cyberpunk, tons de roxo e laranja"
```

**O que acontece internamente:**
1. O bridge define `--model nano-banana` automaticamente (sem precisar passar `--model`)
2. O prompt enviado ao AGY inclui a constraint `generate_imagem` em vez das constraints de edição de código
3. AGY usa a tool `generate_imagem` com a descrição e salva o arquivo em `~/.gemini/antigravity-cli/brain/`
4. O bridge varre esse diretório por arquivos de imagem criados após o início da sessão e os copia para o diretório de destino
5. O path do arquivo copiado é reportado no output: `Image saved: <nome-do-arquivo>`

**Com contexto de estilo (arquivos de referência):**
```
/cc-antigravity-plugin:antigravity --generate-imagem --files "brand/style.json" \
  "logotipo para o produto seguindo o guia de identidade visual"
```

**Com diretório de destino específico:**
```
/cc-antigravity-plugin:antigravity --generate-imagem --output-dir ./assets \
  "banner para a página inicial, estilo minimalista"
```

**Sobrescrever o modelo:**
```
/cc-antigravity-plugin:antigravity --generate-imagem --model gemini-3.1-pro-high \
  "uma ilustração técnica detalhada de uma arquitetura de microserviços"
```

**Quando usar:** geração de assets visuais, mockups, ícones, ilustrações, diagramas e imagens para documentação.

**Verificar:** o bridge imprime `Image saved: <nome>.png` (ou `.jpg`/`.webp`) ao final. O arquivo fica no diretório de destino (`--output-dir`) ou no cwd.

---

## Resultados de testes em runtime

| Caso | Funcionalidade validada | Status | Observação |
|---|---|---|---|
| UC01 | Conectividade / smoke test | ✅ | `plugin-ok` retornado |
| UC02 | Análise read-only | ✅ | Sem modificações no workspace |
| UC06 `gemini-3.1-pro-low` | Model forwarding via settings.json | ✅ | AGY reportou `Gemini 3.1 Pro` |
| UC06 `gemini-3.5-flash-high` | Identifier `gemini-3.5-flash-high` | ✅ | AGY reportou `Gemini 3.5 Flash` |
| UC07 | `--model auto` contexto vazio | ✅ | `source:"auto"`, `model:"gemini-3.5-flash-low"`, `contextBytes:0` |
| UC12 | `--generate-imagem` flag + nano-banana + `copyGeneratedImages` | ✅ | Implementado e documentado |
| UC04/UC03 | Modo agêntico (criar/editar arquivos) | ⬜ | Pendente |
| UC09 | `--continue` retomar sessão | ⬜ | Pendente |
| UC08 | Heartbeat tarefa longa | ⬜ | Pendente |
