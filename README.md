# CNS Digital

CNS Digital — единая локальная система для технической работы CNS. Текущие модули:

- `Jurnal` — журнал неисправностей;
- `Yoxlama vərəqləri` — выполнение ежедневных технических проверок;
- `Yoxlama şablonları` — управление версиями checklist;
- `Növbə cədvəlləri` — версионируемые расписания смен;
- управление пользователями и ролями (`İstifadəçilər`, `Rollar`);
- раздельные backup и единый audit log.

Запуск: `npm start`, порт по умолчанию **3001**. Пути ниже задаются относительно рабочей папки запуска (обычно корень проекта).

## Автоматические резервные копии

- `CNS-Jurnal-Backup/Excel/CNS-Jurnal-YYYY-MM-DD.xlsx` — актуальный журнал, включая ID и сведения о восстановлении. Лист `Backup info` содержит локальную дату и время снимка с миллисекундами и смещение часового пояса.
- `CNS-Jurnal-Backup/Database/jurnal-YYYY-MM-DD.db` — полная SQLite-база, включая пользователей и роли. Создаётся штатным online Backup API с учётом WAL.

Excel ставится в последовательную очередь после успешной записи в БД: создание, редактирование, восстановление, одиночное/массовое удаление записей, импорт Excel. HTTP-запрос не ожидает завершения backup. Каждый запрос backup формирует снимок актуального состояния на момент обработки очереди. В пределах дня файл заменяется через временный файл: неудачная запись сохраняет предыдущую успешную копию.

При старте сервера обновляется Excel, а SQLite-копия создаётся, если за сегодняшний день её ещё нет. Каждые 30 секунд проверяется локальная календарная дата: после смены даты создаются новые файлы даже без действий пользователей. Суточная SQLite-копия не перезаписывается при следующих проверках или перезапуске. Ошибка суточного копирования повторно проверяется через 30 секунд. Пока сервер выключен, копирование не выполняется; пропущенные дни не восстанавливаются задним числом.

Backup-файлы автоматически **не удаляются**. Ручной Export сохраняет прежнее имя, формат и содержимое.

## Audit log

Файлы: `logs/CNS-Jurnal-YYYY-MM-DD.log`. Время — локальное системное, с миллисекундами. Каждая строка содержит событие, логин, имя (если известно), IP, описание, результат и идентификатор объекта при наличии. Для событий сервера и фонового backup пользователь — `system`, IP — `-`.

Логируются входы/выходы, пароли (только факт смены/сброса), действия с пользователями, ролями и журналом, импорт/экспорт, backup, ошибки API и запуск/штатная остановка. Неуспешные запросы получают `ERROR`; ошибки API с кодом 500 дополнительно отмечаются `API_ERROR`. Сообщения исключений, тела запросов/ответов и секреты не записываются. Значения экранируются, поэтому перевод строки в логине не создаёт поддельную строку лога.

После первой успешной записи каждого локального дня удаляются только файлы формата `CNS-Jurnal-YYYY-MM-DD.log` с датой **старше 45 календарных дней**. Файл за граничный 45-й день сохраняется. При ошибке очистки повторная попытка выполняется при следующем событии. Посторонние файлы и backups не удаляются.

Ошибки backup и аудита не отменяют операции с БД. При невозможности записать audit log выводится обезличенное сообщение `[AUDIT_ERROR]` в stderr; очередь продолжает работу. При SIGINT/SIGTERM сервер прекращает принимать подключения и ожидает завершения запросов/очередей (до 15 секунд). SIGKILL и отключение питания записать невозможно; незавершённые фоновые задачи при аварии могут быть потеряны.

## Reverse proxy

По умолчанию `trust proxy=false`; IP берётся из `req.ip`, подставленный клиентом `X-Forwarded-For` игнорируется.

При наличии доверенного reverse proxy задайте `TRUST_PROXY` списком его IP/подсетей через запятую, например `TRUST_PROXY=127.0.0.1,::1`. Можно использовать именованную подсеть Express `loopback`. Указывайте только фактически доверенные адреса; proxy должен корректно переписывать заголовок. Пустая переменная отключает доверие. Значение `true` и число переходов не используются как режим безусловного доверия.

## Проверка

`npm test` запускает модульные проверки и отдельные серверы **только с временными БД и рабочими папками**; рабочая `data/jurnal.db` не открывается. Проверяются очередь и ротация backup, WAL/целостность SQLite, хранение логов, основные события API, отсутствие секретов, доверие прокси и продолжение работы при отказе backup/audit.

`npx tsc --noEmit` проверяет TypeScript без запуска приложения.

## Checklist — этап 1: хранилище и права

