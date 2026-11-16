import { Faker, base, en } from "@faker-js/faker";

/**
 * Deterministic generator of realistic application logs.
 *
 * Why it looks like this: semantic search is only interesting when the same
 * problem shows up with *different words*. Each root cause below has several
 * phrasings (different libraries, languages, error codes, with or without a
 * stack trace), so "db connection timeout" should find "Knex: Timeout
 * acquiring a connection" even though they share almost no keywords.
 *
 * Everything is driven by a seeded Faker instance, so the same
 * (seed, count, refDate) always produces the same rows. Evals depend on that.
 */

export type Level = "INFO" | "WARN" | "ERROR" | "FATAL";

export interface GeneratedLog {
   created_at: Date;
   service: string;
   level: Level;
   error_code: string | null;
   message: string;
   root_cause: string;
}

interface Template {
   render: (f: Faker) => string;
   code?: string;
   level?: Level;
}

interface RootCause {
   name: string;
   weight: number;
   level: Level;
   templates: Template[];
   services?: string[];
}

// Skewed like real traffic: the gateway logs far more than anything else.
export const SERVICES: ReadonlyArray<[string, number]> = [
   ["api-gateway", 0.36],
   ["checkout", 0.12],
   ["payments", 0.1],
   ["auth", 0.09],
   ["orders", 0.08],
   ["inventory", 0.06],
   ["notifications", 0.05],
   ["search", 0.05],
   ["billing-worker", 0.04],
   ["user-profile", 0.03],
   ["shipping", 0.02],
];

// --- small helpers -------------------------------------------------------

const ip = (f: Faker) => `10.${f.number.int(9)}.${f.number.int(255)}.${f.number.int({ min: 2, max: 254 })}`;
const ms = (f: Faker, min = 800, max = 30_000) => f.number.int({ min, max });
const orderId = (f: Faker) => `ord_${f.string.alphanumeric({ length: 10, casing: "lower" })}`;
const userId = (f: Faker) => `usr_${f.number.int({ min: 1000, max: 999_999 })}`;
const sku = (f: Faker) => `SKU-${f.string.alphanumeric({ length: 6, casing: "upper" })}`;
const reqId = (f: Faker) => f.string.uuid();
const route = (f: Faker) =>
   f.helpers.arrayElement([
      "/api/orders",
      `/api/orders/${orderId(f)}`,
      "/api/checkout",
      "/api/cart/items",
      `/api/users/${userId(f)}`,
      "/api/payments/charge",
      "/api/products/search",
      "/api/auth/refresh",
   ]);
const partner = (f: Faker) =>
   f.helpers.arrayElement(["stripe", "adyen", "correios", "sendgrid", "twilio", "fedex"]);
const host = (f: Faker) =>
   f.helpers.arrayElement([
      "api.stripe.com",
      "checkout-live.adyen.com",
      "postgres-primary.internal",
      "redis-sessions.internal",
      "kafka-0.kafka.svc.cluster.local",
      "api.sendgrid.com",
      "ws.correios.com.br",
   ]);
const prop = (f: Faker) =>
   f.helpers.arrayElement(["id", "userId", "items", "price", "address", "length", "token", "status"]);
const entity = (f: Faker) => f.helpers.arrayElement(["order", "user", "cart", "payment", "shipment", "product"]);

function nodeStack(f: Faker): string {
   const files = [
      "services/order.service.ts",
      "services/payment.service.ts",
      "controllers/checkout.controller.ts",
      "repositories/user.repository.ts",
      "jobs/invoice.job.ts",
      "middlewares/auth.middleware.ts",
   ];
   const fns = ["create", "handle", "process", "findById", "execute", "charge", "validate", "run"];
   const frames = f.number.int({ min: 2, max: 5 });
   const lines = Array.from({ length: frames }, () => {
      const file = f.helpers.arrayElement(files);
      const cls = file.split("/")[1].split(".")[0];
      const Cls = cls.charAt(0).toUpperCase() + cls.slice(1);
      return `    at ${Cls}.${f.helpers.arrayElement(fns)} (/app/src/${file}:${f.number.int({ min: 10, max: 400 })}:${f.number.int({ min: 5, max: 40 })})`;
   });
   lines.push("    at processTicksAndRejections (node:internal/process/task_queues:95:5)");
   return lines.join("\n");
}

