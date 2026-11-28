/** Custom scheme the window is loaded from; the renderer never talks to the server directly. */
export const APP_SCHEME = "astrolabe";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/index.html`;

/**
 * CSP for every page and file the app serves. Scripts and styles only from the
 * app itself; `connect-src 'self'` means the only reachable backend is the
 * /api proxy of the app protocol, never a foreign host or the MCP endpoint.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

/** True when `url` belongs to the app window's own origin. */
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

/** IPC calls are accepted only from a frame that was loaded from the app origin. */
export function isTrustedSender(frameUrl: string | undefined): boolean {
  return frameUrl !== undefined && isAppUrl(frameUrl);
}

/** Only these schemes may leave the app through `shell.openExternal`. */
export function isAllowedExternalUrl(url: string, allowedSchemes: readonly string[]): boolean {
  try {
    return allowedSchemes.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Longest citation link the shell opens; the guide contract caps links at the same length. */
const MAX_CITATION_URL_LENGTH = 2048;
/** Whitespace, control characters and backslashes are read differently by parsers and the OS. */
function hasUnsafeCharacters(url: string): boolean {
  return [...url].some((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code <= 0x20 || (code >= 0x7f && code <= 0x9f) || c === "\\";
  });
}

function isIpOrLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^[0-9.]+$/.test(hostname) ||
    hostname.includes(":")
  );
}

/**
 * Links in guide text (research citations, ADR-0006) open in the player's own browser. Returns the
 * normalized address to open, or null when the link may not leave the app: https only, no
 * credentials, no port, no IP address or localhost, and a host (or a subdomain of one) from the
 * configured list. The parsed form is opened, never the raw string, so the OS sees what was checked.
 */
export function citationUrlToOpen(url: string, allowedHosts: readonly string[]): string | null {
  if (url.length > MAX_CITATION_URL_LENGTH || hasUnsafeCharacters(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    host === "" ||
    isIpOrLocalHost(host)
  ) {
    return null;
  }
  const listed = allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  return listed ? parsed.href : null;
}

/** Host of the GitHub API the data release check talks to (see @astrolabe/release-sync). */
export const GITHUB_API_HOST = "api.github.com";

/**
 * Requests the main process makes for game data updates: https only, to the GitHub API and the
 * hosts the configuration allows for downloads. Everything else stays blocked by the session filter.
 */
export function isDataSyncUrl(url: string, allowedHosts: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.port === "" &&
      parsed.username === "" &&
      (parsed.hostname === GITHUB_API_HOST || allowedHosts.includes(parsed.hostname))
    );
  } catch {
    return false;
  }
}
