// 会话工作区/附件 UI 纯逻辑（票 M7-A-T4 / Issue #61）node:test：
// 三种来源的草稿 → 请求体、URL/分支校验、clone 确认文案、摘要标签、附件 chip 增删。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addAttachmentPaths,
  attachmentLabel,
  cloneConfirmMessage,
  defaultBranchFor,
  draftToWorkspaceBody,
  emptyWorkspaceDraft,
  needsCloneConfirm,
  removeAttachmentPath,
  validateBranchName,
  validateGithubUrl,
  validateLocalPath,
  workspaceDetail,
  workspaceLabel,
} from "./workspace-ui.ts";

test("三种来源的草稿转换成正确的 workspace body", () => {
  assert.deepEqual(draftToWorkspaceBody({ ...emptyWorkspaceDraft(), source: "none" }), {
    ok: true,
    body: { kind: "none" },
  });
  assert.deepEqual(draftToWorkspaceBody({ ...emptyWorkspaceDraft(), source: "local", localPath: "  /tmp/proj  " }), {
    ok: true,
    body: { kind: "local", path: "/tmp/proj" },
  });
  assert.deepEqual(
    draftToWorkspaceBody({
      ...emptyWorkspaceDraft(),
      source: "github",
      repoUrl: "https://github.com/acme/widget.git",
      baseBranch: "develop",
      newBranch: "feature/x",
    }),
    {
      ok: true,
      body: {
        kind: "github",
        url: "https://github.com/acme/widget.git",
        base_branch: "develop",
        new_branch: "feature/x",
      },
    },
  );
  // 分支留空 = 服务端默认（不发送空字段）
  const blank = draftToWorkspaceBody({
    ...emptyWorkspaceDraft(),
    source: "github",
    repoUrl: "git@github.com:acme/widget.git",
  });
  assert.deepEqual(blank, { ok: true, body: { kind: "github", url: "git@github.com:acme/widget.git" } });
});

test("本地路径/URL/分支校验：空、缺 owner/repo、非法分支名均给可读错误", () => {
  assert.equal(validateLocalPath("  ").ok, false);
  assert.equal(validateLocalPath("/Users/me/proj").ok, true);

  assert.equal(validateGithubUrl("").ok, false);
  assert.equal(validateGithubUrl("https://github.com/onlyowner").ok, false);
  assert.equal(validateGithubUrl("https://github.com/acme/widget").ok, true);
  assert.equal(validateGithubUrl("git@github.com:acme/widget.git").ok, true);
  assert.equal(validateGithubUrl("ftp://github.com/acme/widget").ok, false);
  assert.equal(validateGithubUrl("not a url").ok, false);

  assert.deepEqual(validateBranchName("morrow/01936b"), { ok: true, name: "morrow/01936b" });
  for (const bad of ["", "-x", "a..b", "a b", "a:b", "bad.lock", "/x", "x/"]) {
    assert.equal(validateBranchName(bad).ok, false, `${bad} 应被拒绝`);
  }
  assert.equal(defaultBranchFor("01936b9d-aaaa"), "morrow/01936b");
});

test("GitHub 来源需要 clone 前确认，文案说明网络动作与本地已有副本关联", () => {
  assert.equal(needsCloneConfirm("github"), true);
  assert.equal(needsCloneConfirm("local"), false);
  assert.equal(needsCloneConfirm("none"), false);
  const message = cloneConfirmMessage("https://github.com/acme/widget");
  assert.ok(message.includes("~/.morrow/workspaces/"));
  assert.ok(message.includes("clone"));
  assert.ok(message.includes("已有"));
});

test("会话摘要标签：本地/GitHub 均含分支，详情含完整路径与基线", () => {
  assert.equal(workspaceLabel(undefined), "");
  const local = workspaceLabel({
    kind: "local",
    path: "/Users/me/projects/morrow",
    repo_path: "/Users/me/projects/morrow",
    branch: "main",
  });
  assert.ok(local.startsWith("本地 · main"));
  assert.ok(local.includes("projects/morrow"));

  const github = workspaceLabel({
    kind: "github",
    path: "/Users/me/.morrow/worktrees/sessions/s1",
    repo_path: "/Users/me/.morrow/workspaces/widget-abc123",
    branch: "morrow/01936b",
    url: "git@github.com:acme/widget.git",
    base_branch: "main",
  });
  assert.equal(github, "GitHub · acme/widget · morrow/01936b");
  const detail = workspaceDetail({
    kind: "github",
    path: "/Users/me/.morrow/worktrees/sessions/s1",
    repo_path: "/Users/me/.morrow/workspaces/widget-abc123",
    branch: "morrow/01936b",
    url: "git@github.com:acme/widget.git",
    base_branch: "main",
  });
  assert.ok(detail.includes("worktrees/sessions/s1"));
  assert.ok(detail.includes("分支：morrow/01936b"));
  assert.ok(detail.includes("基线：main"));
  assert.ok(detail.includes("来源：git@github.com:acme/widget.git"));
});

test("附件 chip：增删去重、标签取文件名", () => {
  let paths = addAttachmentPaths([], "/tmp/a.txt\n/tmp/b.txt;/tmp/a.txt");
  assert.deepEqual(paths, ["/tmp/a.txt", "/tmp/b.txt"]);
  paths = addAttachmentPaths(paths, " /tmp/c.txt ");
  assert.deepEqual(paths, ["/tmp/a.txt", "/tmp/b.txt", "/tmp/c.txt"]);
  assert.deepEqual(removeAttachmentPath(paths, "/tmp/b.txt"), ["/tmp/a.txt", "/tmp/c.txt"]);
  assert.equal(attachmentLabel({ path: "/tmp/dir/note.md", name: "note.md", size: 3 }), "note.md");
  assert.equal(attachmentLabel({ path: "/tmp/dir/note.md", name: "", size: 3 }), "…/dir/note.md");
});