При следующем запуске сервер добавляет в `jurnal.db.roles` семь независимых флагов:
`view_checklists`, `create_checklists`, `edit_own_checklists`, `manage_checklists`,
`manage_checklist_templates`, `manage_checklist_shifts`, `create_reports_from_checklist`.
Миграция с её отметкой в `journal_schema_migrations` выполняется одной транзакцией.
Существующие пользователи и записи не мигрируют в другое хранилище.

Admin получает все новые права; employee, shift_engineer и observer — только просмотр.
Новые роли Texnik (`technician`) и Mühəndis (`engineer`) получают просмотр, создание,
редактирование своих checklist и право создания неисправности из checklist.
Обычное `create_reports` у них выключено. Существующие custom roles получают нули
для новых колонок. Если колонка уже существовала, её значения сохраняются.
Коллизия с существующей ролью `technician`/`engineer` останавливает миграцию,
не переименовывая и не перезаписывая её автоматически.

Defaults применяются один раз. При рестарте больше не сбрасываются сохранённые
права и названия встроенных ролей — как новые, так и существующие.
Редактор ролей содержит отдельную группу «Yoxlama hüquqları» и семь полей в форме.
Новые права доступны в ответах login и `/api/me`. Управление ими остаётся
за существующим `manage_roles`; Admin защищён от изменения через редактор.

`data/checklist.db` создаётся автоматически отдельным подключением:
WAL, `foreign_keys=ON`, `busy_timeout=5000` мс. На этом этапе в ней только
`checklist_schema_migrations` (version, name, applied_at), версия 1.
Конфигурация/миграции checklist не импортируют и не открывают `jurnal.db`.
Состояние подключения хранится в `app.locals.checklistStorage`.
При ошибке открытия или миграции соединение закрывается, записывается
`CHECKLIST_STORAGE_ERROR` с `module="CHECKLIST"`, основной сервер продолжает работу.
После устранения причины выполняется повторная попытка при следующем запуске.
Штатная остановка закрывает оба подключения.

Checklist endpoints, экраны выполнения, шаблоны, расписания, ответы, интеграция reports
и checklist backup пока не реализованы. `report_creation_requests` не создаётся.
Права на будущие функции уже можно настроить; они не включают эти функции сами по себе.

## Checklist — этап 2: общие сервисы

`src/auth.ts` содержит общую авторизацию и Express Router для существующих
`/api/login`, `/api/logout`, `/api/me`, `/api/change-password`. Подключение БД и
секрет передаются явно, поэтому импорт модуля не открывает рабочую базу.
Сохраняются прежние сессии, формат и срок токенов, проверка активности аккаунта,
динамическая проверка прав и сценарий привязки исторических записей при входе.

`src/reports/service.ts` содержит создание обычной неисправности и правила
редактирования/удаления. `createManual` самостоятельно требует `create_reports`;
право `create_reports_from_checklist` и поле `source` в запросе его не заменяют.
`src/reports/normalization.ts` содержит общие прежние правила нормализации полей,
приоритета и имён — их используют существующие создание, редактирование и import.
После успешной записи HTTP-обработчик запускает прежний backup, audit остаётся
в общем middleware. Ошибки БД передаются существующему обработчику ошибок.
Audit фиксирует исходный путь запроса до входа в Router, чтобы корректно записывать
события и логин при неудачном входе.

Этот этап не создаёт таблиц/миграций, checklist endpoints, шаблонов или механизма
связывания двух БД. Идемпотентность и создание report из checklist остаются этапом
интеграции. `test/shared-services.test.ts` отдельно проверяет токены, cookie/Bearer,
права, нормализацию, владельца записи, ошибки и audit при работе через Router.

## Checklist — этап 3: backend шаблонов

Миграция 2 отдельной `checklist.db` транзакционно создаёт `checklist_templates`,
`checklist_template_versions`, `checklist_sections`, `checklist_items` и SQL guards.
Повторный запуск сохраняет данные. Production-шаблоны не добавляются.
Полная схема: `src/checklists/template-schema.ts`; бизнес-логика:
`src/checklists/templates.ts`; HTTP: `src/checklists/template-routes.ts`.
В `jurnal.db` этот этап ничего не добавляет. Будущий полный SQLite backup
`checklist.db` будет включать все четыре таблицы; backup журнала не изменён.

Связи: template → versions → sections → items. `current_version_id` указывает
только на опубликованную версию того же template. UUID — физический ID;
`stable_key` сохраняет логическую идентичность section/item при клонировании.
Новые клоны получают новые UUID. Начальная версия — `1.0 draft`, следующие
получают следующий minor после максимального номера внутри template.

Draft сохраняется целиком в одной транзакции с ожидаемой `revision`.
Конфликт ревизии или попытка редактировать не-draft возвращает 409.
Публикация проверяет структуру, минимум одну активную позицию и активные пункты
каждой активной позиции, записывает SHA-256, автора/время и переключает current
одной транзакцией. Предыдущая опубликованная версия не меняется.
Hash учитывает названия, stable keys, порядок, metadata, active/required;
не учитывает UUID, номер версии и время. Серверные timestamps хранятся в ISO UTC.

