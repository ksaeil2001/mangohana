import { describe, expect, it } from "vitest";
import {
  canBreakBetweenChars,
  isLineEndProhibited,
  isLineStartProhibited,
  sanitizeLineBreakByKlreq
} from "../../src/shared/typesettingKlreq.js";

describe("typesettingKlreq", () => {
  describe("isLineStartProhibited (전치 금칙 문자)", () => {
    it("identifies closing brackets and quotes as line-start prohibited", () => {
      expect(isLineStartProhibited(")")).toBe(true);
      expect(isLineStartProhibited("]")).toBe(true);
      expect(isLineStartProhibited("}")).toBe(true);
      expect(isLineStartProhibited("”")).toBe(true);
      expect(isLineStartProhibited("’")).toBe(true);
      expect(isLineStartProhibited("」")).toBe(true);
    });

    it("identifies punctuation marks as line-start prohibited", () => {
      expect(isLineStartProhibited("!")).toBe(true);
      expect(isLineStartProhibited("?")).toBe(true);
      expect(isLineStartProhibited(".")).toBe(true);
      expect(isLineStartProhibited(",")).toBe(true);
      expect(isLineStartProhibited("…")).toBe(true);
      expect(isLineStartProhibited("~")).toBe(true);
    });

    it("allows standard letters and words at line start", () => {
      expect(isLineStartProhibited("가")).toBe(false);
      expect(isLineStartProhibited("A")).toBe(false);
      expect(isLineStartProhibited("1")).toBe(false);
    });
  });

  describe("isLineEndProhibited (후치 금칙 문자)", () => {
    it("identifies opening brackets and quotes as line-end prohibited", () => {
      expect(isLineEndProhibited("(")).toBe(true);
      expect(isLineEndProhibited("[")).toBe(true);
      expect(isLineEndProhibited("{")).toBe(true);
      expect(isLineEndProhibited("“")).toBe(true);
      expect(isLineEndProhibited("‘")).toBe(true);
      expect(isLineEndProhibited("「")).toBe(true);
    });

    it("identifies currency symbols as line-end prohibited", () => {
      expect(isLineEndProhibited("₩")).toBe(true);
      expect(isLineEndProhibited("\\")).toBe(true);
      expect(isLineEndProhibited("$")).toBe(true);
    });

    it("allows standard letters and words at line end", () => {
      expect(isLineEndProhibited("다")).toBe(false);
      expect(isLineEndProhibited("Z")).toBe(false);
    });
  });

  describe("canBreakBetweenChars (분리 금칙 단위)", () => {
    it("prohibits break between continuous exclamation/question marks", () => {
      expect(canBreakBetweenChars("!", "?")).toBe(false);
      expect(canBreakBetweenChars("?", "!")).toBe(false);
      expect(canBreakBetweenChars("!", "!")).toBe(false);
      expect(canBreakBetweenChars(".", ".")).toBe(false);
      expect(canBreakBetweenChars("~", "~")).toBe(false);
    });

    it("prohibits break between numbers and decimal/unit", () => {
      expect(canBreakBetweenChars("1", "2")).toBe(false);
      expect(canBreakBetweenChars("3", ".")).toBe(false);
      expect(canBreakBetweenChars(".", "5")).toBe(false);
      expect(canBreakBetweenChars("1", "%")).toBe(false);
    });

    it("prohibits break within english words", () => {
      expect(canBreakBetweenChars("W", "o")).toBe(false);
      expect(canBreakBetweenChars("r", "d")).toBe(false);
    });

    it("allows break between distinct hangul characters", () => {
      expect(canBreakBetweenChars("안", "녕")).toBe(true);
    });
  });

  describe("sanitizeLineBreakByKlreq", () => {
    it("pulls line-start prohibited punctuation to preceding line", () => {
      const [line1, line2] = sanitizeLineBreakByKlreq("정말인가", "!? 믿을 수 없어");
      expect(line1).toBe("정말인가!?");
      expect(line2).toBe("믿을 수 없어");
    });

    it("pulls closing quotes and commas to preceding line", () => {
      const [line1, line2] = sanitizeLineBreakByKlreq("그는 말했다", "”, 그리고 떠났다");
      expect(line1).toBe("그는 말했다”,");
      expect(line2).toBe("그리고 떠났다");
    });

    it("pushes line-end prohibited opening bracket to next line", () => {
      const [line1, line2] = sanitizeLineBreakByKlreq("주인공은 (", "루피)라고 한다");
      expect(line1).toBe("주인공은");
      expect(line2).toBe("(루피)라고 한다");
    });
  });
});
