import { describe, expect, it } from "vitest";
import {
  CONTENT_SECURITY_POLICY,
  isAllowedExternalUrl,
  citationUrlToOpen,
  isAppUrl,
  isTrustedSender,
} from "../src/main/security.js";

describe("security helpers", () => {
  it("recognises only the app origin", () => {
    expect(isAppUrl("astrolabe://app/index.html")).toBe(true);
    expect(isAppUrl("astrolabe://other/index.html")).toBe(false);
    expect(isAppUrl("https://astrolabe.app/")).toBe(false);
    expect(isAppUrl("file:///C:/x.html")).toBe(false);
    expect(isAppUrl("not a url")).toBe(false);
  });

  it("trusts IPC only from app frames", () => {
    expect(isTrustedSender("astrolabe://app/index.html#/plan")).toBe(true);
    expect(isTrustedSender("https://evil.example/")).toBe(false);
    expect(isTrustedSender(undefined)).toBe(false);
  });

  it("limits external links to the configured schemes", () => {
    expect(isAllowedExternalUrl("claude://", ["claude:"])).toBe(true);
    expect(isAllowedExternalUrl("https://example.com", ["claude:"])).toBe(false);
    expect(isAllowedExternalUrl("file:///C:/Windows/calc.exe", ["claude:"])).toBe(false);
    expect(isAllowedExternalUrl("%%%", ["claude:"])).toBe(false);
  });

  it("CSP allows no remote hosts and no inline scripts", () => {
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:/);
    expect(CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
  });
});

import { isDataSyncUrl } from "../src/main/security.js";

describe("data sync requests", () => {
  const hosts = ["github.com", "release-assets.githubusercontent.com"];
  it("allows the GitHub API and the configured download hosts over https only", () => {
    expect(isDataSyncUrl("https://api.github.com/repos/o/r/releases", hosts)).toBe(true);
    expect(isDataSyncUrl("https://github.com/o/r/releases/download/t/f", hosts)).toBe(true);
    expect(isDataSyncUrl("http://github.com/o/r", hosts)).toBe(false);
    expect(isDataSyncUrl("https://evil.example/x", hosts)).toBe(false);
    expect(isDataSyncUrl("https://github.com:8443/x", hosts)).toBe(false);
    expect(isDataSyncUrl("https://u:p@github.com/x", hosts)).toBe(false);
    expect(isDataSyncUrl("not a url", hosts)).toBe(false);
  });
});

describe("citation links", () => {
  const hosts = ["maxroll.gg", "pathofexile.com"];
  it("opens the normalized https link of a listed host and nothing else", () => {
    expect(citationUrlToOpen("https://maxroll.gg/poe2/guide", hosts)).toBe(
      "https://maxroll.gg/poe2/guide",
    );
    expect(citationUrlToOpen("https://MAXROLL.gg", hosts)).toBe("https://maxroll.gg/");
    expect(citationUrlToOpen("https://www.pathofexile.com/forum", hosts)).toBe(
      "https://www.pathofexile.com/forum",
    );
    expect(citationUrlToOpen("http://maxroll.gg/x", hosts)).toBeNull();
    expect(citationUrlToOpen("https://other.example/x", hosts)).toBeNull();
    expect(citationUrlToOpen("https://notmaxroll.gg/x", hosts)).toBeNull();
    expect(citationUrlToOpen("https://maxroll.gg.evil.example/x", hosts)).toBeNull();
    expect(citationUrlToOpen("javascript:alert(1)", hosts)).toBeNull();
    expect(citationUrlToOpen("file:///etc/passwd", hosts)).toBeNull();
    expect(citationUrlToOpen("not a url", hosts)).toBeNull();
  });

  it("rejects credentials, ports, IP addresses and localhost", () => {
    expect(citationUrlToOpen("https://user:pw@maxroll.gg/", hosts)).toBeNull();
    expect(citationUrlToOpen("https://maxroll.gg:8443/", hosts)).toBeNull();
    expect(citationUrlToOpen("https://127.0.0.1/", ["127.0.0.1"])).toBeNull();
    expect(citationUrlToOpen("https://[::1]/", ["::1"])).toBeNull();
    expect(citationUrlToOpen("https://localhost/", ["localhost"])).toBeNull();
  });

  it("rejects spellings that parsers and the OS may read differently", () => {
    expect(citationUrlToOpen("https://maxroll.gg\\@evil.example/", hosts)).toBeNull();
    expect(citationUrlToOpen("https://maxroll.gg/\tx", hosts)).toBeNull();
    expect(citationUrlToOpen("https://maxroll.gg/a\nb", hosts)).toBeNull();
    expect(citationUrlToOpen(" https://maxroll.gg/", hosts)).toBeNull();
    expect(citationUrlToOpen(`https://maxroll.gg/${"a".repeat(2100)}`, hosts)).toBeNull();
  });
});
