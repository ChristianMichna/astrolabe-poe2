import { useEffect, useMemo, useState } from "react";

/*
 * The index of the guide page: a rail that stays in view, lists the sections and marks the one the
 * reader is in. Sections are plain elements with an id; nothing here knows the guide's content.
 */

export interface NavSection {
  readonly id: string;
  readonly label: string;
}

export function GuideNav({ sections: given }: { sections: readonly NavSection[] }) {
  // Callers build the list on every render; the observer only needs to change when the ids do.
  const key = given.map((s) => `${s.id}:${s.label}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the content of `given`
  const sections = useMemo(() => given, [key]);
  const [active, setActive] = useState(sections[0]?.id ?? "");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        // The first section on screen, in the order of the guide, is the one being read.
        const current = sections.find((s) => visible.has(s.id));
        if (current !== undefined) setActive(current.id);
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el !== null) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections]);
  return (
    <nav className="guide-nav" aria-label="Guide sections">
      <ol>
        {sections.map((s, i) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className={
                s.id === active ? "guide-nav__link guide-nav__link--active" : "guide-nav__link"
              }
              aria-current={s.id === active ? "location" : undefined}
              onClick={(e) => {
                // The page itself routes by hash, so a section link scrolls instead of navigating.
                e.preventDefault();
                const el = document.getElementById(s.id);
                const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                el?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
                el?.focus({ preventScroll: true });
                setActive(s.id);
              }}
            >
              <span className="guide-nav__index">{String(i + 1).padStart(2, "0")}</span>
              {s.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
