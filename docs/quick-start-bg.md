# Nexus — кратко ръководство (`aih`)

## 1. Първоначална настройка

Отвори PowerShell в папката на Nexus и изпълни:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

После настрой достъпа:

```powershell
aih-key   # DeepSeek API ключ
aih-auth  # незадължителен Codex/ChatGPT вход за ограничени ревюта
```

## 2. Стартиране

Влез в папката на проекта, по който искаш да работиш:

```powershell
cd C:\път\до\проекта
aih -Open
```

Уеб интерфейсът обикновено е на:

```text
http://127.0.0.1:3080
```

Основният инженер е **DeepSeek V4 Flash**. Codex не е постоянен ръководител и се използва само за ограничено независимо ревю, когато deterministic policy го изисква или когато потребителят изрично поиска това.

## 3. Режими

```powershell
aih -Preset normal    # DeepSeek + възможност за ограничено Codex ревю
aih -Preset deepseek  # само DeepSeek; без Codex/OpenAI inference
```

Спиране и рестартиране:

```powershell
aih-stop
aih -Restart -Open
```

## 4. Как Nexus работи

Най-лесно е просто да опишеш задачата в GUI. Nexus controller-ът пази task identity, routing, attempts, verification evidence, failures, review requirements и completion state извън chat history.

Типичен flow:

```text
prompt
-> task + route
-> Attempt 1
-> DeepSeek implementation
-> /verify
-> PASSED / FAILED
-> optional review / operator gate
-> controller completion
```

Reload на браузъра не създава нов attempt.

## 5. Control Room

Nexus има compact **Controller** и expanded **Task Control Room**.

Четирите основни tabs са:

- **Overview** — task, state, attempt, executor, execution class, gate/review status;
- **Activity** — реалните lifecycle transitions по време;
- **Verification** — PASSED/FAILED, checks, exit codes, timings;
- **Files** — Git-visible промените за bound workspace-а.

До composer-а може да видиш например:

```text
RUNNING   · DeepSeek V4 Flash · HIGH
PREFERRED · DeepSeek V4 Flash · MAX
```

`RUNNING` е това, което controller routing-ът реално използва за задачата. `PREFERRED` е session preference/ceiling и не отменя deterministic routing-а.

## 6. Verification

За bound task в GUI използвай:

```text
/verify
```

Verification е controller-owned и записва evidence с check status, command, exit code, timestamps и attempt linkage.

Важно: валиден verification result може да съдържа failed check и process exit code != 0. Това е нормален **FAILED verification**, не задължително crash на verifier-а.

## 7. Ръчно управление през PowerShell

Ако ти трябва low-level controller workflow:

```powershell
aih-task -Action create-task `
  -Description "Поправи грешката при запис" `
  -AcceptanceCriteria "Тестът минава"

aih-task -Action begin-attempt -TaskId TASK-0001
aih-route "Поправи грешката при запис" -TaskId TASK-0001

a ih-context -Operation bundle `
  -TaskId TASK-0001 `
  -Query "грешка при запис"

aih-verify -Kind test -TaskId TASK-0001
```

> Забележка: в нормалния GUI flow controller bridge-ът сам управлява attempt lifecycle-а; не е нужно ръчно да стартираш attempt за всеки GUI turn.

Състоянието и доказателствата се пазят в:

```text
<проект>\.ai-harness\state\
<проект>\.ai-harness\runs\TASK-0001\
```

## 8. Полезни команди

```powershell
aih-doctor -Offline
aih-test
aih-test-tiers       # live provider probes; може да използват quota
aih-detect
aih-rules
```

Контекст и code search:

```powershell
aih-context -Operation search_code -Query "име или текст"
aih-context -Operation find_symbol -Query "ИмеНаФункция"
aih-context -Operation find_references -Query "ИмеНаФункция"
aih-context -Operation file_outline -File "src/app.ts"
```

## 9. Полезни правила

- Стартирай `aih` от директорията на проекта, по който искаш да работиш.
- Не записвай API ключове в source files, task ledgers или prompt-и.
- Обикновените задачи обичайно трябва да приключват с `Codex calls = 0`.
- Не използвай `git add .` на сляпо, когато `.ai-harness` съдържа runtime/test history.
- Провери `git diff` и `git status` преди commit.
- При browser acceptance не използвай broad `taskkill /IM chrome.exe`; спирай само process-а, който тестът е стартирал.

## 10. Повече документация

Започни от [docs/README.md](README.md).

- [Architecture overview](architecture/overview.md)
- [Controller](architecture/controller.md)
- [Routing](architecture/routing.md)
- [Task lifecycle](architecture/task-lifecycle.md)
- [Control Room](architecture/control-room.md)
- [State and storage](reference/state-and-storage.md)
- [Endpoints](reference/endpoints.md)
- [Setup/testing/troubleshooting](operations/setup-testing-troubleshooting.md)
