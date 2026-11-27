# Research: jobs, events and middleware in mature stacks

How Rails, Laravel, Phoenix and the JS platforms handle "do this after the write", crons and per-function middleware, and why they chose what they did. Checked against source and docs on 2026-11-20. Decisions taken from this live in DESIGN.md; inference is labelled.

## The question

A mutation commits and something must follow: an email, a webhook, a sync. There are two ways to fail:

- **A phantom job:** the job runs, but the write rolled back (or the job runs before the commit and can't see the row).
- **A lost job:** the write commits, then the process dies before the job is handed to the queue.

Enqueueing after commit fixes the first. Only a queue that lives in the same database, written in the same transaction, fixes both. Everything below is a variation on that trade.

## Rails

**Active Job** is one interface with an adapter per backend. `AbstractAdapter` is 26 lines and needs only `enqueue`, `enqueue_at` and `stopping?`. Solid Queue's adapter is 23 lines of code, Rails' `async` adapter 72, Sidekiq's 74 (it now ships in the sidekiq gem; Rails deprecated its copy in 8.1).

**`enqueue_after_transaction_commit`, a three-step history:**

1. Rails 7.2 added it with `:never`, `:always` and `:default`, letting each adapter decide ([rails#51426](https://github.com/rails/rails/pull/51426)).
2. [rails#53375](https://github.com/rails/rails/pull/53375) (Oct 2024) made it a plain boolean and stopped asking the adapter: leaving it implicit was "too dangerous". The class default stayed `false`.
3. On main, [rails#55788](https://github.com/rails/rails/pull/55788) (merged 2025-12-28) turns it on under `load_defaults "8.2"`. The changelog: it "fixes that jobs would surprisingly run against uncommitted and rolled-back records". 8.2 is unreleased (latest is 8.1.4.1, 2026-11-04), so released Rails still defaults to off.

**How it works:** the push is wrapped in `ActiveRecord.after_all_transactions_commit`, an in-memory callback (`activejob/lib/active_job/enqueue_after_transaction_commit.rb`). So it fixes phantom jobs and keeps the lost-job window: a crash after COMMIT and before the push loses the job (inference from the code). That's true for Sidekiq, SQS, and Solid Queue in its own database.

**Solid Queue** (the Rails 8 default) keeps jobs in a database table, so it *could* be transactional. Its README, "Jobs and transactional integrity":

- In the same database, on the same connection, the job's INSERT commits or rolls back with your data.
- It calls this "a powerful yet sharp tool": logic that relies on it "can also backfire". The behaviour changes silently the day you move the queue to its own database or switch Active Job backends.
- That coupling is the only reason it gives for its default: "by default Solid Queue is configured in a different database as the main app". No performance or locking reason is stated. (SQLite's single writer would also argue for a separate file under load; that's inference, not in the README.)
- A "Single database configuration" section shows how to opt in.

**Crashed workers:** jobs claimed by a process whose heartbeat expired are marked failed with `ProcessPrunedError`, and "Solid Queue deliberately doesn't retry these automatically", because the job may be what killed the process. Recovery is manual (Mission Control). A graceful `QUIT` returns in-flight jobs to the queue.

**Setup:** a `queue` database with `db/queue_migrate`, a `bin/jobs` process or the Puma plugin, and `config/recurring.yml` for crons.

## Fizzy (37signals, shallow clone at `da4fb42`, 2026-11-19)

A real production Rails app, so it shows what the defaults become in practice.

- **Backend:** Solid Queue in its own database: `config.solid_queue.connects_to = { database: { writing: :queue, reading: :queue } }` (`config/environments/production.rb:103`). It runs inside Puma via `plugin :solid_queue` (`config/puma.rb:13`), or `bin/jobs`.
- **After-commit on purpose:** `config/initializers/active_job.rb` sets `self.enqueue_after_transaction_commit = true`, explicitly, on `load_defaults 8.1`.
- **Enqueue style:** model callbacks plus `*_later` methods, 25 `after_*_commit` callbacks and 15 `def *_later`. For example `after_create_commit :deliver_later` in `app/models/webhook/delivery.rb:24`.
- **Crons:** about 17 entries in `config/recurring.yml`, for example `Notification::Bundle.deliver_all_later` every 30 minutes and `Webhook::Delivery.cleanup` every 15.

### What a crash loses, concretely

**A webhook, lost for good.** A card moves:

1. A `Webhook::Delivery` row commits with `state: pending`.
2. `after_create_commit :deliver_later` pushes `Webhook::DeliveryJob` into the queue database. That's a callback in process memory.
3. The process dies between 1 and 2 (a deploy kill, out of memory). The row stays `pending` forever. Nothing re-drives pending deliveries; `cleanup` deletes them once they're older than `STALE_TRESHOLD = 7.days`. The customer's webhook never fires, and nobody is told.

**A notification email, only delayed.** Notifications are grouped into `Notification::Bundle` rows with `status: pending` and a time window. The recurring `deliver_all_later` finds every bundle that's `due` (pending, window ended) and delivers it (`app/models/notification/bundle.rb`). If a process dies, the next run picks the bundle up.

**The lesson:** Fizzy accepts the crash window for things that don't matter much, and for things that do, it writes **state in a row and sweeps it with a recurring job**. That's an outbox in domain clothes: the write and the intent to act commit together, and something retries until the intent is done. Rails apps don't skip the outbox; they hand-build it where the consequence matters.

## Laravel (13.x)

- **Drivers:** one `Contracts\Queue\Queue` interface (130 lines) and a base `Queue.php` (581) holding the after-commit logic. Drivers are bigger than Rails' because they carry management features: `SqsQueue.php` 725 lines, `DatabaseQueue.php` 691, `RedisQueue.php` 721.
- **The default is the database driver.** The skeleton sets `QUEUE_CONNECTION=database` and ships a `jobs` table migration. `DatabaseQueue::pushToDatabase` is a plain insert on the connection named by `DB_QUEUE_CONNECTION`, which defaults to the app's own. So, by default, a job dispatched inside a transaction **joins that transaction** (inference from the code): Laravel's default is transactional where Rails' is not.
- **`after_commit` is opt-in:** `'after_commit' => false` on every connection in `config/queue.php`. When true, Laravel "will wait until the open parent database transactions have been committed before actually dispatching the job", and jobs dispatched in a rolled-back transaction "will be discarded". Per dispatch: `->afterCommit()` and `->beforeCommit()`. Queued listeners: `ShouldQueueAfterCommit`. Events: `ShouldDispatchAfterCommit`. Like Rails, it's an in-memory callback (`db.transactions->addCallback`), with the same crash window.
- **Retries belong to the job:** "If the maximum number of attempts is specified on the job, it will take precedence over the `--tries` value provided on the command line." Backoff is per job too (`#[Backoff([10, 30, 60])]`).
- **Failures are data:** a job that exhausts its attempts is inserted into the `failed_jobs` table; `queue:failed` lists them, `queue:retry <uuid>|all` re-runs them. `#[DeleteWhenMissingModels]` quietly discards a job whose model was deleted meanwhile.
- **Uniqueness:** `ShouldBeUnique` skips dispatch while an identical job is queued (needs a cache with locks).
- **Setup:** `queue:work` workers, plus one system cron running `schedule:run` for the scheduler.

Source: [Laravel 13 queues](https://laravel.com/docs/13.x/queues), `laravel/laravel` `config/queue.php`, framework v13.43.0.

## Phoenix and Oban

- **Transactional enqueue is Oban's headline.** Its README lists "Transactional Control: Enqueue a job along with other database changes, ensuring that everything is committed or rolled back atomically." `Oban.insert(multi, name, changeset)` adds the job to an `Ecto.Multi` that goes through `Repo.transaction()` (`lib/oban.ex`, since 0.7.0).
- **Setup:** run `Oban.Migration`, add Oban to the supervision tree (no separate worker binary), crons through the Cron plugin. Engines for Postgres, MySQL and SQLite.
- **Uniqueness is checked at insert:** `unique: [period, fields, keys, states]`. On conflict, `insert` still returns `{:ok, job}` with `conflict?: true`, and `:replace` can update the existing job ([unique jobs](https://oban.hexdocs.pm/unique_jobs.html)).
- **Phoenix 1.8 scopes:** a `%Scope{}` struct holds "information required by the majority of pages", such as the user and their organization. Generated context functions take it first: `list_posts(%Scope{} = scope)`. A plug (`fetch_current_scope_for_user`) or an `on_mount` hook builds it. To add an organization, a plug loads it from the URL (`/organizations/:org/posts`) and puts it on the scope ([scopes guide](https://phoenix.hexdocs.pm/scopes.html)).

## JavaScript and the platforms

Nothing on Cloudflare or Vercel can join your Postgres transaction. The transactional options all live in Postgres.

| | Transactional with your DB | How |
|---|---|---|
| **pg-boss** 12.38 | Yes | `send(name, data, { db: fromDrizzle(tx, sql) })`; also `fromKysely`, `fromKnex`, `fromPrisma`. ORM adapters are 15 to 91 lines |
| **Graphile Worker** 0.18 | Yes | `graphile_worker.add_job(...)` is SQL, callable in your transaction |
| **Convex** | Yes, because it is the database | `ctx.scheduler.runAfter` / `runAt` in a mutation: "if the mutation succeeds, the scheduled function is guaranteed to be scheduled" |
| **Cloudflare Queues** | No | Binding `send`; consumer `queue(batch, env, ctx)` with `ack` / `retry({ delaySeconds })`; retries, concurrency and DLQ per consumer in wrangler; at least once |
| **Vercel Queues** (beta) | No | `send(topic, payload, { delaySeconds, idempotencyKey })`; consumer route wrapped in `handleCallback`, wired in `vercel.json` `experimentalTriggers`; at least once, fan-out to consumer groups |
| **Inngest** | No | Their answer to the outbox is CDC through Postgres logical replication ([Neon triggers](https://www.inngest.com/blog/neon-postgres-database-triggers-for-durable-functions)) |
| **Trigger.dev, QStash** | No | HTTP sends with idempotency keys |

**Adapter shape and size:**

- **Inngest:** one core (`InngestCommHandler.ts`, 3,058 lines) and a thin `serve()` per runtime that only maps request and response: `cloudflare.ts` 166 lines, `hono.ts` 115, `bun.ts` 75, `next.ts` 399.
- **Upstash Workflow:** one subpath per framework (`/cloudflare`, `/nextjs`, `/hono`, ...).
- **Vercel Workflow DevKit "Worlds"** are big because a World stores an event-sourced log (`World extends Storage, Queue, Streamer`): world-vercel 18.1k lines, world-postgres 12.6k, world-local 8.2k, the experimental world-cloudflare 2.0k (one Durable Object per run). Optional behaviour is declared as `capabilities` flags that fail closed.
- **pg-boss** needs a long-lived instance for workers; for serverless it offers `registerInstance: false` or `@pg-boss/proxy`.

**Crons:**

- **Convex:** `convex/crons.ts`, `crons.cron(name, "0 2 * * *", internal.x.y)`. At most one run of a cron at a time; overrunning runs are skipped.
- **Cloudflare:** a `scheduled(controller, env, ctx)` handler plus `triggers.crons` in wrangler, always UTC. A deploy replaces all triggers.
- **Vercel:** Cron Jobs are now labelled legacy, replaced by Schedules (public beta): a `schedules` map in `vercel.json` with timezone and jitter, targeting a function, a path or a Queues topic ([docs](https://vercel.com/docs/schedules/configuration)).
- **Nitro:** `defineTask` plus `scheduledTasks` in config; each deploy preset maps it to croner, Cloudflare Cron Triggers or Vercel Cron. Tasks aren't durable ([docs](https://nitro.build/docs/tasks)).
- **pg-boss:** `schedule(name, cron, data, { tz })`, deduped across instances.

**Stable ids:** Inngest's function `id` "should not change between deploys" ([docs](https://www.inngest.com/docs/reference/functions/create)), because queued runs refer to it. Its per-function config is where options live: `retries` (0 to 20, default 4), `concurrency` with a `key`, `idempotency`, `debounce`, `rateLimit`, `throttle`, `priority`, `triggers`.

## Middleware and ctx extension

**Builder chains exist because those libraries are the HTTP edge.** tRPC, oRPC and TanStack Start chain `.use(mw)` so a middleware can resolve the session or organization and add typed fields to ctx (`ctx.session`, `ctx.org`). That's the request's job, and it happens before any business rule.

**Mature stacks put that work at the edge too, then pass plain data down:**

- **Phoenix 1.8:** plugs build the scope, including the organization from the URL; contexts take the scope as their first argument.
- **Rails:** `before_action :set_project` loads a record in the controller. In logic-sdk that's `findProject(ctx, id)`, called inside the transaction, so a retry re-reads it and it's account-scoped.
- **Laravel:** middleware lives on HTTP routes; the service container injects dependencies, which are our `services`.

Per-function ctx extension, as opposed to per request or per app, has no clear use in business logic that a helper doesn't cover (inference: neither we nor an independent review could construct one).

**Cost of chains (measured, `any` in core source, 2026-11-20):**

| Library | File | Lines | `any` |
|---|---|---|---|
| logic-sdk | `index.ts` | 832 | 10 |
| tRPC | `procedureBuilder.ts` | 792 | 40 |
| oRPC | `builder.ts` / `router.ts` | 327 / 105 | 16 / 29 |
| Convex | one core server file | 772 | 89 |
| TanStack Start | `createServerFn.ts` / `createMiddleware.ts` | 934 / 818 | ~35 / ~21 |
| TanStack Router | `router-core/src`, all files | 15,148 | ~300 |
| TanStack Query | `queryClient.ts` / `types.ts` | 1,177 / 2,440 | ~41 / 3 |

The TanStack counts are a rough grep that includes a few words in comments. Every library erases types where it stores differently typed functions; chains erase at each step because each step changes the builder's type. TanStack Start also casts in `handler` because a Babel transform rewrites its signature at build time.

## Scope at rest: who a job runs as

A job may run hours later, after retries. None of these stacks carry the caller's identity or permissions into it as a snapshot.

- **Rails:** records go by reference (GlobalID) and are loaded again when the job runs; a deleted record raises `ActiveJob::DeserializationError`, handled with `discard_on` ([guide](https://guides.rubyonrails.org/active_job_basics.html)). `I18n.locale` and the timezone are written into the payload and restored ([`core.rb`](https://github.com/rails/rails/blob/main/activejob/lib/active_job/core.rb)). `Current` attributes are not carried, as far as we can tell: the executor resets them and jobs run inside it (inference from the railties source; the API page only mentions requests), and the API docs show a job setting `Current.person` from its own arguments ([CurrentAttributes](https://api.rubyonrails.org/classes/ActiveSupport/CurrentAttributes.html)).
- **Fizzy:** `app/jobs/concerns/account_tenanted.rb`, prepended to `ApplicationJob`, captures `Current.account` at enqueue as a GlobalID, finds it again at perform and wraps the job in `Current.with_account`. A missing account raises `DeserializationError` "where discard_on can handle it". It carries the account, never the user.
- **Laravel:** `SerializesModels` queues only the model's id and re-fetches it fresh; a deleted model is `ModelNotFoundException`, or a quiet discard with `#[DeleteWhenMissingModels]` ([queues](https://laravel.com/docs/13.x/queues)). The `Context` facade is dehydrated into the job payload and hydrated when it runs, so you choose what crosses ([context](https://laravel.com/docs/12.x/context)). Tenancy packages restore the tenant per job ([stancl](https://tenancyforlaravel.com/docs/v3/queues), [spatie](https://spatie.be/docs/laravel-multitenancy/v4/basic-usage/making-queues-tenant-aware)). The queues docs re-check authorization inside the job (`$this->user->authorize(...)`) and fail it for good when "a user's permissions being revoked".
- **Oban:** args are JSON ([worker](https://oban.hexdocs.pm/Oban.Worker.html)). The Phoenix scopes guide doesn't cover jobs; the community answer is to pass the user id and rebuild the scope in `perform/1`, with a privileged scope for system jobs ([forum](https://elixirforum.com/t/oban-on-phoenix-apps-with-scope-contexts/74021), unofficial).

**The common pattern** (inference from all of the above), with one exception: Laravel's Context carries whatever you put in it as a snapshot, and Convex carries nothing ("The auth is not propagated from the scheduling to the scheduled function"). Otherwise: store identifiers, not snapshots; load them fresh at run time; treat "gone" as discard, not retry; restore ambient context (tenant, locale, timezone) explicitly; re-check permissions rather than trust the enqueuer.

## What we take from each

- **Rails:** the after-commit default is the honest baseline for external queues, with the crash window documented, not hidden. Small adapter interface (enqueue, enqueue at).
- **Fizzy:** where the consequence matters, a row plus a recurring sweep. We offer that as `databaseQueue(database)`, so nobody writes it by hand.
- **Laravel:** options that change correctness live on the job (`$tries`, backoff, uniqueness), not on the worker. Failures are rows you can list and retry. The database queue joins the transaction by default.
- **Scope at rest:** store ids, rebuild the scope fresh at delivery, discard when what it points at is gone (Rails, Fizzy, Laravel). Our policies already re-run on every `ctx.run`, so a fresh scope gets Laravel's re-check for free.
- **Phoenix and Oban:** transactional enqueue is worth headlining when the queue is in your database (pg-boss for us). Scope built at the edge, passed first: our `scope`.
- **Convex:** schedule from a mutation, atomically; crons declared in code, one run at a time.
- **Inngest and Upstash:** one core, a thin adapter per target. Stable ids for anything a queue refers to.
- **Workflow DevKit:** capabilities that fail closed. Not its size: a World is a storage engine, our dispatcher isn't.
- **Nitro:** crons in code, mapped to each platform's trigger.

## Sources

- Rails: [#51426](https://github.com/rails/rails/pull/51426), [#53375](https://github.com/rails/rails/pull/53375), [#55788](https://github.com/rails/rails/pull/55788), [Active Job basics](https://guides.rubyonrails.org/active_job_basics.html), [Solid Queue README](https://github.com/rails/solid_queue), [Fizzy](https://github.com/basecamp/fizzy) at `da4fb42`
- Laravel: [queues 13.x](https://laravel.com/docs/13.x/queues), [events](https://laravel.com/docs/13.x/events), [laravel/laravel config/queue.php](https://github.com/laravel/laravel/blob/13.x/config/queue.php)
- Adonis: [queues](https://docs.adonisjs.com/guides/digging-deeper/queues), [emitter](https://docs.adonisjs.com/guides/digging-deeper/emitter)
- Phoenix: [Oban](https://oban.hexdocs.pm/Oban.html), [Oban unique jobs](https://oban.hexdocs.pm/unique_jobs.html), [Phoenix scopes](https://phoenix.hexdocs.pm/scopes.html)
- Platforms: [Cloudflare Queues JS APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/), [configure queues](https://developers.cloudflare.com/queues/configuration/configure-queues/), [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Vercel Queues](https://vercel.com/docs/queues), [Vercel Queues SDK](https://vercel.com/docs/queues/sdk), [Vercel Schedules](https://vercel.com/docs/schedules/configuration)
- JS: [pg-boss](https://github.com/timgit/pg-boss), [Graphile Worker](https://worker.graphile.org/), [Convex scheduling](https://docs.convex.dev/scheduling/scheduled-functions), [Convex crons](https://docs.convex.dev/scheduling/cron-jobs), [Inngest createFunction](https://www.inngest.com/docs/reference/functions/create), [Vercel Workflow](https://github.com/vercel/workflow), [Upstash Workflow](https://upstash.com/docs/workflow), [Nitro tasks](https://nitro.build/docs/tasks)
- Middleware: [TanStack Start middleware](https://tanstack.com/start/latest/docs/framework/react/guide/middleware), [TanStack/router](https://github.com/TanStack/router) at `ce46b21`, [TanStack/query](https://github.com/TanStack/query) at `f6689e0`

## Moved from the user docs (2026-11-27)

The user docs stopped naming other stacks. Comparisons they carried that weren't already here or in DESIGN.md are kept below, as the docs stated them. Unless a link is given, they weren't rechecked when moved.

**Authorization** (was `concepts/authorization.mdx`, "How other stacks do it"):

| Stack | What it does |
|---|---|
| Rails (Fizzy) | `before_action` calls `Current.user.can_administer_card?(@card)` and answers `head :forbidden` |
| Laravel | Policies are boolean methods on (user, record). A failed policy is a 403, signed in or not |
| Phoenix 1.8 | Scopes: an explicit scope, secure by default, passed by hand to every function. Here it's bound once |
| Next.js | Recommends a Data Access Layer that checks who's calling. This is that layer, as a library |
| Convex | Functions are public unless `internal*`. Here they're internal unless an adapter publishes them |

- **Fizzy's record rules:** a controller says `before_action :ensure_permission_to_administer_card`, which does `head :forbidden unless Current.user.can_administer_card?(@card)`, and the predicate is a plain method:

  ```ruby
  def can_administer_card?(card)
    admin? || card.creator == self
  end
  ```

  Our `can*` predicates are that shape. Laravel's policies are too: boolean methods on a user and a record.
- **A failed policy is a 403 even when nobody is signed in,** like Laravel. The docs said the same of a public mount's functions.

**Crons** (was `concepts/crons.mdx`): a minute nobody ticked is skipped, not caught up, like Laravel. Runs may overlap in Laravel, Oban and Vercel.

**Errors and transactions:**

- Rails warns against catching database errors inside a transaction block, for the reason Postgres aborts a transaction after a failed statement (was `concepts/errors.mdx`).
- Convex draws our action/mutation line: an action's [`runMutation` calls run in separate transactions](https://github.com/get-convex/convex-backend/blob/main/npm-packages/docs/docs/functions/actions.mdx) (was `concepts/transactions.mdx`).

**Functions and helpers** (was `concepts/functions.mdx`): Convex recommends helpers that take the whole `ctx`, and advises using `ctx.runQuery` and `ctx.runMutation` sparingly, preferring plain TypeScript functions. Ours is the same advice within a module.

**Feature flags** (was `concepts/feature-flags.mdx`): "the Convex way": a flag is a row, and a query reads it.

**Meta** (was `concepts/meta.mdx`): a config-declared shape, then per-function values, is the same split as tRPC's `initTRPC.meta<Meta>()` and `.meta({ ... })`.

**Testing** (was `04-testing.mdx`): `t.jobs.perform` is Oban's `perform_job` and Rails' `perform_now`. `drain({ until })`, which runs each job at the time it was due, is Rails' `perform_enqueued_jobs(at:)` and Oban's `with_scheduled`.
