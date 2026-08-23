# Кратко ръководство за AI Harness (`aih`)

## 1. Първоначална настройка

Отвори PowerShell в `C:\AI-Harness` и изпълни:

```powershell
.\setup.ps1
```

Ако по-късно трябва да смениш достъпа:

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

Това стартира уеб интерфейса на:

```text
http://127.0.0.1:3080
```

Основният изпълнител е DeepSeek V4 Flash. Codex не е постоянен ръководител и се използва само за ограничено ревю при сериозен или повтарящ се проблем.

## 3. Режими

```powershell
aih -Preset normal    # DeepSeek + възможност за ограничено Codex ревю
aih -Preset deepseek  # само DeepSeek; без Codex/OpenAI заявки
```

Спиране и рестартиране:

```powershell
aih-stop
aih -Restart -Open
```

## 4. Обичаен работен процес

Най-лесно е да опишеш задачата директно в уеб интерфейса. Например:

```text
Поправи грешката при запис на потребител. Добави тест и изпълни само
необходимите проверки. Не променяй несвързани файлове.
```

Harness-ът избира изпълнител, пази състоянието, стартира проверки и решава дали задачата е завършена.

За ръчно управление през PowerShell:

```powershell
# Създаване на задача
aih-task -Action create-task `
  -Description "Поправи грешката при запис" `
  -AcceptanceCriteria "Тестът минава"

# Начало на опит
aih-task -Action begin-attempt -TaskId TASK-0001

# Определяне на маршрут
aih-route "Поправи грешката при запис" -TaskId TASK-0001

# Подготовка на ограничен контекст
aih-context -Operation bundle `
  -TaskId TASK-0001 `
  -Query "грешка при запис"

# Проверки
aih-verify -Kind test -TaskId TASK-0001
```

Състоянието и доказателствата се пазят в:

```text
<проект>\.ai-harness\state\
<проект>\.ai-harness\runs\TASK-0001\
```

## 5. Полезни команди

```powershell
aih-doctor -Offline  # проверка на локалната инсталация
aih-test             # тестове на самия AI Harness
aih-detect           # разпознаване на проекта и командите за проверка
aih-verify           # всички намерени проверки
aih-verify -Kind test
aih-verify -Kind lint
aih-verify -Kind typecheck
aih-rules            # архитектурни и security правила
```

Търсене и контекст:

```powershell
aih-context -Operation search_code -Query "име или текст"
aih-context -Operation find_symbol -Query "ИмеНаФункция"
aih-context -Operation find_references -Query "ИмеНаФункция"
aih-context -Operation file_outline -File "src/app.ts"
```

## 6. Съвети за добри задачи

Посочвай ясно:

- какъв резултат искаш;
- кои файлове или части на проекта са в обхвата;
- как се проверява успехът;
- какво не трябва да се променя.

Пример:

```text
Добави валидация за празен имейл в src/users.ts.
Добави тест за празен и валиден имейл.
Успех: целевите тестове и typecheck минават.
Не променяй API формата и базата данни.
```

## 7. Важно

- Стартирай `aih` от директорията на проекта, не от потребителската си папка.
- Не записвай API ключове в проекта или в prompt-и.
- Обикновените задачи трябва да приключват с `Codex calls = 0`.
- За паралелни промени използвай отделни Git worktree директории.
- Провери `git diff` преди commit.

За архитектурни подробности виж [vnext-architecture.md](vnext-architecture.md).