SQL triggers запрещают изменение содержимого published/archived, добавление,
перенос, замену и удаление их sections/items, в том числе через INSERT OR REPLACE.
Единственное разрешённое изменение published — переход в archived с заполнением
метаданных архивирования; структура, hash и revision сохраняются. Archived
полностью неизменяем. Физическое удаление любой версии, включая draft, запрещено:
используется archive, чтобы не переиспользовать уже выделенные номера версий.
Архивирование current обнуляет указатель, не выбирая старую версию автоматически.

Все пути ниже имеют префикс `/api`:

| Метод | Путь | Permission |
| --- | --- | --- |
| GET | `/checklist-templates` | `view_checklists` |
| GET | `/checklist-templates/:id/versions` | `view_checklists` |
| GET | `/checklist-template-versions/:id` | `view_checklists` |
| POST | `/checklist-templates` | `manage_checklist_templates` |
| POST | `/checklist-template-versions/:id/clone` | `manage_checklist_templates` |
| PUT | `/checklist-template-versions/:id` | `manage_checklist_templates` |
| POST | `/checklist-template-versions/:id/publish` | `manage_checklist_templates` |
| POST | `/checklist-template-versions/:id/archive` | `manage_checklist_templates` |

Создание принимает `{ "code": "DAILY", "name": "Gündəlik yoxlama" }`.
Clone не требует тела. Publish и archive принимают `{ "revision": 1 }`.
PUT принимает полную структуру draft, например:

```json
{
  "revision": 1,
  "name_snapshot": "Gündəlik yoxlama",
  "sections": [{
    "stable_key": "SUP_APP",
    "name": "SUP/APP konsolu",
    "sort_order": 0,
    "active": true,
    "service_name": "",
    "object_name": "",
    "items": [{
      "stable_key": "MONITOR",
      "name": "Monitor",
      "equipment_name": "",
      "sort_order": 0,
      "required": true,
      "active": true
    }]
  }]
}
```

Ответ содержит сохранённую версию с revision, UUID и упорядоченными sections/items.
Пределы структуры: 200 sections, 500 items на section, 5000 items суммарно.
Некорректная структура возвращает 422; неизвестный ID — 404; отсутствие
permission — 403; недоступная checklist storage — 503, основной журнал работает.
`manage_checklist_shifts` не предоставляет права управления шаблонами.

Audit использует общий logger: CHECKLIST_TEMPLATE_CREATE/CLONE/UPDATE/PUBLISH/ARCHIVE,
module=CHECKLIST, идентификаторы, версия, revision, changed_fields, actor/IP и результат.
Полный JSON не записывается. changed_fields перечисляет категории операции;
для отклонённых запросов это попытка изменения, result=ERROR.
Отказ logger не отменяет успешно сохранённую операцию.

Тесты `test/checklist-templates.test.ts` и `test/checklist-template-api.test.ts`
проверяют immutable guards, транзакции, права, API, hash, миграции и сценарий
v1.0 → clone → изменение → publish v1.1 с неизменной полной структурой v1.0.
UI, runs, schedules, report links и checklist Excel backup остаются будущими этапами.

## Checklist — этап 4: расписания и ежедневные runs

Административный template API теперь целиком требует `manage_checklist_templates`,
включая список, историю и чтение отдельной версии. Право `view_checklists` не
открывает draft/archived/admin data. Runtime получает только безопасную текущую
информацию через `/api/checklists/context`.

Миграция 3 в `checklist.db` добавляет:

- `checklist_shift_schedule_versions`: явные version/status/timezone/effective_from,
  revision, авторы и UTC timestamps создания, публикации, архивирования;
- `checklist_shift_rules`: shift_key, label, applicable_days (JSON: 0 = воскресенье,
  6 = суббота), local_start_time/local_end_time (HH:mm), порядок и active;
- `checklist_shift_periods`: immutable snapshot конкретной смены, рабочей даты,
  timezone, starts_at/ends_at и edit_until;
- `checklist_runs`: user/template/shift snapshots, даты, статус, revision,
  extra/reason и поля soft delete;
- `checklist_run_sections` и `checklist_run_items`: историческая структура,
  названия, stable keys, metadata, порядок и active/required snapshots.
  Поля будущих ответов и комментариев созданы, API их изменения отсутствует.

Полная схема и SQL guards: `src/checklists/run-schema.ts`.
В `jurnal.db` ничего не добавляется. Все новые таблицы будут входить в будущую
SQLite-копию всей checklist.db; checklist backup этим этапом не запускается.

### Правила расписания

