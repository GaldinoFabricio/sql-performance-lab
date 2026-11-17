import { describe, it, expect } from "vitest";
import { embedText, wildcardValues } from "./values";

describe("wildcardValues", () => {
   it("counts each wildcard's values by number of logs", () => {
      const v = wildcardValues("Rate limit hit when calling <*> API, backing off for <num>s", [
         { variant: "Rate limit hit when calling stripe API, backing off for <num>s", logs: 30 },
         { variant: "Rate limit hit when calling adyen API, backing off for <num>s", logs: 10 },
         { variant: "Rate limit hit when calling stripe API, backing off for <num>s", logs: 5 },
      ]);
      expect(v).toEqual([{ distinct: 2, top: [{ value: "stripe", logs: 35 }, { value: "adyen", logs: 10 }] }]);
   });

   it("one entry per wildcard, in order", () => {
      const v = wildcardValues("Consumer group <*> lag is <num> messages on topic <*>", [
         { variant: "Consumer group orders-cg lag is <num> messages on topic order-events", logs: 1 },
      ]);
      expect(v.map((x) => x.top[0].value)).toEqual(["orders-cg", "order-events"]);
   });

   it("a wildcard can hold several words", () => {
      const v = wildcardValues("Throttling tenant <*> <num> requests", [
         { variant: "Throttling tenant Smith, Jones and Brown: <num> requests", logs: 1 },
      ]);
      expect(v[0].top[0].value).toBe("Smith, Jones and Brown:");
   });
});

describe("embedText", () => {
   it("puts a category's values back and keeps identifiers as <*>", () => {
      const partner = { distinct: 3, top: ["stripe", "adyen", "fedex"].map((value) => ({ value, logs: 1 })) };
      const company = { distinct: 7000, top: [{ value: "Kerluke Group:", logs: 1 }] };
      expect(embedText("calling <*> API", [partner])).toBe("calling stripe / adyen / fedex API");
      expect(embedText("Throttling tenant <*> <num> requests", [company])).toBe("Throttling tenant <*> <num> requests");
   });
});
