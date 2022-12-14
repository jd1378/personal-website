/**
 * This file fetches all commits made by the github token's authenticated user,
 * from all owned repos (excluding forks and privates) and on projects that
 * user has contributed to as pull requests and commits, and
 * saves them into json files that can be tracked by git and has the ability to only fetch the new commits
 * by running weekly/daily etc
 */

import { cursordb, getRepoCommitDB, repodb } from "./db.ts";
// we use skypack, because some how requires less permission than npm. weird. but npm provides better types.
import { Octokit } from "https://cdn.skypack.dev/octokit@^2.0.10?dts";
import type { Octokit as OctoType } from "npm:octokit@^2.0.10";

const token = "PLACE_GH_PAT_HERE";
const octokit: OctoType = new Octokit({
  userAgent: "jd1378/personal-data-fetch",
  auth: token,
});

const {
  data: { node_id: userId },
} = await octokit.rest.users.getAuthenticated();

/**
 * fetch contributions and add repos to db
 */
async function fetchContributions() {
  let lastEndCursor = await cursordb
    .findOne({ name: "contributions" })
    .then((found) => {
      if (!found) {
        return cursordb
          .insertOne({
            endCursor: "",
            name: "contributions",
          })
          .then(() => "");
      }

      return found.endCursor;
    });

  let hasNextPage = true;

  while (hasNextPage) {
    const contributions: any = await octokit.graphql(`
    {
      viewer {
        repositoriesContributedTo(
          first: 100
          ${lastEndCursor ? `after: "${lastEndCursor}"` : ""}
          contributionTypes: [COMMIT, PULL_REQUEST]
          includeUserRepositories: false
        ) {
          totalCount
          nodes {
            nameWithOwner
            createdAt
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }`);

    if (contributions?.viewer?.repositoriesContributedTo?.nodes) {
      repodb.insertMany(
        contributions.viewer.repositoriesContributedTo.nodes as Array<{
          nameWithOwner: string;
          createdAt: string;
        }>
      );
    }

    if (contributions?.viewer?.repositoriesContributedTo?.pageInfo?.endCursor) {
      lastEndCursor = contributions.viewer.repositoriesContributedTo.pageInfo
        .endCursor as string;
      await cursordb.updateOne(
        {
          name: "contributions",
        },
        {
          endCursor: lastEndCursor,
        }
      );
    }
    hasNextPage =
      contributions?.viewer?.repositoriesContributedTo?.pageInfo?.hasNextPage;
  }
}

/**
 * fetch owned repos (excluding forks and privates) and add them if not already in db
 */
async function fetchOwnedRepos() {
  {
    let lastEndCursor = await cursordb
      .findOne({ name: "ownedRepos" })
      .then((found) => {
        if (!found) {
          return cursordb
            .insertOne({
              endCursor: "",
              name: "ownedRepos",
            })
            .then(() => "");
        }

        return found.endCursor;
      });

    let hasNextPage = true;

    while (hasNextPage) {
      const ownedRepos: any = await octokit.graphql(`
      {
        viewer {
          repositories(
            first: 100
            isFork: false
            privacy: PUBLIC
            ${lastEndCursor ? `after: "${lastEndCursor}"` : ""}
          ) {
            nodes {
              nameWithOwner
              createdAt
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }`);

      if (ownedRepos?.viewer?.repositories?.nodes) {
        for (const { nameWithOwner, createdAt } of ownedRepos.viewer
          .repositories.nodes as Array<{
          nameWithOwner: string;
          createdAt: string;
        }>) {
          if (!(await repodb.findOne({ nameWithOwner }))) {
            await repodb.insertOne({
              nameWithOwner,
              createdAt,
            });
          }
        }
      }

      if (ownedRepos?.viewer?.repositories?.pageInfo?.endCursor) {
        lastEndCursor = ownedRepos.viewer.repositories.pageInfo
          .endCursor as string;
        await cursordb.updateOne(
          {
            name: "ownedRepos",
          },
          {
            endCursor: lastEndCursor,
          }
        );
      }
      hasNextPage = ownedRepos?.viewer?.repositories?.pageInfo?.hasNextPage;
    }
  }
}

/**
 * fetch contributed commits
 *
 * has 2 modes:
 *  1. fetch from latest to the oldest
 *  2. fetch the latest to the newest commit we have
 *
 * after the first mode is run and finished successfully, it only runs the second mode till an old commit is found in db
 */
async function fetchCommits() {
  // loop through our repos and get all commits made by user
  const repos = await repodb.findMany();

  for (const { nameWithOwner } of repos) {
    const repoOwner = nameWithOwner.substring(0, nameWithOwner.indexOf("/"));
    const repoName = nameWithOwner.substring(nameWithOwner.indexOf("/") + 1);

    let lastEndCursor = await cursordb
      .findOne({ name: nameWithOwner })
      .then((found) => {
        if (!found) {
          return cursordb
            .insertOne({
              endCursor: "",
              name: nameWithOwner,
            })
            .then(() => "");
        }

        return found.endCursor;
      });

    const isFinishedFetchingAllOnce = lastEndCursor === "finished";

    if (isFinishedFetchingAllOnce) {
      lastEndCursor = "";
    }

    let hasNextPage = true;

    try {
      while (hasNextPage) {
        const repoCommits: any = await octokit.graphql(
          `
        {
          repository(name: "${repoName}", owner: "${repoOwner}") {
            defaultBranchRef {
              target {
                ... on Commit {
                  history(
                    first: 100
                    author: {id: "${userId}"}
                    ${lastEndCursor ? `after: "${lastEndCursor}"` : ""}
                  ) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    edges {
                      node {
                        ... on Commit {
                          committedDate
                          deletions
                          additions
                          oid
                          messageHeadline
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`
        );

        {
          const commitNodes =
            repoCommits?.repository?.defaultBranchRef?.target?.history?.edges;
          if (commitNodes && commitNodes.length) {
            const repoCommitDB = getRepoCommitDB(nameWithOwner);

            for (const {
              node: {
                committedDate,
                deletions,
                additions,
                oid,
                messageHeadline,
              },
            } of commitNodes as Array<{
              node: {
                committedDate: string;
                deletions: number;
                additions: number;
                oid: string;
                messageHeadline: string;
              };
            }>) {
              if (await repoCommitDB.findOne({ id: oid })) {
                // we have the rest, do not continue
                break;
              } else {
                await repoCommitDB.insertOne({
                  c: new Date(committedDate).valueOf(),
                  a: additions,
                  d: deletions,
                  id: oid,
                  mh: messageHeadline,
                });
              }
            }
          }
        }

        const requestPageInfo =
          repoCommits?.repository?.defaultBranchRef?.target?.history
            ?.pageInfo || {};
        hasNextPage = requestPageInfo.hasNextPage;

        if (!hasNextPage && !isFinishedFetchingAllOnce) {
          await cursordb.updateOne(
            {
              name: nameWithOwner,
            },
            {
              endCursor: "finished",
            }
          );
        } else if (requestPageInfo.endCursor) {
          lastEndCursor = requestPageInfo.endCursor as string;

          if (!isFinishedFetchingAllOnce) {
            await cursordb.updateOne(
              {
                name: nameWithOwner,
              },
              {
                endCursor: lastEndCursor,
              }
            );
          }
        }
      }
    } catch (e) {
      if (e?.errors?.at(0)?.type === "NOT_FOUND") {
        await repodb.deleteOne({
          nameWithOwner,
        });
        continue;
      }
    }
  }
}

// await fetchContributions();
// await fetchOwnedRepos();
await fetchCommits();

Deno.exit();
