import { Database } from "https://deno.land/x/aloedb@0.9.0/mod.ts";

interface Repo {
  nameWithOwner: string;
  createdAt: string;
}

export const repodb = new Database<Repo>({
  path: "./repos.json",
  pretty: true,
  autoload: true,
  autosave: true,
  optimize: false,
  immutable: true,
});

export const commitdb = new Database<Commits>({});

interface Cursors {
  name: string;
  endCursor: string;
}

export const cursordb = new Database<Cursors>({
  path: "./cursors.json",
  pretty: true,
  autoload: true,
  autosave: true,
  optimize: false,
  immutable: true,
});

/** keeping names short to lower file size */
interface Commits {
  /** additions */
  a: number;
  /** deletions */
  d: number;
  /** commit message headline */
  mh: string;
  /** commit sha */
  id: string;
  /** committed date*/
  c: number;
}

export function getRepoCommitDB(repo: string) {
  const db = new Database<Commits>({
    path: `./repo_commits/${repo.replace("/", "_")}.json`,
    pretty: true,
    autoload: true,
    autosave: true,
    optimize: false,
    immutable: true,
  });

  return db;
}