Конкретные часы не задаются defaults или seed. Администратор передаёт timezone
и rules через API. Все абсолютные timestamps — UTC; local_date, work_date и
started_local_at — явно обозначенные локальные snapshots с timezone.
`effective_from` передаётся ISO UTC с Z. Новое расписание публикуется с текущего
или будущего времени, позже предыдущего опубликованного effective_from, и не
может вступать в силу посреди смены старого или нового расписания.

Draft сохраняется целиком с revision; конфликт — 409. Published сохраняет
неизменными правила, timezone и effective_from. Изменения выполняются созданием
нового draft через POST с based_on_version_id и новым effective_from. Версии —
последовательные целые числа. Archive меняет только статус/metadata; archived
неизменяем. Архивирование действующей версии не включает старую автоматически.

`resolveCurrentShift` выбирает последнюю опубликованную по effective_from версию,
вступившую в силу на серверное текущее время. Расчёт выполняется в её timezone.
Дни applicable_days относятся к дате начала смены. Конец раньше начала означает
следующий день; одинаковые начало/конец отвергаются. Интервал смены — [start,end).
Непересекающиеся смены могут иметь промежутки; в промежутке создание невозможно.
Пересечение rules, включая границу недели, отклоняется при сохранении.

Для переходов DST неоднозначное или несуществующее локальное время границы
возвращает 409: сервер не выбирает смещение молча. Обычные границы смены по обе
стороны перехода получают фактические UTC offsets независимо друг от друга.

Период создаётся/получается транзакционно с UNIQUE(schedule_version_id,shift_key,
work_date). work_date — дата начала смены. edit_until на этом этапе равен ends_at
и хранится отдельно для будущей поддержки grace period.

### Создание и история

POST /api/checklists принимает `{}` для обычной проверки или
`{"is_extra":true,"override_reason":"..."}` для административной дополнительной.
Поля пользователя, версии, смены и времени от клиента отвергаются (422).
Обычный режим требует view_checklists + create_checklists; extra требует
view_checklists + manage_checklists и непустую причину. Проверки прав выполняются
повторно в service, без проверки имени роли.

Сервер выбирает единственный текущий опубликованный template. Если активных
шаблонов несколько, возвращает ошибку конфигурации вместо произвольного выбора.
При отсутствии расписания: `Növbə cədvəli təyin edilməyib`; при отсутствии шаблона:
`Aktiv yoxlama şablonu mövcud deyil`. Пустой run не создаётся.

Одна IMMEDIATE transaction получает period, проверяет обычный слот, создаёт run
и копирует активные sections и их активные items. Inactive не включаются.
Сохраняются исходные template version/hash, имя и login пользователя, вся смена
и граница редактирования. Новые template/schedule версии эти snapshots не меняют.
Исторические GET читают run tables без загрузки current template/schedule.

Partial unique index: UNIQUE(user_id,shift_period_id) WHERE is_extra=0.
Ответ: `{outcome:"created",run:...}` (201) или `{outcome:"existing",run:...}` (200).
Unique slot сохраняется после soft delete. Повторный POST владельца удалённой
проверки возвращает existing с deleted_at и can_edit=false, не создавая замену.
Список скрывает удалённые runs; отдельный GET удалённого доступен manage_checklists.

`canEditChecklistRun`: manage_checklists разрешает историческое редактирование;
иначе нужны edit_own_checklists, совпадение user_id и server time <= edit_until_snapshot.
Удалённый run редактировать нельзя. Реальных endpoints ответов/завершения пока нет.

### API этапа 4

Все пути имеют префикс `/api`:

| Метод | Путь | Право |
| --- | --- | --- |
| GET/POST | `/checklist-shift-schedules` | manage_checklist_shifts |
| GET/PUT | `/checklist-shift-schedules/:id` | manage_checklist_shifts |
| POST | `/checklist-shift-schedules/:id/publish` | manage_checklist_shifts |
| POST | `/checklist-shift-schedules/:id/archive` | manage_checklist_shifts |
| GET | `/checklists/context` | view_checklists |
| POST | `/checklists` | view + create, либо view + manage для extra |
| GET | `/checklists` | view_checklists |
| GET | `/checklists/:id` | view_checklists |
| GET | `/checklists/:id/sections/:sectionId` | view_checklists |
| DELETE | `/checklists/:id` | manage_checklists; delete_reason обязателен |

Создание расписания: `{timezone,effective_from,rules:[{shift_key,label,
applicable_days,local_start_time,local_end_time,sort_order,active}]}`.
Клонирование: `{based_on_version_id,effective_from}`. PUT принимает полную структуру
и revision; publish/archive — `{revision}`. Примеры часов есть только в test fixtures.

