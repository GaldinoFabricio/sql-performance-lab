import { describe, it, expect } from "vitest";
import { toTemplate } from "./template";

describe("toTemplate", () => {
   it.each([
      ["Redis connection lost (ECONNRESET), reconnecting in 1126ms", "Redis connection lost (ECONNRESET), reconnecting in <num>ms"],
      ["connect ECONNREFUSED 10.1.225.67:5432", "connect ECONNREFUSED <ip>:<num>"],
      ["POST /api/orders/ord_9xvizahxgg 200 227ms", "POST /api/orders/<id> <num> <num>ms"],
      ["User usr_48213 logged in successfully from 10.2.3.4", "User <id> logged in successfully from <ip>"],
      [
         "request completed method=GET path=/api/cart/items status=200 duration_ms=3 request_id=3f2a9c1e-1b2c-4d5e-8f90-123456789abc",
         "request completed method=GET path=/api/cart/items status=<num> duration_ms=<num> request_id=<uuid>",
      ],
      ["Login succeeded for Ana.Silva@example.com (mfa=true)", "Login succeeded for <email> (mfa=true)"],
      ["getaddrinfo ENOTFOUND kafka-0.kafka.svc.cluster.local", "getaddrinfo ENOTFOUND <host>"],
      ["Unable to resolve hostname ws.correios.com.br while calling fedex", "Unable to resolve hostname <host> while calling fedex"],
      ["TokenExpiredError: jwt expired at 2026-11-13T22:01:09.512Z", "TokenExpiredError: jwt expired at <time>"],
      ["SSL certificate for api.stripe.com expired on 2026-11-10; outbound calls are being rejected", "SSL certificate for <host> expired on <time>; outbound calls are being rejected"],
      ["Container k3j2h1ab was OOMKilled (exit code 137), memory limit 512Mi", "Container <id> was OOMKilled (exit code <num>), memory limit <num>Mi"],
      ["Inventory for SKU-K3J9QZ went negative (-12) after reservation", "Inventory for <id> went negative (<num>) after reservation"],
      ["Payment provider responded 502 Bad Gateway for charge ch_Ab12Cd34Ef56Gh", "Payment provider responded <num> Bad Gateway for charge <id>"],
      // random id that happens to have no digit
      ["Payment provider responded 502 Bad Gateway for charge ch_AbCdEfGhIjKlMn", "Payment provider responded <num> Bad Gateway for charge <id>"],
      ["Transaction aborted due to deadlock while updating order ord_kqzvxbtmwa, retrying (1/3)", "Transaction aborted due to deadlock while updating order <id>, retrying (<num>/<num>)"],
   ])("%s", (message, template) => {
      expect(toTemplate(message)).toBe(template);
   });

   it("keeps codes and words that only look like variables", () => {
      expect(toTemplate("TLS handshake with api.stripe.com failed: x509: certificate has expired")).toBe(
         "TLS handshake with <host> failed: x509: certificate has expired",
      );
      expect(toTemplate(`duplicate key value violates unique constraint "users_email_unique"`)).toBe(
         `duplicate key value violates unique constraint "users_email_unique"`,
      );
      expect(toTemplate("java.lang.OutOfMemoryError: Java heap space")).toBe("java.lang.OutOfMemoryError: Java heap space");
   });

   it("uses only the first line: stack frames vary between runs", () => {
      const a = "TypeError: Cannot read properties of undefined (reading 'id')\n    at OrderService.create (/app/src/services/order.service.ts:12:5)";
      const b = "TypeError: Cannot read properties of undefined (reading 'id')\n    at UserRepository.findById (/app/src/repositories/user.repository.ts:300:9)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)";
      expect(toTemplate(a)).toBe(toTemplate(b));
      expect(toTemplate(a)).toBe("TypeError: Cannot read properties of undefined (reading 'id')");
   });

   it("is idempotent: a template is its own template", () => {
      const t = toTemplate("Connection to postgres at 10.1.2.3:5432 timed out after 3000ms");
      expect(toTemplate(t)).toBe(t);
   });
});
