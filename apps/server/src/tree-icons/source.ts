import { buildIconAtlas, findTreeDataDir, type BuiltIconAtlas } from "./atlas.js";

/** Gives the node icon atlas; builds it on first use and keeps the answer (or the failure) for the run. */
export type TreeIconSource = () => Promise<BuiltIconAtlas>;

export function treeIconSource(pobRoot: string): TreeIconSource {
  let built: Promise<BuiltIconAtlas> | undefined;
  return () => {
    built ??= findTreeDataDir(pobRoot)
      .then(buildIconAtlas)
      .catch((error: unknown) => {
        built = undefined; // a later request may succeed, e.g. after the files arrive
        throw new Error("Could not build the passive tree icons.", { cause: error });
      });
    return built;
  };
}
