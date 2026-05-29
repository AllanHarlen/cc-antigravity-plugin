# Testes Manuais — cc-antigravity-plugin v3.4.0

Roteiro de validação em runtime contra o AGY real (Gemini). Execute em ordem — cada teste
valida uma funcionalidade específica e o que observar é descrito explicitamente.

---

## Pré-execução

```bash
# 1. Instalar/recarregar o plugin na sessão atual
/plugin install cc-antigravity-plugin@cc-antigravity-plugin
/reload-plugins

# 2. Confirmar que agy está acessível
! agy --version
```

**Esperado:** versão do AGY exibida (ex: `1.0.3`). Se falhar, rodar `agy` uma vez interativamente.

---

## T01 — Conectividade básica (smoke test)

**Objetivo:** confirmar que o bridge resolve o executável, passa pelo `--version` e retorna output.

```
/cc-antigravity-plugin:antigravity --read-only "Responda apenas: plugin-ok"
```

**Esperado:**
- Output contém `plugin-ok`
- Sem erros de autenticação ou `AGY_MISSING`
- Exit code 0

**Se falhar:** verificar `! cat "$env:LOCALAPPDATA\agy\cc-plugin-logs\plugin-$(Get-Date -Format yyyy-MM-dd).jsonl"` para o evento `agy.connectivity.check`.

---

## T02 — Model forwarding via settings.json

**Objetivo:** confirmar que `--model` efetivamente muda o modelo usado pelo AGY.

```
/cc-antigravity-plugin:antigravity --model gemini-3.1-pro-low --read-only "Qual modelo você está usando agora? Responda apenas o nome do modelo."
```

**Esperado:**
- AGY menciona `gemini-3.1-pro-low` ou `Gemini 3.1 Pro` na resposta
- Log mostra evento `agy.model.patch` com `"model":"gemini-3.1-pro-low"`

**Verificar log:**
```powershell
! cat "$env:LOCALAPPDATA\agy\cc-plugin-logs\plugin-$(Get-Date -Format yyyy-MM-dd).jsonl" | Select-String "model.patch|model.resolved"
```

**Se o modelo ignorar o settings.json:** o path `%LOCALAPPDATA%\agy\settings.json` não é o correto para esta versão do AGY. Verificar o arquivo criado e deletado:

```powershell
# Rodar em paralelo — observar a criação e remoção
! Get-ChildItem "$env:LOCALAPPDATA\agy\" -Filter "settings.json"
```

---

## T03 — Modelo atual (High) confirmação de identifier

**Objetivo:** confirmar que `gemini-3.5-flash-high` é o identifier correto do modelo atual.

```
/cc-antigravity-plugin:antigravity --model gemini-3.5-flash-high --read-only "Qual modelo você está usando? Responda apenas o nome."
```

**Esperado:** AGY confirma estar usando Flash High.

**Se recusar/ignorar:** o identifier pode ser diferente. Verificar o log para `agy.model.patch` e comparar com o que o AGY reporta.

---

## T04 — Modo agêntico: criar arquivo

**Objetivo:** validar que o AGY usa `write_to_file` e cria arquivos reais no workspace.

```
/cc-antigravity-plugin:antigravity "Crie o arquivo teste-agentico.txt na raiz do projeto com o conteúdo: AGY_AGENTICO_OK seguido da data e hora atual."
```

**Verificar:**
```powershell
! cat teste-agentico.txt
```

**Esperado:**
- Arquivo `teste-agentico.txt` criado na raiz
- Conteúdo contém `AGY_AGENTICO_OK` e uma data
- Exit code 0

**Limpar após o teste:**
```powershell
! Remove-Item teste-agentico.txt
```

---

## T05 — Modo agêntico: editar arquivo existente

**Objetivo:** validar `replace_file_content` / `multi_replace_file_content`.

```
/cc-antigravity-plugin:antigravity "Edite o arquivo package.json e adicione um campo 'testManual': true dentro do objeto JSON raiz. Não altere nenhum outro campo."
```

**Verificar:**
```powershell
! cat package.json
```

**Esperado:** `"testManual": true` presente em `package.json`.

**Reverter:**
```powershell
! git checkout -- package.json
```

---

## T06 — `--read-only` não modifica arquivos

**Objetivo:** garantir que `--read-only` desativa `--dangerously-skip-permissions` e que o AGY não edita arquivos.

```
/cc-antigravity-plugin:antigravity --read-only "Adicione um campo 'testReadOnly': true em package.json."
```

**Verificar:**
```powershell
! cat package.json | Select-String "testReadOnly"
```

**Esperado:** nenhuma linha encontrada — AGY não deve ter editado o arquivo em modo read-only.

---

## T07 — `--model auto` com contexto pequeno

**Objetivo:** verificar que `auto` seleciona `gemini-3.5-flash-low` quando não há contexto inline.

```
/cc-antigravity-plugin:antigravity --model auto --read-only "Responda apenas: auto-ok"
```

**Verificar no log:**
```powershell
! cat "$env:LOCALAPPDATA\agy\cc-plugin-logs\plugin-$(Get-Date -Format yyyy-MM-dd).jsonl" | Select-String "model.auto\|model.resolved"
```