Список runs поддерживает page (с 1), page_size (1–100, default 25), date/work_date,
user (ID), shift (label snapshot), status, template_version. Ответ содержит rows,
page, page_size, total; сортировка started_at DESC, id. Context содержит текущую
смену, work_date, current_template label/version, can_create, existing_run_id и error.
GET context не создаёт периоды в базе.

Audit: CHECKLIST_SHIFT_SCHEDULE_CREATE/UPDATE/PUBLISH/ARCHIVE,
CHECKLIST_CREATE, CHECKLIST_ADMIN_EXTRA_CREATE, CHECKLIST_VIEW, CHECKLIST_DELETE.
Записываются module=CHECKLIST, checklist_id/schedule_version_id, template_version,
shift/work_date, actor/IP/result. Содержимое snapshots и причины целиком в audit
не передаются. Ошибка logger не отменяет запись. Недоступная checklist.db даёт
503 только checklist API, основной журнал продолжает работать.

## Checklist — этап 5: выполнение, autosave и завершение

Схема SQLite не меняется: используются поля answers/comments/revision этапа 4.
Новые endpoints (все требуют авторизацию, view_checklists и положительный
`canEditChecklistRun` — владелец с edit_own_checklists до сохранённого срока,
либо manage_checklists; soft-deleted run всегда запрещён):

- `PATCH /api/checklists/:id/items/:itemId` — `{expectedRevision,result?,comment?}`;
- `PATCH /api/checklists/:id/sections/:sectionId` — `{expectedRevision,section_comment}`;
- `POST /api/checklists/:id/complete` — повторно проверяет содержимое на сервере.

При PATCH проверяется принадлежность item/section именно этому run. Неизвестные
поля и result вне `null | ok | problem | na` отклоняются (422). Комментарии ограничены
5000 символами. expectedRevision обязателен; конфликт — 409. Успешный ответ содержит
item/section с новой revision, run и серверный progress/navigator. Все связанные
изменения выполняются одной IMMEDIATE transaction.

`src/checklists/progress.ts` содержит `isItemComplete`, `isSectionComplete` и расчёт
progress. Каждый обязательный пункт должен иметь результат; каждый problem/na,
включая необязательные пункты, требует непустой после trim комментарий. Autosave
допускает временный problem/na без комментария, но завершение блокируется.
GET run возвращает completed_sections, total_sections, completed_required_items,
total_required_items, ok_count, problem_count, na_count, unanswered_required_count
в progress; navigator содержит состояния sections без загрузки всех ответов клиентом.
Список runs также содержит progress. server_time позволяет UI отсчитывать срок
редактирования от серверного времени, независимо от настроек часов планшета.

Complete при неполных данных возвращает 422 с incompleteSections и incompleteItems
(id, section_id, name, reason). Успешное первое завершение устанавливает оба поля
first_completed_at/completed_at. Повторное завершение без изменений не меняет время
или revision. Исправление completed checklist сохраняет first_completed_at: если
содержимое осталось валидным, completed_at обновляется; иначе status=in_progress,
completed_at=NULL. После исправления незавершённого checklist требуется явный complete.

`public/checklists.js` добавляет раздел «Yoxlama vərəqləri»: список карточек с
пагинацией, создание/продолжение, один section на экране, navigator, summary,
read-only и ссылки на незавершённые позиции. `public/checklists.css` сохраняет
стилистику приложения и задаёт touch controls >=48 px, focus states, вертикальную
прокрутку и закреплённую навигацию. В styles.css исправлен приоритет hidden для
экранов login/app: мобильные display!important больше не показывают скрытый экран.

`public/checklist-autosave.js` — отдельный тестируемый контроллер последовательного
сохранения на позиции. Result отправляется сразу; comments имеют debounce 650 мс
и flush на blur. Каждая запись хранит revision и поколения введённых/подтверждённых
значений. Старое подтверждение не заменяет новый ввод. Успех отображается только
после подтверждения всех изменений сервером. Ошибка оставляет значения в UI;
повтор выполняется явно. При 409 revision автоматически не подменяется: пользователь
видит конфликт и может перечитать серверное состояние с подтверждением потери
локальных изменений. При таймауте возможен уже выполненный commit; повтор с прежней
revision безопасно выявит конфликт вместо молчаливой перезаписи.

Переход к другой позиции/разделу, logout и перезагрузка/закрытие страницы учитывают
несохранённые изменения. Предупреждение beforeunload отображается средствами браузера.
Offline persistence/очереди между страницами нет. После истечения срока UI блокирует
редактирование; backend повторно проверяет срок и актуальные permissions при каждом PATCH.

Общий audit дополнен CHECKLIST_ITEM_UPDATE, CHECKLIST_NOTE_UPDATE,
CHECKLIST_COMPLETE, CHECKLIST_EDIT_AFTER_COMPLETE, CHECKLIST_REOPEN,
CHECKLIST_ADMIN_EDIT. Сохраняются module, checklist/section/item IDs, revision,
changed_fields, template_version, actor/IP/result. Полные комментарии не логируются.
Отказ audit не отменяет commit.

