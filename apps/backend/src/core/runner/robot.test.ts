import { describe, expect, it } from "vitest";
import { parseOutputXml } from "./robot";

describe("parseOutputXml", () => {
    it("reports a passing suite", () => {
        const xml = `<robot><suite name="S"><test name="T"><status status="PASS"/></test><status status="PASS"/></suite></robot>`;
        expect(parseOutputXml(xml)).toEqual({ passed: true, failReason: null });
    });

    it("collects failure messages", () => {
        const xml = `<robot><suite name="S"><test name="T"><status status="FAIL">boom</status></test><status status="FAIL"/></suite></robot>`;
        const result = parseOutputXml(xml);
        expect(result.passed).toBe(false);
        expect(result.failReason).toContain("T: boom");
    });
});