function javaStack(f: Faker): string {
   const classes = [
      "com.shop.orders.OrderService",
      "com.shop.payments.ChargeHandler",
      "com.shop.inventory.StockReservation",
      "com.shop.billing.InvoiceJob",
   ];
   const frames = f.number.int({ min: 2, max: 4 });
   const lines = Array.from({ length: frames }, () => {
      const cls = f.helpers.arrayElement(classes);
      const simple = cls.split(".").pop();
      return `\tat ${cls}.${f.helpers.arrayElement(["process", "handle", "apply", "run"])}(${simple}.java:${f.number.int({ min: 20, max: 600 })})`;
   });
   lines.push("\tat java.base/java.lang.Thread.run(Thread.java:1583)");
   return lines.join("\n");
}

// --- root causes ---------------------------------------------------------
// Weights add up to 1. INFO noise is ~70% of all rows, as in real systems.

const ROOT_CAUSES: RootCause[] = [
   // ---------- INFO noise ----------
   {
      name: "info:http_request",
      weight: 0.43,
      level: "INFO",
      templates: [
         { render: (f) => `${f.helpers.arrayElement(["GET", "POST", "PUT"])} ${route(f)} ${f.helpers.arrayElement([200, 200, 200, 201, 204])} ${ms(f, 3, 400)}ms` },
         { render: (f) => `request completed method=${f.helpers.arrayElement(["GET", "POST"])} path=${route(f)} status=200 duration_ms=${ms(f, 3, 400)} request_id=${reqId(f)}` },
         { render: (f) => `Handled ${route(f)} in ${ms(f, 3, 400)} ms (status 200)` },
      ],
   },
   {
      name: "info:user_login",
      weight: 0.1,
      level: "INFO",
      services: ["auth", "api-gateway"],
      templates: [
         { render: (f) => `User ${userId(f)} logged in successfully from ${f.internet.ipv4()}` },
         { render: (f) => `Login succeeded for ${f.internet.email()} (mfa=${f.datatype.boolean()})` },
         { render: (f) => `Issued new access token for ${userId(f)}, expires in 15m` },
      ],
   },
   {
      name: "info:job_completed",
      weight: 0.1,
      level: "INFO",
      services: ["billing-worker", "notifications", "shipping", "inventory"],
      templates: [
         { render: (f) => `Job ${f.helpers.arrayElement(["send-invoices", "sync-stock", "email-digest", "label-printing"])} finished in ${ms(f, 200, 90_000)}ms, processed ${f.number.int(5000)} items` },
         { render: (f) => `Cron ${f.helpers.arrayElement(["nightly-reconcile", "cleanup-carts", "refresh-search-index"])} completed successfully` },
         { render: (f) => `Batch of ${f.number.int({ min: 10, max: 500 })} messages processed, 0 failures` },
      ],
   },
   {
      name: "info:health_check",
      weight: 0.11,
      level: "INFO",
      templates: [
         { render: () => "Health check OK" },
         { render: (f) => `readiness probe passed (db=up, cache=up) in ${ms(f, 1, 30)}ms` },
         { render: (f) => `Service started on port ${f.helpers.arrayElement([3000, 8080, 8443])} (version ${f.system.semver()})` },
      ],
   },

   // ---------- WARN ----------
   {
      name: "jwt_expired",
      weight: 0.03,
      level: "WARN",
      services: ["auth", "api-gateway", "user-profile"],
      templates: [
         { code: "TOKEN_EXPIRED", render: (f) => `TokenExpiredError: jwt expired at ${f.date.recent().toISOString()}` },
         { code: "HTTP_401", render: (f) => `Rejected request to ${route(f)}: access token expired ${f.number.int({ min: 1, max: 90 })} minutes ago` },
         { code: "HTTP_401", render: (f) => `401 Unauthorized - session for user ${userId(f)} is no longer valid, re-login required` },
         { code: "TOKEN_EXPIRED", render: (f) => `Bearer token rejected: exp claim is in the past (user ${userId(f)})` },
      ],
   },
   {
      name: "rate_limited",
      weight: 0.025,
      level: "WARN",
      templates: [
         { code: "HTTP_429", render: (f) => `429 Too Many Requests from client ${f.internet.ipv4()}: limit ${f.helpers.arrayElement([60, 100, 600])} req/min exceeded` },
         { code: "HTTP_429", render: (f) => `Rate limit hit when calling ${partner(f)} API, backing off for ${f.number.int({ min: 1, max: 60 })}s` },
         { code: "QUOTA_EXCEEDED", render: (f) => `Throttling tenant ${f.company.name()}: ${f.number.int({ min: 600, max: 5000 })} requests in the last minute (quota 500)` },
      ],
   },
   {
      name: "cache_unavailable",
      weight: 0.02,
      level: "WARN",
      templates: [
         { code: "ECONNRESET", render: (f) => `Redis connection lost (ECONNRESET), reconnecting in ${ms(f, 100, 5000)}ms` },
         { code: "ECONNREFUSED", render: (f) => `Cache unreachable at ${ip(f)}:6379, falling back to database for ${entity(f)} lookups` },
         { code: "REDIS_LOADING", render: () => "ReplyError: LOADING Redis is loading the dataset in memory" },
         { render: () => "Failed to read session from cache: Connection is closed." },
      ],
   },
   {
      name: "queue_lag",
      weight: 0.015,
      level: "WARN",
      services: ["notifications", "billing-worker", "orders", "shipping"],
      templates: [
         { code: "KAFKA_LAG", render: (f) => `Consumer group ${f.helpers.arrayElement(["orders-cg", "emails-cg", "invoices-cg"])} lag is ${f.number.int({ min: 5000, max: 900_000 })} messages on topic ${f.helpers.arrayElement(["order-events", "email-outbox", "invoice-requests"])}` },
         { code: "KAFKA_LAG", render: (f) => `Kafka consumer is falling behind: ${f.number.int({ min: 5000, max: 900_000 })} unprocessed events` },
         { render: (f) => `Message processing delayed ${f.number.int({ min: 30, max: 3600 })}s, backlog keeps growing on queue ${f.helpers.arrayElement(["emails", "webhooks", "labels"])}` },
      ],
   },
   {
      name: "slow_query",
      weight: 0.015,
      level: "WARN",
      templates: [
         { code: "SLOW_QUERY", render: (f) => `Slow query took ${ms(f, 1000, 20_000)}ms: SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC` },
         { code: "57014", level: "ERROR", render: () => "canceling statement due to statement timeout" },
         { code: "SLOW_QUERY", render: (f) => `Database call to ${f.helpers.arrayElement(["orders", "order_items", "products"])} exceeded ${f.number.int({ min: 1, max: 10 })}s budget` },
      ],
   },

   // ---------- ERROR / FATAL ----------
   {
      name: "db_connection_timeout",
      weight: 0.035,
      level: "ERROR",
      templates: [
         { code: "ETIMEDOUT", render: (f) => `Connection to postgres at ${ip(f)}:5432 timed out after ${ms(f)}ms` },
         { code: "ECONNREFUSED", render: (f) => `connect ECONNREFUSED ${ip(f)}:5432` },
         { code: "KNEX_TIMEOUT", render: (f) => `KnexTimeoutError: Knex: Timeout acquiring a connection. The pool is probably full. Are you missing a .transacting(trx) call?\n${nodeStack(f)}` },
         { code: "POOL_EXHAUSTED", render: (f) => { const n = f.helpers.arrayElement([10, 20, 50]); return `Database pool exhausted: ${n}/${n} clients busy, request waited ${ms(f)}ms`; } },
         { code: "53300", level: "FATAL", render: () => "FATAL: remaining connection slots are reserved for non-replication superuser connections" },
         { code: "ETIMEDOUT", render: (f) => `Could not reach primary database, giving up after ${f.number.int({ min: 3, max: 10 })} retries` },
      ],
   },
   {
      name: "payment_gateway_5xx",
      weight: 0.025,
      level: "ERROR",
      services: ["payments", "checkout"],
      templates: [
         { code: "HTTP_502", render: (f) => `Payment provider responded 502 Bad Gateway for charge ch_${f.string.alphanumeric(14)}` },
         { code: "HTTP_503", render: (f) => `Stripe API request failed: upstream returned 503 Service Unavailable (request_id=req_${f.string.alphanumeric(14)})` },
         { code: "HTTP_503", level: "WARN", render: (f) => `Charge for order ${orderId(f)} failed: payment processor unavailable, will retry in ${f.number.int({ min: 5, max: 120 })}s` },
         { code: "HTTP_504", render: (f) => `Gateway timeout (504) while capturing payment intent pi_${f.string.alphanumeric(14)}` },
      ],
   },
   {
      name: "null_reference",
      weight: 0.035,
      level: "ERROR",
      templates: [
         { code: "TypeError", render: (f) => `TypeError: Cannot read properties of undefined (reading '${prop(f)}')\n${nodeStack(f)}` },
         { code: "TypeError", render: (f) => `TypeError: Cannot read properties of null (reading '${prop(f)}')\n${nodeStack(f)}` },
         { code: "UNHANDLED", render: (f) => `Unhandled exception: tried to access '${prop(f)}' on an undefined ${entity(f)} object` },
         { code: "NPE", render: (f) => `java.lang.NullPointerException: Cannot invoke "${f.helpers.arrayElement(["Order", "Customer", "Invoice"])}.get${f.helpers.arrayElement(["Id", "Total", "Address"])}()" because "${entity(f)}" is null\n${javaStack(f)}` },
      ],
   },
   {
      name: "out_of_memory",
      weight: 0.008,
      level: "FATAL",
      templates: [
         { code: "ERR_HEAP_OOM", render: () => "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory" },
         { code: "OOMKilled", render: (f) => `Container ${f.string.alphanumeric({ length: 8, casing: "lower" })} was OOMKilled (exit code 137), memory limit ${f.helpers.arrayElement([256, 512, 1024])}Mi` },
         { code: "OOM", render: (f) => `java.lang.OutOfMemoryError: Java heap space\n${javaStack(f)}` },
         { code: "OOM", level: "ERROR", render: (f) => `Worker process exceeded memory limit (${f.number.int({ min: 1100, max: 4000 })} MB > 1024 MB) and was restarted` },
      ],
   },
   {
      name: "disk_full",
      weight: 0.008,
      level: "ERROR",
      templates: [
         { code: "ENOSPC", render: (f) => `ENOSPC: no space left on device, write '/var/log/${f.helpers.arrayElement(["app", "worker", "nginx"])}/out.log'` },
         { code: "EDQUOT", render: (f) => `Failed to persist upload ${f.system.fileName()}: disk quota exceeded on volume ${f.helpers.arrayElement(["data-01", "uploads", "pgdata"])}` },
         { code: "53100", level: "FATAL", render: (f) => `PANIC: could not write to file "pg_wal/xlogtemp.${f.number.int({ min: 100, max: 99999 })}": No space left on device` },
         { code: "DISK_FULL", render: (f) => `Disk usage at ${f.number.int({ min: 96, max: 100 })}% on /var/lib/data, writes are failing` },
      ],
   },
   {
      name: "deadlock",
      weight: 0.01,
      level: "ERROR",
      services: ["orders", "inventory", "checkout", "billing-worker"],
      templates: [
         { code: "40P01", render: (f) => `deadlock detected: Process ${f.number.int({ min: 1000, max: 65000 })} waits for ShareLock on transaction ${f.number.int({ min: 1e6, max: 9e6 })}; blocked by process ${f.number.int({ min: 1000, max: 65000 })}` },
         { code: "40P01", render: (f) => `Transaction aborted due to deadlock while updating order ${orderId(f)}, retrying (${f.number.int({ min: 1, max: 3 })}/3)` },
         { code: "40P01", render: (f) => `Concurrent updates to inventory row ${sku(f)} caused a deadlock; one transaction was rolled back` },
      ],
   },
   {
      name: "duplicate_key",
      weight: 0.012,
      level: "ERROR",
      services: ["auth", "user-profile", "orders", "inventory", "checkout"],
      templates: [
         { code: "23505", render: () => `duplicate key value violates unique constraint "users_email_unique"` },
         { code: "EMAIL_TAKEN", level: "WARN", render: (f) => `Cannot create account: email ${f.internet.email()} is already registered` },
         { code: "23505", render: (f) => `UniqueViolation: Key (sku)=(${sku(f)}) already exists.` },
         { code: "IDEMPOTENCY_CONFLICT", level: "WARN", render: (f) => `Idempotency conflict: order ${orderId(f)} was already submitted` },
      ],
   },
   {
      name: "dns_failure",
      weight: 0.008,
      level: "ERROR",
      templates: [
         { code: "ENOTFOUND", render: (f) => `getaddrinfo ENOTFOUND ${host(f)}` },
         { code: "EAI_AGAIN", render: (f) => `DNS lookup for ${host(f)} failed (EAI_AGAIN): temporary failure in name resolution` },
         { code: "ENOTFOUND", render: (f) => `Unable to resolve hostname ${host(f)} while calling ${partner(f)}` },
      ],
   },
   {
      name: "tls_cert_expired",
      weight: 0.006,
      level: "ERROR",
      templates: [
         { code: "CERT_HAS_EXPIRED", render: (f) => `Error: certificate has expired (CERT_HAS_EXPIRED) when connecting to ${host(f)}:443` },
         { code: "X509", render: (f) => `TLS handshake with ${host(f)} failed: x509: certificate has expired or is not yet valid` },
         { code: "CERT_HAS_EXPIRED", render: (f) => `SSL certificate for ${host(f)} expired on ${f.date.recent({ days: 10 }).toISOString().slice(0, 10)}; outbound calls are being rejected` },
      ],
   },
   {
      name: "stock_inconsistency",
      weight: 0.008,
      level: "ERROR",
      services: ["inventory", "orders", "checkout"],
      templates: [
         { code: "INVENTORY_NEGATIVE", render: (f) => `Inventory for ${sku(f)} went negative (${-f.number.int({ min: 1, max: 40 })}) after reservation` },
         { code: "OVERSOLD", render: (f) => { const m = f.number.int({ min: 0, max: 5 }); return `Oversold product ${sku(f)}: ${m + f.number.int({ min: 1, max: 9 })} units ordered but only ${m} in stock`; } },
         { code: "RECONCILE_MISMATCH", level: "WARN", render: (f) => `Stock reconciliation mismatch in warehouse ${f.location.city()}: expected ${f.number.int(500)}, counted ${f.number.int(500)}` },
      ],
   },
];