Проверки: `npm test`, TypeScript; отдельно браузерный сценарий
`node test/browser/checklist.mjs`. Он использует только БД в памяти и тестовый API.
Playwright устанавливается отдельно от зависимостей приложения; путь задаётся
PLAYWRIGHT_MODULE, Chrome — CHROME_PATH (defaults соответствуют текущей машине).
Сценарий проверяет создание/прохождение/completion, offline retry, conflict,
предупреждения, readonly, expiry и размеры 1366×900, 1024×768, 768×1024.
Report integration и checklist Excel backup не реализуются этим этапом.

## Checklist — этап 6: создание неисправности и idempotency

`POST /api/checklists/:id/items/:itemId/report` требует view_checklists,
create_reports_from_checklist и canEditChecklistRun. Одного create_reports
недостаточно; обратного расширения прав обычного POST /api/reports также нет.
Для новой операции item должен принадлежать этому run, иметь problem и непустой
comment. Пользователь и время устанавливаются сервером. Soft-deleted run не
разрешает создание/восстановление связи даже администратору.

Журнал получает миграцию 2 в journal_schema_migrations:
`report_creation_requests(request_id TEXT PRIMARY KEY, report_id INTEGER NOT NULL,
actor_user_id INTEGER NOT NULL, created_at TEXT NOT NULL)`.
Это только технические идентификаторы/время; checklist content в таблице отсутствует.
FK на reports намеренно нет: удаление report не удаляет idempotency history.
Triggers запрещают изменение/удаление/замену request history.

Checklist получает миграцию 4:
`checklist_report_links(id, run_item_id UNIQUE, operation_id UNIQUE, report_id,
state, requested_by, requested_at, linked_at, last_error_code)`.
FK run_item_id ссылается только на таблицу внутри checklist.db. Operation ID и
привязка к item immutable; удаление/замена связи запрещены. На один item выделяется
максимум одна операция, в том числе после удаления связанной неисправности.

Состояния: pending → linked; pending → error; error/pending → linked при retry.
`deleted` — вычисляемое состояние GET, если сохранённого report_id больше нет
в существующей reports. Обычный журнал сейчас физически удаляет reports.
Состояние `none` означает отсутствие операции.

Алгоритм `src/checklists/report-links.ts`:

1. Проверить permissions, run/item, результат и обязательные данные.
2. Отдельно закоммитить pending со случайным серверным UUID operation_id.
3. Повторно проверить run/item под IMMEDIATE lock checklist.db. Этот lock защищает
   snapshots ответов от конкурентного редактирования во время создания.
4. ReportService ищет request_id; при отсутствии одной IMMEDIATE transaction
   вставляет report и request history в jurnal.db.
5. После journal commit вызвать прежний journal backup hook и audit creation.
6. Записать linked/report_id/linked_at в checklist.db.

Общей транзакции между файлами нет. Если шаг 6 падает, report/request остаются
закоммиченными. Сохраняется error либо pending, если обновление вообще невозможно.
Следующий авторизованный retry находит request_id и восстанавливает связь без
нового report. Блокировки берутся всегда checklist → journal. Создание report и
INSERT request откатываются вместе при ошибке любого из них. Если HTTP-ответ
потерян, повтор возвращает существующий report_id. Клиент не назначает operation_id.

ReportService использует один внутренний insert/валидацию/нормализацию для manual
и idempotent creation, с раздельными проверками permissions. Данные нового report:
service_name_snapshot → xidmet, object_name_snapshot → obyekt, название позиции +
equipment_name_snapshot (либо item name) → sistem, comment → nasazliq, текущий
user → автор. nasazliq_vaxti формируется сервером в локальном времени в формате
YYYY-MM-DD HH:mm и проходит общий pickReport. Current template не читается.

Если не хватает обязательного xidmet/sistem, ответ 422 содержит missing_fields
(key,label). Pending ещё не создаётся. Body принимает только реально недостающие
поля; подмена имеющихся snapshots или timestamp отклоняется. UI показывает только
поля из missing_fields. Для уже выполненной операции retry возвращает существующий
report даже после изменения problem → ok/na. Связанный report автоматически не
изменяется, не закрывается и не удаляется.

`GET /api/checklists/:id/items/:itemId/report` требует view_checklists и возвращает
state, report_id, created_at, operation_id, can_view_report, can_create, can_retry.
Полного report content нет. can_view_report соответствует текущему view_all_reports
существующего journal API. «Jurnalda aç» загружает обычный /api/reports с его
проверками и переключает на журнал с поиском номера.

