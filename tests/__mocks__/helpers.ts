import { db } from "./db";
import { STRINGS } from "./strings";
import usersGet from "./users-get.json";
import threshold95_1 from "../__sample__/match_threshold_95_1.json";
import threshold95_2 from "../__sample__/match_threshold_95_2.json";
import warning75_1 from "../__sample__/warning_threshold_75_1.json";
import warning75_2 from "../__sample__/warning_threshold_75_2.json";
import taskComplete from "../__sample__/task_complete.json";
import markdownLink1 from "../__sample__/markdown_link_1.json";
import annotateIssue from "../__sample__/issue_annotate.json";

interface SampleIssue {
  title: string;
  issue_body: string;
}

/**
 * Helper function to setup tests.
 *
 * This function populates the mock database with the external API
 * data you'd expect to find in a real-world scenario.
 *
 * Here is where you create issues, commits, pull requests, etc.
 */
export async function setupTests() {
  // Insert users
  for (const item of usersGet) {
    db.users.create({
      login: item.login,
      id: item.id,
    });
  }

  // Insert repository
  db.repo.create({
    id: 1,
    name: STRINGS.TEST_REPO,
    full_name: `${STRINGS.USER_1}/${STRINGS.TEST_REPO}`,
    private: false,
    owner: {
      login: STRINGS.USER_1,
      id: 1,
      avatar_url: "",
    },
  });

  // Insert issues
  db.issue.create({
    node_id: "1", //Node ID
    number: 1,
    title: "First Issue",
    body: "This is the body of the first issue.",
    user: {
      login: STRINGS.USER_1,
      id: 1,
    },
    owner: STRINGS.USER_1,
    repo: STRINGS.TEST_REPO,
    author_association: "OWNER",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    comments: 0,
    labels: [],
    state: "open",
    locked: false,
    reactions: {
      url: "",
      total_count: 0,
      "+1": 0,
      "-1": 0,
      laugh: 0,
      hooray: 0,
      confused: 0,
      heart: 0,
      rocket: 0,
      eyes: 0,
    },
    timeline_url: "",
  });

  db.issue.create({
    node_id: "2", //Node ID
    number: 2,
    title: "Second Issue",
    body: "This is the body of the second issue.",
    user: {
      login: STRINGS.USER_1,
      id: 1,
    },
    owner: STRINGS.USER_1,
    repo: STRINGS.TEST_REPO,
    author_association: "OWNER",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    comments: 0,
    labels: [],
    state: "open",
    locked: false,
    reactions: {
      url: "",
      total_count: 0,
      "+1": 0,
      "-1": 0,
      laugh: 0,
      hooray: 0,
      confused: 0,
      heart: 0,
      rocket: 0,
      eyes: 0,
    },
    timeline_url: "",
  });
}

export function createIssue(
  issueBody: string,
  issueNodeId: string,
  issueTitle: string,
  issueNumber: number,
  issueUser: {
    login: string;
    id: number;
  },
  issueState: string,
  issueCloseReason: string | null,
  repo: string,
  owner: string
) {
  const existingIssue = db.issue.findFirst({
    where: {
      node_id: {
        equals: issueNodeId,
      },
    },
  });
  if (existingIssue) {
    db.issue.update({
      where: {
        node_id: {
          equals: issueNodeId,
        },
      },
      data: {
        body: issueBody,
        title: issueTitle,
        user: issueUser,
        updated_at: new Date().toISOString(),
        owner: owner,
        repo: repo,
        state: issueState,
        state_reason: issueCloseReason,
      },
    });
  } else {
    db.issue.create({
      node_id: issueNodeId,
      body: issueBody,
      title: issueTitle,
      user: issueUser,
      number: issueNumber,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      author_association: "OWNER",
      state: issueState,
      state_reason: issueCloseReason,
      owner: owner,
      repo: repo,
      reactions: {
        url: "",
        total_count: 0,
        "+1": 0,
        "-1": 0,
        laugh: 0,
        hooray: 0,
        confused: 0,
        heart: 0,
        rocket: 0,
        eyes: 0,
      },
      timeline_url: "",
      comments: 0,
      labels: [],
      locked: false,
    });
  }
}

export function createComment(comment: string, commentId: number, nodeId: string, issueNumber?: number) {
  const existingComment = db.issueComments.findFirst({
    where: {
      id: {
        equals: commentId,
      },
    },
  });

  // Find the issue by nodeId to get its number
  const issue = db.issue.findFirst({
    where: {
      node_id: {
        equals: nodeId,
      },
    },
  });

  const targetIssueNumber = issueNumber || (issue ? issue.number : 1);

  if (existingComment) {
    db.issueComments.update({
      where: {
        id: {
          equals: commentId,
        },
      },
      data: {
        body: comment,
        updated_at: new Date().toISOString(),
        issue_number: targetIssueNumber,
      },
    });
  } else {
    db.issueComments.create({
      id: commentId,
      body: comment,
      issue_number: targetIssueNumber,
      node_id: nodeId,
      user: {
        login: STRINGS.USER_1,
        id: 1,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      author_association: "OWNER",
    });
  }
}

export function fetchSimilarIssues(type?: string): SampleIssue[] {
  switch (type) {
    case "warning_threshold_75":
      return [warning75_1, warning75_2];
    case "match_threshold_95":
      return [threshold95_1, threshold95_2];
    case "task_complete":
      return [taskComplete];
    case "markdown_link":
      return [markdownLink1];
    case "annotate":
      return [annotateIssue];
    default:
      return [threshold95_1, threshold95_2];
  }
}