const totalWeight = ROOT_CAUSES.reduce((a, r) => a + r.weight, 0);
if (Math.abs(totalWeight - 1) > 1e-9) {
   throw new Error(`root cause weights must add up to 1, got ${totalWeight}`);
}

export const ROOT_CAUSE_NAMES = ROOT_CAUSES.map((r) => r.name);

export interface GeneratorOptions {
   count: number;
   seed?: number;
   /** Timestamp of the newest log. Fixed by default so runs are reproducible. */
   refDate?: Date;
   /** How many days of history the logs cover. */
   days?: number;
}

export const DEFAULT_SEED = 42;
export const DEFAULT_REF_DATE = new Date("2026-11-14T00:00:00Z");

/**
 * Yields `count` logs in chronological order (logs are append-only, so ids
 * and created_at grow together, like in a real table).
 */
export function* generateLogs(opts: GeneratorOptions): Generator<GeneratedLog> {
   const f = new Faker({ locale: [en, base] });
   f.seed(opts.seed ?? DEFAULT_SEED);
   const ref = opts.refDate ?? DEFAULT_REF_DATE;
   f.setDefaultRefDate(ref);

   const spanMs = (opts.days ?? 30) * 24 * 3600 * 1000;
   const start = ref.getTime() - spanMs;
   const step = spanMs / Math.max(opts.count, 1);

   const causes = ROOT_CAUSES.map((r) => ({ weight: r.weight, value: r }));
   const services = SERVICES.map(([value, weight]) => ({ value, weight }));

   for (let i = 0; i < opts.count; i++) {
      const cause = f.helpers.weightedArrayElement(causes);
      const tpl = f.helpers.arrayElement(cause.templates);
      const service = cause.services
         ? f.helpers.arrayElement(cause.services)
         : f.helpers.weightedArrayElement(services);
      const jitter = f.number.float({ min: 0, max: step });

      yield {
         created_at: new Date(start + i * step + jitter),
         service,
         level: tpl.level ?? cause.level,
         error_code: tpl.code ?? null,
         message: tpl.render(f),
         root_cause: cause.name,
      };
   }
}