UI: «Nasazlıq yarat», «Nasazlıq yaradılır...», номер созданного report,
«Yaratmaq mümkün olmadı» с явным retry, «Əlaqəli nasazlıq silinib». Перед созданием
завершается autosave; несохранённые изменения блокируют действие. После удаления
report повтор не создаёт замену. GET ошибки связи имеют отдельный retry чтения.

Audit добавляет operation_id и REPORT_CREATE_FROM_CHECKLIST, REPORT_LINK_RECOVERED,
REPORT_LINK_ERROR; обычный REPORT_CREATE также записывается при новом report.
Полный comment не логируется. Ошибка audit/backup не отменяет journal commit.
Прежний journal Excel backup вызывается сразу после journal commit, даже если
последующее обновление связи падает; retry также запрашивает актуальный backup.
Checklist backup не добавляется этим этапом.

`test/checklist-report-links.test.ts` проверяет API/права/autofill, миграции,
настоящий journal Excel backup, потерянный HTTP response, два независимых процесса,
отказ INSERT report/request, отказ link update и отказ всех UPDATE link.
`node test/browser/checklist-reports.mjs` проверяет форму недостающего поля,
создание/повтор/открытие в журнале, сохранение связи после OK, восстановление
после ошибки между БД и удалённый report. Оба browser harness используют БД в памяти.

## Checklist — этап 7: отдельный backup

Структура журнала сохраняется, checklist имеет отдельные каталоги:

```text
CNS-Jurnal-Backup/
├── Excel/                     # существующий журнал
├── Database/                  # существующий журнал
└── Checklist/
    ├── Excel/Checklist-YYYY-MM-DD.xlsx
    └── Database/checklist-YYYY-MM-DD.db
```

`src/checklists/backup.ts` — отдельный координатор; `src/backup.ts` не изменён.
Схема БД и API не меняются. Каталоги создаются автоматически. Файлы старых дней
не удаляются. Имя определяется локальной календарной датой сервера, независимо
от UTC и timezone конкретного расписания смен.

SQLite: `better-sqlite3.backup()` использует Online Backup API и включает committed
данные из WAL. Копируется вся checklist.db, включая migrations, историю шаблонов,
расписания, periods, runs, ответы, snapshots, soft-deleted runs и report links.
Результат сначала пишется в уникальный временный файл в целевом каталоге.
Временная копия переводится в journal_mode=DELETE и проверяется quick_check,
после чего атомарно заменяет дневной файл. Рабочая checklist.db остаётся в WAL.
Готовая копия — самостоятельный .db, без необходимости переносить WAL/SHM.

Excel: `src/checklists/backup-excel.ts` получает все данные одной короткой read
transaction в память. Блокировка завершается до построения/сжатия workbook.
Все листы одного Excel описывают один согласованный snapshot. SQLite-копия и
Excel могут соответствовать немного разным моментам при параллельных изменениях;
новые изменения запускают следующий проход. Файл Excel также публикуется через
временный файл + rename. При сбое предыдущий рабочий файл остаётся на месте.
Временные файлы текущей попытки и их служебные SQLite-файлы очищаются.

Листы: **Xülasə**, **Yoxlamalar**, **Mövqelər**, **Yoxlama bəndləri**, **Problemlər**,
**Şablon versiyaları**, **Şablon strukturu**, **Növbələr**, **Backup məlumatı**.
Есть читаемые азербайджанские заголовки, фильтры, закреплённая строка заголовков,
комментарии, результаты, progress, номера reports, snapshots, inactive структура
шаблонов и история версий. Problem/N/A выделены отдельным листом. Удалённые runs
не исключаются; для них показан флаг Silinib.

Метаданные включают локальное время, UTC, timezone сервера, schema version,
application version (если передана окружением npm), source DB path и имена файлов.
Абсолютные timestamps данных обозначены UTC; work_date/local_date и timezone
сохранены отдельно. Report state — состояние связи из checklist snapshot,
а не текущая проверка существования report в независимой jurnal.db.
Секреты и данные авторизации в Excel не добавляются.

Координатор объединяет изменения: debounce 1 секунда, максимальное ожидание
перед запуском 5 секунд при непрерывном autosave. Время самого I/O зависит от
размера БД и диска. Одновременно работает один проход. Изменения во время него
вызывают следующий проход. Успех SQLite и Excel учитывается отдельно: ошибка
одного формата не отменяет публикацию другого.

HTTP middleware отслеживает счётчики изменений SQLite после finish/close запроса.
Поэтому backup планируется и после частичного commit report links при ошибочном
HTTP-ответе. В business transaction нет backup I/O. Периодическая проверка также
наблюдает total_changes/data_version; внешние commits не остаются незамеченными.
Для будущих фоновых сервисов доступен безопасный `request()` после commit.

