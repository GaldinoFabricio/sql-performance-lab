import { describe, expect, it } from "vitest";
import { codesIn } from "../search/codes";

const known = new Map(["ECONNRESET", "40P01", "HTTP_502", "X509", "TypeError"].map((c) => [c.toLowerCase(), c]));

describe("codesIn", () => {
   it.each([
      ["ECONNRESET", ["ECONNRESET"]],
      ["econnreset", ["ECONNRESET"]],
      ["lots of x509 errors since the deploy", ["X509"]],
      ["typeerror and HTTP_502 again", ["TypeError", "HTTP_502"]],
      ["40P01, 40p01 and 40P01", ["40P01"]],
      ["ECONNRESET: socket hang up", ["ECONNRESET"]],
   ])("%s → %j", (text, codes) => {
      expect(codesIn(text, known)).toEqual(codes);
   });

   it.each(["redis is down", "HTTP 502", "502", "x509certificate", "ECONNRESETS"])("%s → nenhum código", (text) => {
      // only whole tokens equal to a known code count: "502" is not HTTP_502
      expect(codesIn(text, known)).toEqual([]);
   });
});
