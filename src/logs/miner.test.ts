import { describe, it, expect } from "vitest";
import { TemplateMiner, clusterText } from "./miner";
import { toTemplate } from "./template";

const mine = (messages: string[], partition = "WARN|HTTP_429") => {
   const m = new TemplateMiner();
   const ids = messages.map((msg) => m.add(toTemplate(msg), partition).id);
   return { m, ids, texts: m.all.map(clusterText) };
};

describe("TemplateMiner", () => {
   it("a name with a different number of words becomes one <*>", () => {
      const { ids, texts } = mine([
         "Throttling tenant Kerluke Group: 900 requests in the last minute (quota 500)",
         "Throttling tenant Smith, Jones and Brown: 1200 requests in the last minute (quota 500)",
         "Throttling tenant Acme: 700 requests in the last minute (quota 500)",
      ]);
      expect(new Set(ids).size).toBe(1);
      expect(texts).toEqual(["Throttling tenant <*> <num> requests in the last minute (quota <num>)"]);
   });

   it("several variables of one word each, position by position", () => {
      const { texts } = mine([
         "Failed to persist upload greatly.bz2: disk quota exceeded on volume uploads",
         "Failed to persist upload report_final.pdf: disk quota exceeded on volume pgdata",
      ]);
      expect(texts).toEqual(["Failed to persist upload <*> disk quota exceeded on volume <*>"]);
   });

   it("the cluster id never changes, even when its text gets more general", () => {
      const m = new TemplateMiner();
      const a = m.add("Stock reconciliation mismatch in warehouse Lakeland: expected <num>, counted <num>");
      const b = m.add("Stock reconciliation mismatch in warehouse North Kellifurt: expected <num>, counted <num>");
      expect(b.id).toBe(a.id);
      expect(clusterText(b)).toBe("Stock reconciliation mismatch in warehouse <*> expected <num>, counted <num>");
   });

   it("different partitions (level, error_code) never merge", () => {
      const m = new TemplateMiner();
      const a = m.add("Gateway timeout (<num>) while capturing payment intent <id>", "ERROR|HTTP_504");
      const b = m.add("Gateway timeout (<num>) while capturing payment intent <id>", "ERROR|HTTP_503");
      expect(a.id).not.toBe(b.id);
   });

   it("short messages never merge: one word can be the whole meaning", () => {
      const { ids } = mine(["Health check OK", "Health check FAILED"], "INFO|");
      expect(new Set(ids).size).toBe(2);
   });

   it("templates that only share the beginning stay apart", () => {
      const { ids } = mine(
         [
            "Consumer group orders-cg lag is <num> messages on topic order-events",
            "Consumer is falling behind: <num> unprocessed events on every partition of the cluster",
         ],
         "WARN|KAFKA_LAG",
      );
      expect(new Set(ids).size).toBe(2);
   });

   it("an exact repeat returns the same cluster without comparing", () => {
      const m = new TemplateMiner();
      const t = "Redis connection lost (ECONNRESET), reconnecting in <num>ms";
      expect(m.add(t).id).toBe(m.add(t).id);
      expect(m.all).toHaveLength(1);
   });
});