При старте проверяются каталоги и наличие текущих файлов; выполняется начальное
обновление обоих форматов, даже если файлы уже есть, чтобы учесть предыдущую
аварийную остановку. Каждые 45 секунд проверяются дата, наличие файлов и изменения.
Если ничего не изменилось, Excel заново не формируется. При смене даты новый
backup создаётся без пользовательских действий. Ошибки повторяются на следующем
изменении, периодической проверке или явном flush, без бесконечного busy retry.

При штатном shutdown после закрытия HTTP-сервера выполняется final flush;
для checklist установлен предел ожидания 5 секунд. После таймаута поздняя задача
не публикует файл; отмена/ошибка фиксируется в audit. Общий предел shutdown
сервера остаётся 15 секунд. Неуспешный backup не откатывает сохранённый checklist.

События: CHECKLIST_BACKUP_DB_SUCCESS, CHECKLIST_BACKUP_DB_ERROR,
CHECKLIST_BACKUP_EXCEL_SUCCESS, CHECKLIST_BACKUP_EXCEL_ERROR,
CHECKLIST_BACKUP_ROLLOVER. Поля: module=CHECKLIST, filename, date, duration_ms,
result, error_code при ошибке. Содержимое checklist и сообщения исключений
в audit не записываются.

### Восстановление checklist вручную

1. Остановить сервер и убедиться, что процесс завершился.
2. Сохранить текущую `data/checklist.db` отдельно. Если остались
   `data/checklist.db-wal` и `data/checklist.db-shm`, сохранить их вместе с этой
   текущей БД; не смешивать их с восстанавливаемым файлом.
3. Перенести старую БД и её WAL/SHM из рабочего `data/` в отдельную папку.
   Скопировать выбранный `Checklist/Database/checklist-YYYY-MM-DD.db` как
   `data/checklist.db`. Исходный backup оставить нетронутым.
4. Не заменять `data/jurnal.db` файлом checklist и не объединять эти хранилища.
5. Запустить сервер и проверить историю, шаблоны, ответы и смены.
6. Проверить внешние связи с журналом: `operation_id` ↔ `request_id` ↔ `report_id`.
   Journal и checklist backups могут относиться к разным моментам. Проверить
   также audit log для операций, отсутствующих в более старом checklist backup.
   До сверки не создавать заново неисправности из восстановленных старых items.

Автоматическое восстановление не выполняется. Excel предназначен для аварийного
чтения человеком; полное восстановление модуля выполняется из SQLite backup.

Тесты: `test/checklist-backup.test.ts` — WAL/standalone integrity, полное содержимое,
Excel sheets/data, overwrite/rollover, частые изменения, изменения во время backup,
ошибки обоих форматов, сохранение прежних файлов, cleanup, HTTP hooks и shutdown.
Все проверки выполняются на временных БД; рабочая БД не запускается.

### Production checklist v1.0 — preparation only

The reviewed source is `docs/production/checklist-v1.0.json`: 30 sections, 203 printed items,
all active and required, in printed page order (`page-1`, `page-5`, `page-2`, `page-3`, `page-4`).
`docs/production/checklist-v1.0-reference.json` contains unresolved labels and document headers;
`docs/production/handwritten-review.md` records handwritten notes for separate approval.
Headers are reference only: every service/object mapping remains empty. No handwritten equipment
or answer marks are seeded. The confirmed display name is `Phoenix` in both applicable sections,
with stable key `PHOENIX`. Handwritten `MNG` is documented as `ManageAir` by Indra with proposed
stable key `MANAGEAIR`, but remains review-only and is not added to the template structure.

`importProductionTemplate(db, actorId)` is an explicit transactional service operation, never
called at server startup or by migrations. It creates template + v1.0 draft atomically, returns
unchanged for the same content, rejects a user-modified draft with 409, and leaves published or
archived versions untouched. It never creates schedules or runs. Actor identity must be supplied
by the authorized caller. No production import has been executed.

To prepare a review artifact only, specify a NEW external directory and a test actor ID:

```sh
npx tsx scripts/prepare-production-template.ts /private/tmp/cns-template-review-NEW 1
```

This creates an isolated review database, summary and `Checklist-Template-v1.0.xlsx`.
The script refuses existing destinations and directories inside the current project. It does not
publish, open production databases, or start a server. Do not replace a working checklist.db with
this review database: it contains only the draft, not operational history.

`Yoxlama şablonları` uses the existing template permissions and mutation endpoints. It displays
version history, stable keys, order, required/active, and unresolved reference notes. Excel is a
separate structure export through authenticated
`GET /api/checklist-template-versions/:id/export`; the selected persisted version is exported.
`GET /api/checklist-template-versions/:id/reference` returns the separately maintained source notes
for production v1.0, not immutable database content. No role backend/schema/permission keys changed.
The Rollar modal applies checkbox changes locally; only `Yadda saxla` sends the existing batch API.
Production template publication and real shift configuration still require separate approval.
