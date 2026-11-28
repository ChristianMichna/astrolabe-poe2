import type { ReactNode } from "react";
import { Badge, Sigil } from "@astrolabe/ui";
import type { RouteId } from "./route";
import { NAV } from "./route";
import { getDesktopBridge } from "../desktop/bridge";
import { useDesktopStatus } from "../desktop/useDesktopStatus";

export function AppShell({ route, children }: { route: RouteId; children: ReactNode }) {
  const inDesktop = getDesktopBridge() !== undefined;
  const entries = NAV.filter((entry) => inDesktop || entry.desktopOnly !== true);
  return (
    <div className="shell">
      <svg className="engraving" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle cx="50" cy="50" r="49" />
        <circle cx="50" cy="50" r="38" />
        <circle className="engraving__ticks" cx="50" cy="50" r="44" />
        <path d="M50 1 V99 M1 50 H99" />
      </svg>
      <header className="topbar">
        <a className="brand" href="#/" aria-label="Astrolabe, go to build overview">
          <Sigil size={36} />
          <span className="brand__name">
            Astro<span className="brand__accent">labe</span>
          </span>
        </a>
        <nav className="nav" aria-label="Main navigation">
          <ul className="nav__list">
            {entries.map((entry) => {
              const current = entry.id === route;
              return (
                <li key={entry.id}>
                  {entry.href ? (
                    <a
                      className="nav__link"
                      href={entry.href}
                      aria-current={current ? "page" : undefined}
                    >
                      {entry.label}
                    </a>
                  ) : (
                    <span className="nav__link nav__link--upcoming" aria-disabled="true">
                      {entry.label}
                      <span className="nav__soon">soon</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="topbar__status">
          <StatusBadges />
        </div>
      </header>
      <main className="content">{children}</main>
      <footer className="footer">
        Fan project. Not affiliated with or endorsed by Grinding Gear Games. Path of Exile is a
        trademark of Grinding Gear Games.
      </footer>
    </div>
  );
}

/** Honest connection state: sample data in a browser, real server state in the desktop app. */
function StatusBadges() {
  const desktop = useDesktopStatus();
  if (desktop.kind === "loading") return <Badge tone="neutral">Starting</Badge>;
  if (desktop.kind === "browser") {
    return (
      <>
        <Badge tone="accent">Sample data</Badge>
        <Badge tone="warning">PoB offline</Badge>
      </>
    );
  }
  if (desktop.kind === "unreachable") return <Badge tone="danger">App status unavailable</Badge>;
  const { server, update, data } = desktop.status;
  return (
    <>
      <Badge tone="accent">Sample data</Badge>
      {server.state === "failed" ? <Badge tone="danger">Server error</Badge> : null}
      {server.state === "starting" ? <Badge tone="neutral">Server starting</Badge> : null}
      {server.state === "ready" ? (
        <span title={server.catalogOnlyReason}>
          <Badge tone={server.calcEngine === "pob" ? "success" : "warning"}>
            {server.calcEngine === "pob"
              ? "PoB ready"
              : server.calcEngine === "none"
                ? "Catalog only"
                : "PoB offline"}
          </Badge>
        </span>
      ) : null}
      {update.state === "ready" ? <UpdateButton version={update.version} /> : null}
      {data.state === "downloading" ? (
        <Badge tone="info">Loading game data {data.releaseId}</Badge>
      ) : null}
      {data.state === "ready" ? <DataButton releaseId={data.releaseId} /> : null}
      {data.state === "failed" ? (
        <span title={data.message}>
          <Badge tone="warning">Game data check failed</Badge>
        </span>
      ) : null}
    </>
  );
}

function UpdateButton({ version }: { version: string }) {
  return (
    <Badge tone="info">
      <button
        type="button"
        className="update-link"
        onClick={() => void getDesktopBridge()?.installUpdate()}
      >
        Update {version}: restart
      </button>
    </Badge>
  );
}

function DataButton({ releaseId }: { releaseId: string }) {
  return (
    <Badge tone="info">
      <button
        type="button"
        className="update-link"
        onClick={() => void getDesktopBridge()?.restartForData()}
      >
        New game data {releaseId}: restart
      </button>
    </Badge>
  );
}