**Esperado:** log mostra `source:"auto"` e `model:"gemini-3.5-flash-low"` (sem contexto inline, totalBytes = 0 < 32KB).

---

## T08 — `--model auto` com contexto grande

**Objetivo:** verificar que `auto` escala para `gemini-3.5-flash-high` com contexto grande.

```
/cc-antigravity-plugin:antigravity --model auto --dirs scripts,tests --read-only "Liste os arquivos incluídos no contexto e diga qual é o maior."
```

**Verificar no log:** evento `bridge.model.auto.resolved` deve mostrar `contextBytes` > 0 e modelo escalado.

**Esperado:** modelo selecionado é `gemini-3.5-flash-medium` ou `gemini-3.5-flash-high` dependendo do tamanho total dos arquivos.

---

## T09 — Heartbeat: tarefa longa sem timeout prematuro

**Objetivo:** confirmar que o timer de timeout reseta com cada chunk de output e não cancela tarefas longas ativas.

```
/cc-antigravity-plugin:antigravity --timeout 2m "Analise todos os arquivos em scripts/ e tests/ em detalhes. Para cada função exportada, descreva o que ela faz, seus parâmetros e valor de retorno. Seja exaustivo."
```

**Esperado:**
- Tarefa completa sem `EXIT_TIMEOUT` (exit code 12)
- Output streaming visível durante a execução
- Análise detalhada de todas as funções exportadas

**Se der timeout:** o heartbeat não está funcionando corretamente para esta combinação de PTY + OS.

---

## T10 — `--continue`: retomar sessão

**Objetivo:** validar que `--continue` retoma o contexto da conversa anterior.

**Passo 1 — Iniciar uma tarefa:**
```
/cc-antigravity-plugin:antigravity --read-only "Leia o arquivo scripts/antigravity-bridge.js e diga apenas: 'LEITURA_OK - [número de funções exportadas]'"
```

**Passo 2 — Continuar com contexto:**
```
/cc-antigravity-plugin:antigravity --continue "Com base na leitura anterior, qual função você recomendaria refatorar primeiro e por quê? Resposta em uma linha."
```

**Esperado:** resposta do passo 2 referencia informação da leitura do passo 1 sem precisar re-ler o arquivo.

---

## T11 — Sinal QUOTA_EXAUSTED (simulado via log)

**Objetivo:** verificar a estrutura do JSON emitido quando QUOTA é detectado.

Não é possível forçar quota sem gastar cota real. Verificar no log de uma execução anterior se o padrão está correto, ou simular via `--print-command` para inspecionar o prompt.

**Verificar estrutura esperada do JSON (quando ocorrer naturalmente):**
```json
{
  "status": "QUOTA_EXAUSTED",
  "reason": "quota or rate limit reached",
  "model": "gemini-3.5-flash-medium",
  "retry": "--continue"
}
```

**O campo `retry` é o indicador crítico** — confirma que a sessão pode ser retomada com `--continue` após o reset de cota.

---

## T12 — `--print-command`: inspecionar comando sem executar

**Objetivo:** validar a composição dos argumentos AGY sem gastar cota.

```
/cc-antigravity-plugin:antigravity --print-command --model gemini-3.1-pro-low --dirs scripts --timeout 5m "analisar auth"
```

**Esperado:** output mostra o comando `agy` montado, incluindo:
- `--add-dir <cwd>`
- `--dangerously-skip-permissions`
- `--print`
- `--print-timeout 5m`
- Prompt com conteúdo dos arquivos de `scripts/` inline

**Não esperado:** `--model gemini-3.1-pro-low` nos args (model é aplicado via settings.json, não via CLI).

---

## Checklist de resultados

| Teste | Funcionalidade | Resultado | Observação |
|---|---|---|---|
| T01 | Conectividade básica | ⬜ | |
| T02 | Model forwarding (settings.json) | ⬜ | |
| T03 | Identifier `gemini-3.5-flash-high` | ⬜ | |
| T04 | Criar arquivo (write_to_file) | ⬜ | |
| T05 | Editar arquivo (replace_file_content) | ⬜ | |
| T06 | `--read-only` não modifica | ⬜ | |
| T07 | `--model auto` contexto pequeno | ⬜ | |
| T08 | `--model auto` contexto grande | ⬜ | |
| T09 | Heartbeat tarefa longa | ⬜ | |
| T10 | `--continue` retomar sessão | ⬜ | |
| T11 | Estrutura JSON QUOTA_EXAUSTED | ⬜ | |
| T12 | `--print-command` inspecionar args | ⬜ | |

---

## Prioridade de execução

Se o tempo for limitado, execute nesta ordem de impacto:

1. **T01** — smoke test (pré-requisito para todos)
2. **T02** — model forwarding (maior risco — mecanismo novo, nunca validado em prod)
3. **T04** — criar arquivo (valida o modo agêntico core)
4. **T12** — `--print-command` (sem cota, valida composição dos args)
5. **T06** — `--read-only` (valida isolamento entre modos)
6. **T07/T08** — `--model auto` (valida nova feature)
7. **T09** — heartbeat (valida robustez em tarefas longas)
8. **T10** — `--continue` (valida continuidade de sessão)
